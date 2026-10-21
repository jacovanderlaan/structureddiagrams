/* ============================================================================
   browse.js — faceted browse over content_item.parquet, in the reader's browser.

   Shared by every site. Generated in by sync_tokens.py; do not edit a site copy.

   Best of both, per Jaco (31 Jul 2026):
     * from jacovanderlaan.com (its WordPress filter): a faceted sidebar
       with live COUNTS per facet, free-text search, and the hero image beside
       the item.
     * from the Beacon app: a VIEW SWITCHER — List · Cards · Grid — and the
       compact card density with type/tag chips.

   ⚠️ ADR-129 — why this is safe: every row carries `url`, never `body`. This
   filter emits LINKS to pages that already exist as static HTML. A crawler that
   runs no JavaScript still reaches every item through the sitemap and the
   static listing; this is a faster route for humans, never the only route.
   ============================================================================ */

const DUCKDB_CDN = "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.28.0/+esm";

export async function initBrowse(mount, opts = {}) {
  const dataUrl = opts.data || "../data/content_item.parquet";
  const base = opts.base || "../";
  const assets = opts.assets || "../assets/";
  // ⭐ Configurable facets (13 Oct 2026, for Deliberate Way's places and
  // sources). A page passes `facets: [{key, label}]` naming any column of the
  // parquet; without it the page keeps the original three, exactly as before.
  // A configured facet with fewer than two values in this page's scope is
  // hidden (a one-option checkbox filters nothing) unless it is checked.
  // A facet may add `tree: true` (optional `sep`, `order: "name"`) to read its
  // column as a hierarchy path; see "tree facets" below.
  const custom = Array.isArray(opts.facets) && opts.facets.length > 0;
  const FACETS = custom
    ? opts.facets.map((f) => (typeof f === "string" ? { key: f, label: titleCase(f) } : f))
    : DEFAULT_FACETS;
  const cfg = {
    facets: FACETS, custom,
    chips: opts.chips || ["type", "category"],
    meta: opts.meta || null,              // null = created + reading time
    flags: opts.flags !== false,          // false where `created` is not a publication date
    trees: {},                            // tree facets: key -> {kids, expanded}
    // what the count line calls one row: a string ("article" -> "articles") or
    // {one, many}; default item/items
    noun: typeof opts.noun === "string" ? { one: opts.noun, many: opts.noun + "s" }
      : opts.noun || { one: "item", many: "items" },
  };

  const el = typeof mount === "string" ? document.querySelector(mount) : mount;
  if (!el) return;
  el.innerHTML = `<div class="bw-loading">Loading…</div>`;

  let rows;
  try {
    rows = await loadRows(dataUrl);
  } catch (err) {
    // ⚠️ THROW, do not return. The caller does
    //     .then(() => document.body.classList.add("bw-ready"))
    // and `.bw-ready .bw-fallback{display:none}` hides the static list. Returning
    // normally resolved that promise, so a failed filter hid the very fallback
    // it was supposed to fall back to — an empty page with the data sitting in
    // the HTML. Throwing keeps the fallback visible and lets .catch() log it.
    el.innerHTML = "";
    console.warn("browse: falling back to the static list —", err);
    throw err;
  }

  // ⭐ The page type IS the filter. A Skills page shows skills — the reader
  // should never have to tick "skill" to see them, and must not be able to
  // untick it into showing concepts. Rows outside the scope are dropped before
  // anything else runs, so facets and counts only ever describe this page.
  const scope = opts.itemTypes || [];
  if (scope.length) rows = rows.filter((r) => scope.includes(r.type));

  // the page defaults, resolved once: fromHash fills from them and toHash leaves
  // out exactly these, so the default sort (newest on /articles/) never has to
  // be spelled out in the URL and A–Z can still be
  const defs = { view: (opts.defaults || {}).view || "list", sort: (opts.defaults || {}).sort || "title" };
  const state = fromHash(defs, FACETS);
  // The tree's shape comes from every row in scope, once: ticking and
  // unticking reason about the whole subtree, not only what the other facets
  // leave visible. The open branches start as the ones leading to a selection
  // from the URL; a tree with a single root opens that root.
  for (const f of FACETS) {
    if (!f.tree) continue;
    const kids = treeIndex(rows, f);
    const expanded = new Set();
    for (const k of state[f.key]) for (const a of ancestors(k, treeSep(f))) expanded.add(a);
    const roots = kids.get("") || [];
    if (roots.length === 1) expanded.add(roots[0]);
    cfg.trees[f.key] = { kids, expanded };
  }
  let lastSet = [];
  let flagsOn = true;
  el.innerHTML = shell(opts.sorts);
  const $ = (s) => el.querySelector(s);

  const wireFacets = () => {
    el.querySelectorAll("[data-facet]").forEach((cb) => {
      cb.onchange = () => {
        const set = state[cb.dataset.facet];
        cb.checked ? set.add(cb.value) : set.delete(cb.value);
        render();
      };
    });
    // tree facets: a tick covers the node's whole subtree (see treeToggle)
    el.querySelectorAll("[data-tree]").forEach((cb) => {
      if (cb.hasAttribute("data-partial")) cb.indeterminate = true;
      cb.onchange = () => {
        const f = FACETS.find((x) => x.key === cb.dataset.tree);
        treeToggle(state[f.key], cb.value, treeSep(f), cfg.trees[f.key].kids);
        render();
      };
    });
    el.querySelectorAll("[data-tree-toggle]").forEach((b) => {
      b.onclick = () => {
        const open = cfg.trees[b.dataset.treeToggle].expanded;
        open.has(b.dataset.node) ? open.delete(b.dataset.node) : open.add(b.dataset.node);
        render();
      };
    });
  };

  const render = () => {
    const out = apply(rows, state, FACETS);
    // Hand the CURRENT filtered set to the detail page, so prev/next steps
    // through what the reader was actually looking at — not a global ordering.
    // only items WITH a page go into the stepper set: prev/next navigates by
    // url, and a listing-only row would step the reader into a 404
    lastSet = out.filter((r) => r.url)
                 .map((r) => ({ slug: r.slug, title: r.title, url: r.url }));
    // Decide ONCE per render whether flags are meaningful for this set.
    flagsOn = cfg.flags && out.length > 2 &&
      out.filter((r) => freshness(r)).length <= out.length * FRESH_MAX_SHARE;
    $(".bw-facets").innerHTML = facets(rows, state, scope, cfg);
    $(".bw-results").innerHTML = results(out, state, base, assets, flagsOn, cfg);
    // ⚠️ "1 of 246 item": the noun agrees with the TOTAL, the number it stands
    // next to. Unfiltered, the "N of N" is noise and reads "246 items".
    const noun = rows.length === 1 ? cfg.noun.one : cfg.noun.many;
    $(".bw-count").textContent = out.length === rows.length
      ? `${rows.length} ${noun}` : `${out.length} of ${rows.length} ${noun}`;
    wireFacets();
    history.replaceState(null, "", listUrl());
  };


  // remember the set + the clicked position on the way out (detail.js reads it)
  el.addEventListener("click", (e) => {
    const a = e.target.closest("a[href]");
    if (!a || !lastSet.length) return;
    const slug = a.getAttribute("href").split("/").pop().replace(/\.html$/, "");
    const idx = lastSet.findIndex((x) => x.slug === slug);
    if (idx < 0) return;
    try {
      sessionStorage.setItem("bw:lastQuery", JSON.stringify(
        { slugs: lastSet, index: idx,
          // the hash carries the FILTER, so "back to list" returns the reader
          // to the set they were looking at — not to an unfiltered page
          listUrl: listUrl() }));
    } catch { /* private mode — the stepper just will not appear */ }
  });

  // The URL the current view lives at. The state goes into the hash; query
  // parameters the state was read from (?series=…, ?sort=…) are dropped, so
  // unticking a filter that came in through the query really unticks it on
  // reload. Query parameters that are not ours (utm_…) are kept.
  const listUrl = () => {
    const p = new URLSearchParams(location.search);
    for (const k of stateKeys(FACETS)) p.delete(k);
    const q = p.toString();
    return location.pathname + (q ? "?" + q : "") + toHash(state, FACETS, defs);
  };

  // a search term from the URL shows in the box it filters by
  $(".bw-search").value = state.q;
  $(".bw-search").oninput = (e) => { state.q = e.target.value.toLowerCase(); render(); };
  // Same trap as the view buttons below: the select showed its first option (A–Z) while the list was sorted by
  // the page default or #sort= (newest on jacovanderlaan /articles/, 21 Oct 2026). Show the actual sort.
  $(".bw-sort").value = state.sort;
  $(".bw-sort").onchange = (e) => { state.sort = e.target.value; render(); };
  el.querySelectorAll("[data-view]").forEach((b) => {
    // ⚠️ The shell marks List as "on" by default; a page whose default (or
    // #view=) is cards rendered cards under a highlighted List button (SBM
    // concepts, 13 Oct 2026). Mark the button that matches the actual view.
    b.classList.toggle("on", b.dataset.view === state.view);
    b.onclick = () => {
      state.view = b.dataset.view;
      el.querySelectorAll("[data-view]").forEach((x) => x.classList.toggle("on", x === b));
      render();
    };
  });
  $(".bw-clear").onclick = () => {
    state.q = ""; FACETS.forEach((f) => state[f.key].clear());
    $(".bw-search").value = ""; render();
  };

  // the "Clear filters" button inside an empty result set is re-rendered on
  // every pass, so it is wired by delegation rather than once
  el.addEventListener("click", (e) => {
    if (e.target.closest(".bw-results .bw-clear")) $(".bw-side .bw-clear").onclick();
  });

  render();
}

// The original three. Pages that pass no `facets` get exactly these.
const DEFAULT_FACETS = [
  { key: "type", label: "Type" },
  { key: "category", label: "Category" },
  { key: "topic", label: "Topic" },
];
// hash keys: "category" was always written as "cat"; keep old links working
const HASH_KEY = { category: "cat" };

const titleCase = (k) => k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, " ");

// ⭐ A facet value may be MULTI-VALUED: a place visited in 2013 and 2026, a
// source covering Asia and Africa. The parquet carries those as one string
// joined with "|" (or a real list); every facet, count and chip splits it.
// No existing value contains "|", so single-valued columns are unaffected.
function vals(r, key) {
  const v = r[key];
  if (Array.isArray(v)) return v.length ? v.map(String) : ["—"];
  if (v === null || v === undefined || v === "") return ["—"];
  const s = String(v);
  return s.includes("|") ? s.split("|").map((x) => x.trim()).filter(Boolean) : [s];
}

/* ---- tree facets ----------------------------------------------------------
   ⭐ 14 Oct 2026, for Deliberate Way's "Where" (continent → country → region
   → place), but nothing here knows about places. A facet declared as
     {key: "place_path", label: "Where", tree: true}
   reads its column as a PATH: "Europe > Cyprus > Paphos" (levels joined with
   " > ", or the facet's own `sep`), several paths joined with "|" like any
   multi-valued facet. It renders as a nested checklist with counts that roll
   up, and ticking a node selects its whole subtree.

   A node is identified by its path from the root ("Europe > Cyprus"), so the
   selection in the URL hash is a plain list of node keys and stays readable.
   The selection holds the HIGHEST ticked nodes only: a ticked parent implies
   its children, which are never stored beside it.

   A facet without `tree` never reaches this code, so pages that declare no
   tree facet render exactly as before. */

const TREE_SEP = " > ";
const treeSep = (f) => f.sep || TREE_SEP;

// every proper ancestor key of a node key, root first
function ancestors(k, sep) {
  const parts = k.split(sep);
  const out = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join(sep));
  return out;
}

// every node key a row sits under: "Europe", "Europe > Cyprus", … — cached per
// row, because the facet counts probe each row once per facet per render
const NODE_CACHE = new WeakMap();
function nodeKeys(r, f) {
  let byKey = NODE_CACHE.get(r);
  if (!byKey) NODE_CACHE.set(r, (byKey = {}));
  if (byKey[f.key]) return byKey[f.key];
  const sep = treeSep(f), out = new Set();
  for (const v of vals(r, f.key)) {
    if (v === "—") continue;
    const p = v.split(sep).map((x) => x.trim()).filter(Boolean);
    for (let i = 1; i <= p.length; i++) out.add(p.slice(0, i).join(sep));
  }
  // a row with no path sits under "—", listed last like any missing value
  if (!out.size) out.add("—");
  return (byKey[f.key] = out);
}

// parent key ("" = the root) -> child keys, over every row in scope
function treeIndex(rows, f) {
  const sep = treeSep(f), kids = new Map();
  for (const r of rows) {
    for (const k of nodeKeys(r, f)) {
      const anc = ancestors(k, sep);
      const parent = anc.length ? anc[anc.length - 1] : "";
      if (!kids.has(parent)) kids.set(parent, []);
      if (!kids.get(parent).includes(k)) kids.get(parent).push(k);
    }
  }
  return kids;
}

// Tick or untick one node, keeping the selection to its highest nodes.
function treeToggle(sel, k, sep, kids) {
  const anc = ancestors(k, sep);
  const cover = anc.find((a) => sel.has(a));
  if (sel.has(k)) { sel.delete(k); return; }
  if (cover) {
    // Unticking inside a ticked subtree: the ancestor gives way to the
    // siblings along the way down, so everything else stays selected.
    sel.delete(cover);
    let cur = cover;
    for (const step of [...anc.slice(anc.indexOf(cover) + 1), k]) {
      for (const c of kids.get(cur) || []) if (c !== step) sel.add(c);
      cur = step;
    }
    return;
  }
  // Ticking: the node now implies its descendants, so drop them…
  for (const x of [...sel]) if (x.startsWith(k + sep)) sel.delete(x);
  sel.add(k);
  // …and when that completes a whole family, tick the parent instead.
  for (let i = anc.length - 1; i >= 0; i--) {
    const sibs = kids.get(anc[i]) || [];
    if (!sibs.length || !sibs.every((c) => sel.has(c))) break;
    sibs.forEach((c) => sel.delete(c));
    sel.add(anc[i]);
  }
}

function treeGroup(rows, s, f, cfg) {
  const key = f.key, sep = treeSep(f), sel = s[key];
  const tree = cfg.trees[key];
  if (!tree) return "";
  // a tree with fewer than two nodes in this page's scope filters nothing
  if (!sel.size) {
    let n = 0;
    for (const ks of tree.kids.values()) n += ks.length;
    if (n < 2) return "";
  }
  // counts against everything EXCEPT this facet, rolled up: a row counts once
  // for every node on its path(s), so a parent reads the size of its subtree
  const counts = {};
  const probe = { ...s, [key]: new Set() };
  for (const r of rows) {
    if (!apply([r], probe, cfg.facets).length) continue;
    for (const k of nodeKeys(r, f)) counts[k] = (counts[k] || 0) + 1;
  }
  const isOn = (k) => sel.has(k) || ancestors(k, sep).some((a) => sel.has(a));
  const below = (k) => [...sel].some((x) => x.startsWith(k + sep));
  // a node with nothing under it right now is hidden, unless it is selected
  const shown = (k) => counts[k] || isOn(k) || below(k);
  const order = (a, b) => (a === "—") - (b === "—") ||
    (f.order === "name" ? 0 : (counts[b] || 0) - (counts[a] || 0)) || a.localeCompare(b);

  const node = (k, depth) => {
    const name = k.split(sep).pop();
    const ch = (tree.kids.get(k) || []).filter(shown).sort(order);
    const open = ch.length && tree.expanded.has(k);
    const on = isOn(k);
    const partial = !on && below(k);
    const tog = ch.length
      ? `<button type="button" class="bw-ttog" data-tree-toggle="${esc(key)}" data-node="${esc(k)}"
           aria-expanded="${open ? "true" : "false"}"
           aria-label="${open ? "Collapse" : "Expand"} ${esc(name)}">${open ? "▾" : "▸"}</button>`
      : `<span class="bw-ttog-pad"></span>`;
    return `
      <div class="bw-trow" style="--d:${depth}">${tog}
        <label class="bw-f">
          <input type="checkbox" data-tree="${esc(key)}" value="${esc(k)}"
                 ${on ? "checked" : ""} ${partial ? "data-partial" : ""} />
          <span>${esc(name)}</span><span class="bw-n">${counts[k] || 0}</span>
        </label>
      </div>` +
      (open ? `<div class="bw-tkids" role="group">${ch.map((c) => node(c, depth + 1)).join("")}</div>` : "");
  };
  const roots = (tree.kids.get("") || []).filter(shown).sort(order);
  if (!roots.length) return "";
  return `<div class="bw-fgroup bw-tree"><div class="bw-flabel">${esc(f.label)}</div>` +
    roots.map((k) => node(k, 0)).join("") + "</div>";
}

/* ---- filter state in the URL --------------------------------------------
   So a filtered view is linkable, survives a reload, and can be returned to
   from a detail page. The hash is the state; nothing is stored server-side.

   ⚠️ A link may also carry the state as a QUERY (/articles/?series=…, from a
   series page or a newsletter). fromHash reads both, the hash winning per key;
   the first render then moves it into the hash (listUrl). Reading only the
   hash left ?series= links showing every article with nothing ticked
   (21 Oct 2026). */

// every URL key the state reads: q, view, sort and each facet (both "cat" and
// "category" for the category facet, so either spelling works in a link)
function stateKeys(facetList = DEFAULT_FACETS) {
  const ks = ["q", "view", "sort"];
  for (const f of facetList) ks.push(f.key, ...(HASH_KEY[f.key] ? [HASH_KEY[f.key]] : []));
  return ks;
}

// ⚠️ Compares against the PAGE defaults, not "title"/"list". With the
// hardcoded pair, a page defaulting to newest wrote nothing for A–Z, so a
// reload or "back to list" fell back to newest (21 Oct 2026).
function toHash(s, facetList = DEFAULT_FACETS, defs = { view: "list", sort: "title" }) {
  const p = new URLSearchParams();
  if (s.q) p.set("q", s.q);
  for (const f of facetList) {
    if (s[f.key].size) p.set(HASH_KEY[f.key] || f.key, [...s[f.key]].join("|"));
  }
  if (s.view !== defs.view) p.set("view", s.view);
  if (s.sort !== defs.sort) p.set("sort", s.sort);
  const q = p.toString();
  return q ? "#" + q : "";
}

function fromHash(defaults, facetList = DEFAULT_FACETS) {
  // query first, hash on top: a key in the hash overrides the same key in the query
  const p = new URLSearchParams(location.search);
  for (const [k, v] of new URLSearchParams((location.hash || "").replace(/^#/, ""))) p.set(k, v);
  const split = (v) => new Set(v ? v.split("|").filter(Boolean) : []);
  const s = {
    q: (p.get("q") || "").toLowerCase(),
    view: p.get("view") || defaults.view || "list",
    sort: p.get("sort") || defaults.sort || "title",
  };
  // ⚠️ Every FACET key must exist here as a Set. A facet missing from the
  // state made facets() read undefined.has() and the whole render threw — the
  // chrome painted, the results never did. Built from the facet list now, so
  // a configured facet can never be forgotten here.
  for (const f of facetList) s[f.key] = split(p.get(HASH_KEY[f.key] || f.key) ?? p.get(f.key));
  return s;
}

/* ---- data ---------------------------------------------------------------- */

async function loadRows(url) {
  // ⚠️ Copied verbatim from structuredmetadata/browser.html, which has worked in
  // production since June. Correction to an earlier note here: duckdb.createWorker
  // DOES exist in the 1.28 ESM build — that was not the bug. The real failure was
  // registerFileURL below. When a working implementation already exists in the
  // repo, copy it instead of writing a second one from memory.
  const duckdb = await import(DUCKDB_CDN);
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const workerUrl = URL.createObjectURL(new Blob(
    [`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }));
  const worker = new Worker(workerUrl);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);

  const conn = await db.connect();
  // ⚠️ fetch + registerFileBuffer, NOT registerFileURL. The working
  // implementation (structuredmetadata/browser.html, in production since June)
  // fetches the bytes and hands them over; registerFileURL with the HTTP
  // protocol handler failed silently here. Copy what works.
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${resp.status} fetching ${url}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  await db.registerFileBuffer("content.parquet", buf);
  const res = await conn.query("SELECT * FROM read_parquet('content.parquet')");
  const rows = res.toArray().map((r) => JSON.parse(JSON.stringify(r)));
  await conn.close();
  return rows;
}

/* ---- filtering ----------------------------------------------------------- */

function apply(rows, s, facetList = DEFAULT_FACETS) {
  let out = rows.filter((r) => {
    for (const f of facetList) {
      const want = s[f.key];
      if (!want || !want.size) continue;
      if (f.tree) {
        // a selected node matches every row on a path through it (its subtree)
        const ks = nodeKeys(r, f);
        if (![...want].some((k) => ks.has(k))) return false;
      } else if (!vals(r, f.key).some((v) => want.has(v))) return false;
    }
    if (s.q) {
      const extra = facetList.map((f) => vals(r, f.key).join(" ")).join(" ");
      const hay = `${r.title} ${r.excerpt} ${r.category} ${r.topic} ${extra}`.toLowerCase();
      if (!hay.includes(s.q)) return false;
    }
    return true;
  });
  const by = {
    title: (a, b) => (a.title || "").localeCompare(b.title || ""),
    newest: (a, b) => String(b.created || "").localeCompare(String(a.created || "")),
    longest: (a, b) => (b.word_count || 0) - (a.word_count || 0),
  }[s.sort];
  return out.sort(by);
}

/* ---- markup -------------------------------------------------------------- */

// Sort options a page may offer; `sorts` limits and orders them. Default: all.
const SORT_LABEL = { title: "A–Z", newest: "Newest", longest: "Longest" };

function shell(sorts) {
  const sortOpts = (sorts && sorts.length ? sorts : Object.keys(SORT_LABEL))
    .filter((k) => SORT_LABEL[k])
    .map((k) => `<option value="${k}">${SORT_LABEL[k]}</option>`).join("");
  return `
  <div class="bw">
    <aside class="bw-side">
      <div class="bw-side-h">Filter <button class="bw-clear" type="button">clear</button></div>
      <input class="bw-search" type="search" placeholder="Search…" aria-label="Search" />
      <div class="bw-facets"></div>
    </aside>
    <div class="bw-main">
      <div class="bw-bar">
        <span class="bw-count"></span>
        <span class="bw-spacer"></span>
        <select class="bw-sort" aria-label="Sort">${sortOpts}</select>
        <div class="bw-views" role="group" aria-label="View">
          <button type="button" data-view="list" class="on">List</button>
          <button type="button" data-view="cards">Cards</button>
          <button type="button" data-view="grid">Grid</button>
        </div>
      </div>
      <div class="bw-results"></div>
    </div>
  </div>`;
}

function facets(rows, s, scope = [], cfg = { facets: DEFAULT_FACETS, custom: false }) {
  const group = (key, label) => {
    // a configured facet with one value across the whole page filters nothing
    if (cfg.custom && !s[key].size) {
      const distinct = new Set();
      for (const r of rows) for (const v of vals(r, key)) distinct.add(v);
      if (distinct.size < 2) return "";
    }
    const counts = {};
    for (const r of rows) {
      // count against everything EXCEPT this facet, so a count never reads zero
      // for an option you can still usefully pick (the WordPress filter does this)
      const probe = { ...s, [key]: new Set() };
      if (!apply([r], probe, cfg.facets).length) continue;
      for (const v of vals(r, key)) counts[v] = (counts[v] || 0) + 1;
    }
    // configured facets put "—" (no value) last: it is the absence of an answer
    const items = Object.entries(counts).sort((a, b) =>
      (cfg.custom ? (a[0] === "—") - (b[0] === "—") : 0) ||
      b[1] - a[1] || a[0].localeCompare(b[0]));
    if (!items.length) return "";
    return `<div class="bw-fgroup"><div class="bw-flabel">${label}</div>` +
      items.map(([v, n]) => `
        <label class="bw-f">
          <input type="checkbox" data-facet="${key}" value="${esc(v)}"
                 ${s[key].has(v) ? "checked" : ""} />
          <span>${esc(v)}</span><span class="bw-n">${n}</span>
        </label>`).join("") + "</div>";
  };
  // A Type facet listing one option is noise: the page already IS that type.
  // With a mixed scope (concepts + activities + anti-patterns) it still helps.
  return cfg.facets.map((f) =>
    f.key === "type" && scope.length === 1 ? ""
      : f.tree ? treeGroup(rows, s, f, cfg) : group(f.key, f.label)).join("");
  // group() already returns "" when a facet has no values, so an empty
  // Topic section never renders.
}

function results(out, s, base, assets, flagsOn, cfg) {
  if (!out.length) return `<p class="bw-empty">Nothing matches. <button class="bw-clear" type="button">Clear filters</button></p>`;
  return `<div class="bw-${s.view}">` + out.map((r) => item(r, s.view, base, assets, flagsOn, cfg)).join("") + "</div>";
}

// How recently something appeared or changed — "new" if it was added inside the
// window, "updated" if it was only revised. Anything older gets nothing.
//
// ⚠️ The window is deliberately WIDE (60 days). This is a sabbatical, not a
// news site: a rule written six weeks ago is still one of the newest things
// here. A 7-day window would leave every page unbadged most of the time, which
// is worse than no badge — it reads as "nothing is happening".
//
// ⚠️ And the badge must never be on everything. If a rebuild ever stamps all
// items with today's date, every row lights up and the flag stops carrying
// information. That is why this reads `created`/`updated` from the source
// frontmatter and the git add date — not the file's mtime, which a sync resets.
const FRESH_DAYS = 60;
// ⚠️ Hard ceiling. Everything on a young page is new, so the window alone
// badges every row — measured 30 of 30 the day this shipped, which is exactly
// the failure the note above describes. If more than this share would be
// flagged, the flag carries no information and none is shown.
const FRESH_MAX_SHARE = 0.4;

function freshness(r) {
  const days = (d) => {
    if (!d) return Infinity;
    const t = Date.parse(String(d).slice(0, 10));
    return isNaN(t) ? Infinity : (Date.now() - t) / 86400000;
  };
  const c = days(r.created), u = days(r.updated);
  if (c <= FRESH_DAYS) return "new";
  // Revised, but only worth flagging if the revision is meaningfully later than
  // the creation — otherwise every item is "updated" on the day it is written.
  if (u <= FRESH_DAYS && c - u > 1) return "updated";
  return "";
}

function item(r, view, base, assets, flagsOn, cfg = {}) {
  // ⚠️ A row without a url has no page of its own (ideas, skills, glossary
  // terms, decisions live only in this listing). Render it as text — linking to
  // a page that does not exist is a promise the site cannot keep, and it 404s.
  const hasPage = Boolean(r.url);
  const href = hasPage ? base + r.url : "";
  const img = r.hero_image
    ? `<img class="bw-img" src="${assets}${esc(r.hero_image)}" alt="" loading="lazy" />`
    : "";
  const chips = (cfg.chips || ["type", "category"])
    .flatMap((k) => vals(r, k)).filter((c) => c && c !== "—")
    .map((c) => `<span class="bw-chip">${esc(c)}</span>`).join("");
  const flag = flagsOn ? freshness(r) : "";
  const badge = flag ? `<span class="bw-flag bw-flag-${flag}">${flag === "new" ? "New" : "Updated"}</span>` : "";
  const meta = (cfg.meta
    ? cfg.meta.map((k) => vals(r, k).filter((v) => v !== "—").join(", "))
    : [r.created, r.word_count ? `${Math.max(1, Math.round(r.word_count / 200))} min` : ""])
    .filter(Boolean).map(esc).join(" · ");

  if (view === "grid") {
    const inner = `${img}<strong>${esc(r.title)}</strong><span class="bw-chips">${badge}${chips}</span>`;
    return hasPage ? `<a class="bw-cell" href="${href}">${inner}</a>`
                   : `<div class="bw-cell bw-nolink">${inner}</div>`;
  }
  // list and cards share the shape jacovanderlaan.com uses: image beside the text
  return `<article class="bw-item">
    <div class="bw-body">
      <h3>${hasPage ? `<a href="${href}">${esc(r.title)}</a>` : esc(r.title)}${badge}</h3>
      <div class="bw-meta">${meta}</div>
      <div class="bw-chips">${chips}</div>
      <p>${esc(r.excerpt || "")}</p>
      ${hasPage ? `<a class="bw-more" href="${href}">Read more</a>` : ""}
    </div>
    ${img}
  </article>`;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

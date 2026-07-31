#!/usr/bin/env python3
"""Render research folder-notes into research/<slug>.html + research/index.html.

Source of truth: W:/data/products/structureddiagrams/output/research/*.md
Only entries with `publish: true` are rendered. Mirrors build_concepts.py in
shape: read markdown + YAML frontmatter, emit self-contained HTML.

Usage: python build_research.py <site_dir>
"""
import os, re, sys, html

SRC = "W:/data/products/structureddiagrams/output/research"


def parse(path):
    raw = open(path, encoding="utf-8").read()
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", raw, re.S)
    fm, body = (m.group(1), m.group(2)) if m else ("", raw)

    def f(key):
        mm = re.search(rf"^{key}:\s*(.+)$", fm, re.M)
        return mm.group(1).strip().strip('"').strip("'") if mm else ""

    return {"title": f("title"), "question": f("question"), "status": f("status"),
            "confidence": f("confidence"), "created": f("created"),
            "publish": f("publish").lower() == "true", "body": body}


def md(body):
    """Small markdown -> html. Tables, headings, lists, code, links, emphasis."""
    body = re.sub(r"^#\s+.+?\n", "", body, count=1)          # drop H1, we render our own
    out, in_tbl, in_ul, in_code = [], False, False, False
    for line in body.split("\n"):
        if line.startswith("```"):
            out.append("</pre>" if in_code else "<pre>"); in_code = not in_code; continue
        if in_code:
            out.append(html.escape(line)); continue
        if re.match(r"^\|.*\|$", line):
            cells = [c.strip() for c in line.strip("|").split("|")]
            if set("".join(cells)) <= set("-: "):
                continue                                       # separator row
            tag = "th" if not in_tbl else "td"
            if not in_tbl:
                out.append('<table class="rtbl">'); in_tbl = True
            out.append("<tr>" + "".join(f"<{tag}>{inline(c)}</{tag}>" for c in cells) + "</tr>")
            continue
        if in_tbl:
            out.append("</table>"); in_tbl = False
        if re.match(r"^[-*] ", line):
            if not in_ul:
                out.append("<ul>"); in_ul = True
            out.append(f"<li>{inline(line[2:])}</li>"); continue
        if in_ul:
            out.append("</ul>"); in_ul = False
        h = re.match(r"^(#{2,4})\s+(.*)$", line)
        if h:
            lvl = len(h.group(1)) + 1
            out.append(f"<h{lvl}>{inline(h.group(2))}</h{lvl}>"); continue
        if line.startswith(">"):
            out.append(f"<blockquote>{inline(line.lstrip('> '))}</blockquote>"); continue
        if line.strip() == "---":
            out.append("<hr>"); continue
        out.append(f"<p>{inline(line)}</p>" if line.strip() else "")
    if in_tbl: out.append("</table>")
    if in_ul: out.append("</ul>")
    return "\n".join(x for x in out if x)


def inline(s):
    s = re.sub(r"\[\[concept-([a-z0-9-]+)(?:\|([^\]]+))?\]\]",
               lambda m: f'<a href="../concepts/{m.group(1)}.html">{m.group(2) or m.group(1)}</a>', s)
    s = re.sub(r"\[([^\]]+)\]\((https?://[^)]+)\)", r'<a href="\2">\1</a>', s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    return s


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>{title} — Structured Diagrams</title>
<link rel="icon" href="../assets/favicon.svg" type="image/svg+xml" />
<link rel="stylesheet" href="../assets/site.css" /></head><body>
<header class="site"><div class="wrap">
<a class="brand" href="../index.html">Structured <span class="abbr">Diagrams</span></a>
<nav class="main"><a href="index.html">All research</a><a href="../concepts/index.html">Concepts</a>
<a href="../index.html">Home</a></nav></div></header>
<div class="wrap">
<div class="eyebrow">Research</div>
<h1>{title}</h1>
<p class="sub">{question}</p>
<p class="muted">{created} · {status} · confidence: {confidence}</p>
<div class="research-body">
{body}
</div>
<p class="muted"><a href="index.html">&larr; All research</a></p>
</div>
<footer><div class="wrap"><p><span class="badge">Test phase</span> &nbsp; Structured Diagrams &mdash;
part of the <a href="https://structurebeatsmagic.com">Structure Beats Magic</a> family.</p></div></footer>
</body></html>"""

INDEX = """<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Research — Structured Diagrams</title>
<link rel="icon" href="../assets/favicon.svg" type="image/svg+xml" />
<link rel="stylesheet" href="../assets/site.css" /></head><body>
<header class="site"><div class="wrap">
<a class="brand" href="../index.html">Structured <span class="abbr">Diagrams</span></a>
<nav class="main"><a href="../concepts/index.html">Concepts</a><a href="../index.html">Home</a></nav>
</div></header>
<div class="wrap">
<div class="eyebrow">Research</div>
<h1>Research</h1>
<p class="sub">Questions investigated properly and written down — sources checked, findings dated,
open gaps stated. Each starts from a real question and ends in conclusions you can argue with.</p>
{items}
</div>
<footer><div class="wrap"><p><span class="badge">Test phase</span> &nbsp; Structured Diagrams &mdash;
part of the <a href="https://structurebeatsmagic.com">Structure Beats Magic</a> family.</p></div></footer>
</body></html>"""


def main():
    site = sys.argv[1] if len(sys.argv) > 1 else "."
    out = os.path.join(site, "research")
    os.makedirs(out, exist_ok=True)
    items, n = [], 0
    for f in sorted(os.listdir(SRC)):
        if not f.endswith(".md") or f == "README.md":
            continue
        d = parse(os.path.join(SRC, f))
        if not d["publish"] or not d["title"]:
            continue
        slug = re.sub(r"^\d{4}-\d\d-\d\d_", "", f[:-3])
        open(os.path.join(out, slug + ".html"), "w", encoding="utf-8").write(
            PAGE.format(title=html.escape(d["title"]), question=html.escape(d["question"]),
                        created=d["created"], status=d["status"],
                        confidence=d["confidence"] or "—", body=md(d["body"])))
        items.append(f'<li><a href="{slug}.html">{html.escape(d["title"])}</a> &mdash; '
                     f'{html.escape(d["question"])} <span class="muted">{d["created"]}</span></li>')
        n += 1
    open(os.path.join(out, "index.html"), "w", encoding="utf-8").write(
        INDEX.format(items='<ul class="artlist">' + "\n".join(items) + "</ul>"))
    print(f"  built {n} research pages + index in {out}")


if __name__ == "__main__":
    main()

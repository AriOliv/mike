#!/usr/bin/env python3
"""Resolves a merge conflict in app/lib/navItems.ts (+ its test) for the
integration preview: every feature branch adds its own menu line, so take the
union of NAV_MAIN / NAV_MORE items from both sides, in the order of the Legal
workstation (docs/product/05 §1), and the union of imports. The test's label
lists are regenerated from the merged file. Used by update-preview.sh.

    union-nav.py <repo root>      (reads stages :2 ours / :3 theirs from the index)
"""
import re, subprocess, sys

ROOT = sys.argv[1]
SRC = "frontend/src/app/lib/navItems.ts"
TEST = "frontend/src/app/lib/navItems.test.ts"
ORDER = ["Início", "Pedidos", "Esteira", "Contratos", "Prazos", "Radar regulatório", "Perguntar"]
ITEM = re.compile(r'^\s*\{ href: [^\n]*label: "([^"]+)"[^\n]*\},\s*$', re.M)


def stage(n, path):
    r = subprocess.run(["git", "-C", ROOT, "show", f":{n}:{path}"], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else ""


def block(text, name):
    m = re.search(rf"export const {name}: readonly NavItem\[\] = \[\n(.*?)\n\];", text, re.S)
    return m.group(1) if m else ""


def items(text, name):
    return [(m.group(1), m.group(0).rstrip()) for m in ITEM.finditer(block(text, name))]


def union(a, b, order=None, base=()):
    # three-way per item: what either side added stays, what either side
    # removed from the base goes (e.g. #9 dropping IDE from "Mais")
    base_labels = {l for l, _ in base}
    a_labels, b_labels = {l for l, _ in a}, {l for l, _ in b}
    removed = {l for l in base_labels if l not in a_labels or l not in b_labels}
    seen, out = set(), []
    for label, line in a + b:
        if label not in seen and label not in removed:
            seen.add(label); out.append((label, line))
    if order:
        rank = {l: i for i, l in enumerate(order)}
        out.sort(key=lambda x: (rank.get(x[0], len(order)), [l for l, _ in a + b].index(x[0])))
    return out


ours, theirs, common = stage(2, SRC), stage(3, SRC), stage(1, SRC)
base = ours or theirs
main = union(items(ours, "NAV_MAIN"), items(theirs, "NAV_MAIN"), ORDER, items(common, "NAV_MAIN"))
# NAV_MORE keeps first-seen order (features prepend their own extra tools)
more = union(items(ours, "NAV_MORE"), items(theirs, "NAV_MORE"), None, items(common, "NAV_MORE"))
merged = base
for name, its in (("NAV_MAIN", main), ("NAV_MORE", more)):
    merged = merged.replace(block(base, name), "\n".join(line for _, line in its), 1)
imports = []
for src in (ours, theirs):
    for line in re.findall(r"^import [^\n]+;$", src, re.M):
        if line not in imports:
            imports.append(line)
merged = re.sub(r"^import [^\n]+;\n", "", merged, flags=re.M)
if imports:
    merged = merged.replace("\nexport type NavIconKey", "\n" + "\n".join(imports) + "\n\nexport type NavIconKey", 1)
    merged = re.sub(r"\n{3,}(import )", r"\n\n\1", merged)
open(f"{ROOT}/{SRC}", "w").write(merged)

test = stage(2, TEST) or stage(3, TEST)
if test:
    def relabel(t, describe, its):
        pat = re.compile(r'(it\("' + re.escape(describe) + r'".*?toEqual\(\[\n)(.*?)(\n\s*\]\))', re.S)
        def sub(m):
            indent = re.match(r"\s*", m.group(2)).group(0) or "            "
            return m.group(1) + "\n".join(f'{indent}"{l}",' for l, _ in its) + m.group(3)
        return pat.sub(sub, t, 1)
    test = relabel(test, "lists the Legal workstation first, in Portuguese", main)
    test = relabel(test, "keeps the platform's other tools under Mais", more)
    open(f"{ROOT}/{TEST}", "w").write(test)
print("nav:", " · ".join(l for l, _ in main), "| mais:", " · ".join(l for l, _ in more))

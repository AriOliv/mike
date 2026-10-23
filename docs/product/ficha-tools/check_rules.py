"""Confere que todo caminho de campo das regras existe no schema e que ids/severidades são válidos."""
import json
import re
import sys

import yaml

schema = json.load(open(sys.argv[1]))
rules = yaml.safe_load(open(sys.argv[2]))
DEFS = schema["$defs"]


def resolve(node):
    while isinstance(node, dict) and "$ref" in node:
        node = DEFS[node["$ref"].split("/")[-1]]
    return node


def children(node):
    """Propriedades navegáveis de um nó (passa por anyOf/allOf/refs e envelope de campo)."""
    node = resolve(node)
    out = {}
    for sub in node.get("anyOf", []) + node.get("allOf", []):
        out.update(children(sub))
    out.update(node.get("properties", {}))
    if node.get("type") == "array" or "items" in node:
        out.update(children(node.get("items", {})))
    return out


def exists(path):
    node = schema
    for part in path.split("."):
        kids = children(node)
        if part not in kids:
            return False
        node = kids[part]
    return True


paths = set()


def walk(x):
    if isinstance(x, dict):
        for k, v in x.items():
            if k == "campo" and isinstance(v, str):
                paths.add(v)
            walk(v)
    elif isinstance(x, list):
        for v in x:
            walk(v)


ids = set()
cats = set(schema["properties"]["identificacao"]["properties"]["tipo_contrato"]["properties"]["value"]["anyOf"][0]["properties"]["categoria"]["enum"])
bad = []
for r in rules["regras"]:
    assert re.match(r"^[A-Z]{3,4}-\d{2}$", r["id"]), r["id"]
    assert r["id"] not in ids, r["id"]
    ids.add(r["id"])
    assert r["severidade"] in rules["severidades"], r["id"]
    assert r["avaliacao"] in ("motor", "ia"), r["id"]
    if r["avaliacao"] == "ia":
        assert r.get("pergunta"), r["id"]
    for c in r["campos"]:
        if not c.startswith("*") and not exists(c):
            bad.append((r["id"], "campos", c))
    walk(r.get("quando"))
    walk(r.get("agravantes"))
    for t in (r.get("aplica_se") or {}).get("tipos", []) if isinstance((r.get("aplica_se") or {}).get("tipos"), list) else []:
        assert t in cats, (r["id"], t)
    walk_params = json.dumps(r)
    for p in re.findall(r'"param": "(\w+)"', walk_params):
        assert p in rules["parametros"], (r["id"], p)

for t in rules["parametros"]["tipos_criticos"]:
    assert t in cats, t
for p in paths:
    if p.startswith("*"):
        continue
    if not exists(p):
        bad.append(("quando", p))
print(f"{len(rules['regras'])} regras, {len(paths)} caminhos")
print("caminhos inexistentes:", bad or "nenhum")
from collections import Counter
print(Counter(r["severidade"] for r in rules["regras"]))
print(Counter(r["avaliacao"] for r in rules["regras"]))

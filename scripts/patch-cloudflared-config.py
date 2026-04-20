#!/usr/bin/env python3
"""
Add ingress rules to /DATA/AppData/cloudflared/config.json for the new
browser-proxy / browser-debug / health endpoints on the OpenCursor API server,
before the catch-all Next.js rule. Idempotent — re-runs don't duplicate rules.
"""
import json
import sys

CONFIG = "/DATA/AppData/cloudflared/config.json"
HOST = "opencursor.techlitnow.com"
API = "http://127.0.0.1:9100"
# Order matters: cloudflared ingress is evaluated top to bottom and must place
# path-scoped rules BEFORE the path-less catch-all for the same hostname,
# otherwise the catch-all swallows the request.
ADD_PATHS = ["/browser/*", "/browser-debug/*", "/health"]


def main() -> int:
    with open(CONFIG, "r") as f:
        data = json.load(f)
    ingress = data["ingress"]

    def has_rule(path: str) -> bool:
        return any(
            r.get("hostname") == HOST and r.get("path") == path for r in ingress
        )

    # Find the catch-all rule for our host (the one without a `path`). We
    # insert our new path-scoped rules immediately before it.
    try:
        catch_all_idx = next(
            i
            for i, r in enumerate(ingress)
            if r.get("hostname") == HOST and "path" not in r
        )
    except StopIteration:
        print(f"error: no catch-all ingress rule for {HOST}", file=sys.stderr)
        return 2

    to_insert = []
    inserted = []
    for p in ADD_PATHS:
        if has_rule(p):
            continue
        to_insert.append({"hostname": HOST, "path": p, "service": API})
        inserted.append(p)

    if not to_insert:
        print("no changes: all rules already present")
        return 0

    ingress[catch_all_idx:catch_all_idx] = to_insert
    with open(CONFIG, "w") as f:
        f.write(json.dumps(data, indent=2))
        f.write("\n")
    print("inserted:", inserted)
    return 0


if __name__ == "__main__":
    sys.exit(main())

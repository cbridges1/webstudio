# selfhost: the deps gate in selfhost-security.yml. Fails on high/critical advisories (OSV,
# CVSS >= 7) in the builder's and deploy service's production dependencies that have a fixed
# version and are not in the baseline (.github/selfhost-deps-baseline.txt: what the branch
# inherited from upstream when the gate was added). Fix or bump to remove baseline lines;
# never add new ones to get a PR through.
#
#   python3 selfhost-deps-gate.py osv.json prod.txt baseline.txt [--write-baseline]
#
# osv.json: osv-scanner --format json on pnpm-lock.yaml. prod.txt: pnpm list --prod
# --depth Infinity --parseable for the builder and the deploy service.
import json
import re
import sys

osv_path, prod_path, baseline_path = sys.argv[1:4]
write_baseline = "--write-baseline" in sys.argv

# name@version of every production package (paths under node_modules/.pnpm/<name>@<version>).
prod = set()
for line in open(prod_path):
    match = re.search(r"/\.pnpm/([^/]+)/node_modules/", line)
    if match:
        key = match.group(1).split("_")[0]  # drop the peer-dependency suffix
        name, _, version = key.rpartition("@")
        prod.add((name.replace("+", "/"), version))

findings = set()
for result in json.load(open(osv_path)).get("results", []):
    for pkg in result["packages"]:
        name, version = pkg["package"]["name"], pkg["package"]["version"]
        if (name, version) not in prod:
            continue
        vulns = {v["id"]: v for v in pkg.get("vulnerabilities", [])}
        for group in pkg.get("groups", []):
            try:
                score = float(group.get("max_severity") or 0)
            except ValueError:
                score = 0
            if score < 7:
                continue
            fixed = sorted({
                event["fixed"]
                for vid in group["ids"] if vid in vulns
                for affected in vulns[vid].get("affected", [])
                if affected.get("package", {}).get("name") == name
                for range_ in affected.get("ranges", [])
                for event in range_.get("events", []) if "fixed" in event
            })
            if fixed:
                findings.add((score, name, version, group["ids"][0], ", ".join(fixed)))

keys = sorted({f"{vid} {name}" for _, name, _, vid, _ in findings})
if write_baseline:
    with open(baseline_path, "w") as out:
        out.write("".join(f"{key}\n" for key in keys))
    print(f"Wrote {len(keys)} baseline entries")
    sys.exit(0)

baseline = {line.strip() for line in open(baseline_path) if line.strip() and not line.startswith("#")}
new = []
for score, name, version, vid, fixed in sorted(findings, reverse=True):
    severity = "critical" if score >= 9 else "high"
    known = f"{vid} {name}" in baseline
    print(f"{severity}\t{name}@{version}\t{vid}\tfixed in {fixed}{'' if not known else '  (baseline)'}")
    if not known:
        new.append(f"{name}@{version} {vid}")
stale = baseline - set(keys)
print(f"{len(findings)} fixable high/critical advisories in production dependencies, "
      f"{len(findings) - len(new)} in the baseline, {len(new)} new")
if stale:
    print(f"::notice::{len(stale)} baseline entries are fixed now; remove them: {', '.join(sorted(stale))}")
if new:
    for entry in new:
        print(f"::error::New high/critical advisory with a fix: {entry}")
    sys.exit(1)

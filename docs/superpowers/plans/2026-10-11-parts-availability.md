# Parts Availability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For every component on a board, show its datasheet and whether JLCPCB can supply and assemble it, and show what a change did to that picture, in the review viewer and the pull request comment.

**Architecture:** `kicad_review.py report` builds a `parts` list per project from the schematic objects it already parses (no new KiCad export). A separate `parts` subcommand, run only when the setting is on and a key is present, looks up each distinct LCSC number once against the JLCPCB Components API and writes a timestamped snapshot that `report` merges in. The viewer gets a third tab, "Parts". Age is computed at view time from the snapshot timestamp; no fetch ever happens from the report or the browser.

**Tech Stack:** Python 3 stdlib (`urllib.request`, `json`, `tomllib`), existing `ui/review.js` vanilla JS, GitHub Actions, existing self-check tests (`test_kicad_review.py`, `ui/check.mjs`).

**Spec:** the request in the planning session of 2026-10-11 (copied into section A below as findings and decisions).

## Global Constraints

- Setting `parts.enabled` is off by default, validated as bool, like `3d.enabled`.
- Only LCSC part numbers (`C\d+`) leave our systems. Never names, values, footprints, refs, quantities, repo names.
- No key in the repository, logs, report HTML, `data.json`, or browser.
- A supplier failure never fails a run, a step, or hides other report content. It shows as "unavailable".
- A stock value older than 24 h is never shown as green "in stock".
- No scraping. No PCBWay substitute. No new Python or npm dependency.
- No pushes to `main`, no moving `v1`, nothing in ParadigmEngineering.

## Review Focus

- Fork PRs and Dependabot runs: no secret. Expect "lookup not run: no key in this run", rest of report intact.
- API returns 200 with a part missing, or 429/5xx/timeout mid-run: affected parts "unavailable", others filled, step exit 0.
- A symbol with LCSC field set to `~`, whitespace, or lower-case `c123`: normalise case/space; `~` counts as missing.
- Same LCSC number on symbols with different Values (bad copy-paste): flag "one LCSC number, several values".
- Report opened weeks later offline: age banner says "stock as of <date>, N days old"; no green.

---

## A. Findings (answers to "what you need to find out")

### A1. Workspace

| | |
|---|---|
| Base clone | `~/Code/kicad-review` (fresh clone, on `main`, untouched) |
| Worktree | `~/Code/kicad-review-worktrees/parts-availability` |
| Branch | `feature/parts-availability`, from `origin/main` |
| Start commit | `059e971a535cde6a6bfbbdea4c768f034848d1e7` (Merge PR #11 minor-fixes) |
| Test project | `~/Code/kicad-review-test-parts` (own clone, read-only, `c6b30d5`) |
| Remote branch check | `git ls-remote` found no `feature/parts-availability` on GitHub. Not pushed. |

### A2. What each supplier offers

**JLCPCB.** Official Components API exists: "real-time pricing, inventory data, and component specifications" ([api.jlcpcb.com](https://api.jlcpcb.com/)). Access: JLCPCB account, apply on the developer portal, free. "Not all applications will be approved"; review is "based on the partner's previous orders at JLCPCB, company and business situation" ([help article](https://jlcpcb.com/help/article/jlcpcb-online-api-available-now)). Terms on that page: no JLC trademark/logo on your website or in URLs; no code support. Third-party client code uses `https://api.jlcpcb.com/components/v1` with a Bearer key ([kicad-ultra issue #51](https://github.com/danielmeza/kicad-ultra/issues/51)).
Not confirmed (docs are behind the portal login): approval time, rate limits, auth scheme, whether the response has basic/extended/preferred and assembly fee, whether internal tools like ours are an accepted use.

**LCSC.** Official partner API exists ([lcsc.com/docs](https://www.lcsc.com/docs/index.html), apply at [lcsc.com/agent](https://www.lcsc.com/agent)): item details, keyword search, orders. Signed with key+secret+timestamp+nonce. Application wants company website, business licence, estimated order quantity. Aimed at resellers. Rate limits and approval time not published. Does not give JLCPCB assembly class (basic/extended).

**PCBWay.** API exists only for approved partners, by email to anson@pcbway.com ([api_cooperation](https://www.pcbway.com/api_cooperation.html), [api-partner.pcbway.com](https://api-partner.pcbway.com/)). It covers PCB quote/order/status; Assembly API "under construction". **No parts, stock or price API.** Their parts library ([pcbway.com/components](https://www.pcbway.com/components/)) is website only. Plan: PCBWay column shows the MPN that their BOM would need and "PCBWay publishes no parts data". No scraping.

**Alternatives.**

| Source | Cost | Limits | Freshness | Terms | Verdict |
|---|---|---|---|---|---|
| [jlcparts](https://github.com/yaqwsx/jlcparts) / [CDFER db](https://github.com/CDFER/jlcpcb-parts-database) | free | 1 GB sqlite; CDFER drops parts with <5 stock | daily, 06:00 UTC | code MIT; data comes from scraping a JLCPCB internal endpoint | Rejected: scraped provenance, and "out of stock" parts vanish (indistinguishable from "not found") |
| [jlcsearch (tscircuit)](https://docs.tscircuit.com/web-apis/jlcsearch-api) | free, no key | not published | not published | data licence not stated; built on same scraped db | Rejected for same reason; would also send part numbers to a third party |
| [Nexar/Octopart](https://nexar.com/compare-plans) | Evaluation = 100 matched parts lifetime ([support](https://support.nexar.com/support/solutions/articles/101000476314-part-limits-and-how-they-work)); paid tiers unpriced in results | 2 req/s | live | commercial | Rejected: 100 parts total is one board once |
| [DigiKey Product Info v4](https://developer.digikey.com/faq) | free | 120/min, 1000/day | live | standard developer terms | Optional later: MPN-based stock/datasheet, not JLCPCB assembly |
| [Mouser Search API](https://www.mouser.com/en/api-search/) | free, instant key | 30/min, 1000/day | live | [terms](https://www.mouser.com/en/apiterms/) forbid caching/storing content | Rejected: our design stores a snapshot in the report |
| Apify / parse.bot LCSC scrapers | paid | — | live | scraping | Rejected: scraping, paid |

### A3. Recommended source per item

| Item | Source | Why |
|---|---|---|
| Datasheet link | KiCad `Datasheet` field when it is an `http(s)` URL; else JLCPCB API datasheet URL if returned; else none | Symbol is the designer's own choice and needs no network. If both exist and differ, show symbol link first and supplier link as "supplier copy". |
| JLCPCB stock, price at qty, basic/extended, fee | JLCPCB Components API | Only official source; free. |
| PCBWay | none exists | Show MPN presence only. |
| Discontinued | JLCPCB API if it carries status; else "not known" | Unconfirmed field. |

### A4. What you must do yourself

1. Apply for JLCPCB Components API at api.jlcpcb.com with your JLCPCB account. Time unknown; the page gives none. Approval depends on order history, so apply from the account with orders.
2. If approved: add repo secret `JLCPCB_API_KEY` to `kicad-review-test` (Settings > Secrets > Actions). Two minutes.
3. Read the portal's API terms once you have access and confirm internal-review use is allowed. I could not read them.
4. Not needed: LCSC API (needs business licence, gives nothing extra), PCBWay partner email (no parts data), Nexar, Mouser.

### A5. Matching, and the test project today

Matching rule, in order:
1. Field named `LCSC`, `LCSC Part`, `LCSC Part #`, `JLCPCB Part #` (case-insensitive) matching `^C\d+$` after trim/upper. This is the only key sent to JLCPCB.
2. Else `Manufacturer_Part_Number` / `MPN` / `Mfr. Part #`: shown, marked "no LCSC number: cannot check JLCPCB". Not searched: MPN search returns several candidates, guessing is worse than saying "missing".
3. Else: "missing part number".
No value+footprint guessing. A "10k 0805" match is not a part.

Test project (Thermal_Camera, 56 placed parts, 29 distinct):
- LCSC field: **0 of 56**. MPN field: 1 of 56 (U5, plus Mouser number). Datasheet URL: 4 of 56; 3 more hold a part name, not a URL.
- Result today: all 29 lines "missing part number" (28) or "no LCSC number" (1). Lookup would send zero requests.
- Existing release preset already expects `LCSC Part #` style field for JLCPCB BOM (`fabrication.part_field` defaults to LCSC).
Team action: add an `LCSC` field to each symbol (29 distinct values; for passives, pick a JLCPCB basic part), plus `Manufacturer_Part_Number` for PCBWay. Turn `bom.required_fields = ["Value","Footprint","LCSC"]` on to keep it filled.

### A6. When the lookup runs, cache, age

- Runs in the workflow, once per run, after `detect`, only if `parts.enabled` and `JLCPCB_API_KEY` is non-empty. Snapshot (`review/parts.json`) records `fetched_at` (UTC ISO).
- No live fetch from the web app in this plan. The review is a record of one moment; the report already lives in a GitHub artifact the Worker streams unchanged. A live "refresh now" via the Worker is listed as a later option (section C), not built.
- Calls per run = distinct LCSC numbers on head ∪ base. Thermal_Camera after the team fills fields: ≤29. Board with "hundreds of parts": typically 60–120 distinct. Cost: 0 (API free). If the API has a batch endpoint, 1–3 calls.
- Cache: `actions/cache` on `.parts-cache/` keyed `parts-${{ runner.os }}-<UTC date>-<hour/6>` (6-hour buckets) so repeated pushes in one window reuse results. Each cached entry keeps its own `fetched_at`; the report shows the oldest.
- Age display: computed in the browser from `fetched_at` vs now, no network. < 6 h: normal. 6–24 h: "N h old" amber note. > 24 h: stock numbers grey, no green tick, label "stock as of <date>". Never shows "in stock" without a date.

### A7. Keys and data leaving our systems

| Key | Lives in | Who can read |
|---|---|---|
| `JLCPCB_API_KEY` | GitHub Actions repo (or org) secret of each design repo; passed by the caller with `secrets: JLCPCB_API_KEY: ${{ secrets.JLCPCB_API_KEY }}` into `review.yml` (`workflow_call` declares it optional) | Repo admins set it; it reaches only runs from push, `workflow_dispatch`, and same-repo PRs. [Fork PRs and Dependabot runs get no secrets](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions). Any collaborator with write access can still exfiltrate it by editing the workflow in a same-repo PR branch: accepted, same trust as today's `contents: write` token. |
| Worker secrets | unchanged (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_KEY`). No supplier key in the Worker in this plan. | Cloudflare account admins. |

Key handling: read from env var only; passed to `urllib` header; `::add-mask::` not needed (GitHub masks secrets) but the script never prints headers or request objects; error messages print status code and LCSC number only.

Outbound data: HTTPS from the GitHub runner to `api.jlcpcb.com`, carrying the list of LCSC numbers (`C25804` etc.) and the key. Nothing else. JLCPCB can see: our account, which numbers, when. That reveals a parts list but no topology, refs, quantities, or project name. No other host is contacted.

### A8. Screen sketch

Viewer, new tab next to Changes / Checks:

```
[Changes 12] [Checks] [Parts 29 · 3 ⚠]
JLCPCB data as of 2026-10-11 14:02 UTC (2 h old)     [Only problems ☐] [Only changed ☐]
──────────────────────────────────────────────────────────────────────────────
Δ   Refs        Value / MPN          LCSC     JLCPCB            PCBWay      Datasheet
+   R18         10k                  C17414   ✔ 1.2M  $0.0005 B  MPN missing  —
~   U2          AP63203WU-7          C780769  ✔ 3,410 $0.31 Ext  MPN ✔       pdf · supplier
~   R7          10k → 4.7k           C17414→C17673  (swapped)
⚠+  J5          XYZ-123              —        missing LCSC number
⚠   U4          ESP32-S3-WROOM-1     C2913202 ✖ out of stock (0)
                                              unavailable: 503 (row grey, rest fine)
```
Δ = added / removed / swapped (LCSC changed) / value-only. ⚠ rows sorted first. "B/Ext" = basic/extended, "Ext" shows fee note if the API reports it.

PR comment, new collapsed section under checks:

```
#### Parts — 2 problems introduced
JLCPCB data as of 2026-10-11 14:02 UTC. 29 lines: 26 orderable, 1 out of stock, 2 missing LCSC number.
New in this change: J5 missing LCSC number; U4 out of stock (was 1,200).
<details><summary>All parts (29)</summary> table </details>
```
With no key: "Parts: 29 lines, 27 missing LCSC number. Supplier lookup not run (no key in this run)."

### A9. What changes

- `examples/kicad-review.toml`: `[parts] enabled = false`.
- `kicad_review.py`: `DEFAULT_SETTINGS["parts"]`, validation; `parts_lines(objs)`; `diff_parts(base, head)`; `cmd_parts` (lookup); `build_project` adds `"parts"`; `comment_markdown` adds section; `report_settings` drops `parts` when off.
- Data format: project gains `parts: {lines: [...], changes: [...], supplier: {fetched_at, status, error}}` only when enabled. `version` stays 1 (additive key; old viewer ignores it).
- `.github/workflows/review.yml`: `workflow_call.secrets.JLCPCB_API_KEY` (required: false); `actions/cache` step; `parts` step with `continue-on-error: true`.
- `examples/kicad-review.yml`: pass the secret.
- `ui/review.js` + `ui/review.css`: Parts tab. `ui/sample/review-data-parts.js` fixture.
- `site/`: no change.

### A10. What I could not determine

- JLCPCB API: rate limits, approval time, response fields (basic/extended, fee, datasheet, lifecycle), batch support, exact auth, terms on internal use. All behind portal login.
- Whether JLCPCB grants keys to accounts with few orders.
- jlcsearch data licence and rate limits.
- Nexar paid tier prices.
- Whether the 4 datasheet URLs in Thermal_Camera still resolve (not checked: would contact third-party hosts).

---

## B. Build order

Stage 1–3 need no API access and are useful now. Stage 4 needs the key. Each stage ends with a check against `Cameronrlewis/kicad-review-test` via a PR on a test branch there (not `main`), pinned to this branch with `uses: Cameronrlewis/kicad-review/.github/workflows/review.yml@feature/parts-availability`.

### Task 1: Setting and parts lines (no network)

**Files:**
- Modify: `kicad_review.py` (`DEFAULT_SETTINGS` ~l.587, `load_settings` ~l.611, new `parts_lines` after `bom_violations` ~l.756)
- Modify: `examples/kicad-review.toml`
- Test: `test_kicad_review.py`

**Interfaces:**
- Produces: `parts_lines(objs: dict) -> list[dict]`, each `{"key": str, "refs": [str], "value": str, "footprint": str, "lcsc": str|None, "mpn": str|None, "datasheet": str|None, "problems": [str]}`; `LCSC_FIELDS`, `MPN_FIELDS`.

- [ ] **Step 1: failing test** (append to `test_kicad_review.py`)

```python
# Parts lines: group by value+footprint+LCSC, normalise LCSC, flag missing numbers and conflicts.
from kicad_review import parts_lines
sym = lambda ref, v, lcsc=None, ds="~", mpn=None: {"kind": "symbol", "ref": ref, "props": {
    "Value": v, "Footprint": "R_0805", "Datasheet": ds, **({"LCSC": lcsc} if lcsc is not None else {}),
    **({"MPN": mpn} if mpn else {})}}
objs = {"a": sym("R1", "10k", " c17414 "), "b": sym("R2", "10k", "C17414"), "c": sym("R3", "1k", "~"),
        "d": sym("U1", "AP63203WU-7", ds="https://x/ap.pdf", mpn="AP63203WU-7"), "e": sym("R4", "4.7k", "C17414"),
        "f": {"kind": "footprint", "ref": "R1", "props": {}}, "g": sym("#PWR01", "GND")}
L = {l["key"]: l for l in parts_lines(objs)}
r = next(l for l in L.values() if l["refs"] == ["R1", "R2"])
assert r["lcsc"] == "C17414" and "lcsc_conflict" in r["problems"], r   # C17414 also on 4.7k
assert next(l for l in L.values() if l["refs"] == ["R3"])["problems"] == ["missing_lcsc", "missing_mpn"]
u = next(l for l in L.values() if l["refs"] == ["U1"])
assert u["datasheet"] == "https://x/ap.pdf" and u["problems"] == ["missing_lcsc"]
assert not any("#PWR01" in l["refs"] for l in L.values())
print("ok")
```

- [ ] **Step 2:** `python3 test_kicad_review.py` → FAIL `ImportError: cannot import name 'parts_lines'`.

- [ ] **Step 3: implement**

```python
LCSC_FIELDS = ("lcsc", "lcsc part", "lcsc part #", "lcsc part number", "jlcpcb part #")
MPN_FIELDS = ("mpn", "manufacturer_part_number", "manufacturer part number", "mfr. part #", "mfg part #")


def field(props, names):
    v = next((props[k] for k in props if k.strip().lower() in names), "")
    v = (v or "").strip()
    return None if v in ("", "~") else v


def parts_lines(objs):
    """One line per distinct part on the schematic (Value + Footprint + LCSC), with what blocks a supplier lookup."""
    lines = {}
    for o in objs.values():
        pr = o.get("props", {})
        if o["kind"] != "symbol" or o["ref"].startswith("#") or o["ref"].endswith("?") \
                or pr.get("in_bom") == "no" or pr.get("dnp") == "yes":
            continue
        lcsc = (field(pr, LCSC_FIELDS) or "").upper() or None
        ds = field(pr, ("datasheet",))
        line = lines.setdefault((pr.get("Value", ""), pr.get("Footprint", ""), lcsc), {
            "value": pr.get("Value", ""), "footprint": pr.get("Footprint", ""), "lcsc": lcsc,
            "mpn": field(pr, MPN_FIELDS), "datasheet": ds if ds and ds.startswith(("http://", "https://")) else None,
            "refs": [], "problems": []})
        if o["ref"] not in line["refs"]:
            line["refs"].append(o["ref"])
    by_lcsc = {}
    for l in lines.values():
        l["refs"].sort(key=natural)
        l["key"] = "|".join([l["value"], l["footprint"], l["lcsc"] or ""])
        if l["lcsc"] and not re.fullmatch(r"C\d+", l["lcsc"]):
            l["problems"].append("bad_lcsc")
        if not l["lcsc"]:
            l["problems"].append("missing_lcsc")
        if not l["mpn"]:
            l["problems"].append("missing_mpn") if not l["lcsc"] else None
        by_lcsc.setdefault(l["lcsc"], set()).add(l["value"])
    for l in lines.values():
        if l["lcsc"] and len(by_lcsc[l["lcsc"]]) > 1:
            l["problems"].append("lcsc_conflict")
    return sorted(lines.values(), key=lambda l: natural(l["refs"][0]))
```

Check before implementing: how `sch_objects` stores `in_bom`/`dnp` (reuse the same test `bom_violations` uses at ~l.741; if it differs, copy that condition exactly rather than the one above). `re` must be imported.

Settings:

```python
    "3d": {"enabled": False},
    "parts": {"enabled": False},
...
    for section in ("checks", "bom", "fabrication", "3d", "parts"):
...
    if not isinstance(settings["parts"]["enabled"], bool):
        sys.exit(f"{SETTINGS_FILE}: parts.enabled must be true or false")
```

`examples/kicad-review.toml` append:

```toml
# Parts: datasheet and JLCPCB stock per component. Lookups need repository secret JLCPCB_API_KEY;
# without it the Parts tab still lists datasheets and missing part numbers.
[parts]
enabled = false
```

- [ ] **Step 4:** `python3 test_kicad_review.py` → PASS (`ok` ×N).
- [ ] **Step 5:** Run against test project:
`python3 -c "import kicad_review as k, json; print(json.dumps(k.parts_lines(k.project_objects('$HOME/Code/kicad-review-test-parts/Thermal_Camera','Thermal_Camera')),indent=1))" | grep -c '"refs"'` → expect `29`; 28 lines with `missing_lcsc`+`missing_mpn`, U5 with `missing_lcsc` only.
- [ ] **Step 6:** commit `feat: parts lines from schematic, parts.enabled setting`.

### Task 2: Parts diff and report data

**Files:** Modify `kicad_review.py` (`build_project` ~l.874, `cmd_report` `report_settings` ~l.976); Test `test_kicad_review.py`.

**Interfaces:**
- Consumes: `parts_lines`.
- Produces: `diff_parts(base: list, head: list) -> list[dict]` rows `{"action": "added"|"removed"|"swapped"|"value", "refs": [str], "before": line|None, "after": line|None}`; project key `parts = {"lines": head_lines, "changes": rows, "supplier": snapshot-or-None}`.

- [ ] **Step 1: failing test**

```python
from kicad_review import diff_parts
b = [{"refs": ["R1"], "value": "10k", "lcsc": "C1", "key": "10k|F|C1"}, {"refs": ["R2"], "value": "1k", "lcsc": "C2", "key": "1k|F|C2"},
     {"refs": ["R9"], "value": "5", "lcsc": None, "key": "5|F|"}]
h = [{"refs": ["R1"], "value": "10k", "lcsc": "C9", "key": "10k|F|C9"}, {"refs": ["R3"], "value": "1k", "lcsc": "C2", "key": "1k|F|C2"},
     {"refs": ["R9"], "value": "5", "lcsc": None, "key": "5|F|"}]
d = {(r["action"], tuple(r["refs"])) for r in diff_parts(b, h)}
assert d == {("swapped", ("R1",)), ("removed", ("R2",)), ("added", ("R3",))}, d
print("ok")
```

- [ ] **Step 2:** run → FAIL import error.
- [ ] **Step 3: implement** (by reference designator: a ref whose line key changed is "swapped" if LCSC changed, else "value")

```python
def diff_parts(base, head):
    """What a change did to the parts list, per reference designator, grouped back into lines."""
    at = lambda lines: {r: l for l in lines for r in l["refs"]}
    b, h = at(base), at(head)
    rows = {}
    for ref in sorted(set(b) | set(h), key=natural):
        x, y = b.get(ref), h.get(ref)
        if x and y and x["key"] == y["key"]:
            continue
        action = "added" if not x else "removed" if not y else "swapped" if x["lcsc"] != y["lcsc"] else "value"
        r = rows.setdefault((action, x and x["key"], y and y["key"]), {"action": action, "refs": [], "before": x, "after": y})
        r["refs"].append(ref)
    return list(rows.values())
```

In `build_project`, after `objs = ...`:

```python
    parts = None
    if settings["parts"]["enabled"]:
        lines = {s: parts_lines(objs[s]) for s in ("base", "head")}
        parts = {"lines": lines["head"], "changes": diff_parts(lines["base"], lines["head"]),
                 "supplier": supplier_snapshot(lines["head"])}
```
and add `**({"parts": parts} if parts else {})` to the returned dict. `supplier_snapshot` comes in Task 4; for now define `def supplier_snapshot(lines): return None`.
In `cmd_report`: `report_settings = {k: v for k, v in settings.items() if not (k in ("3d", "parts") and not v["enabled"])}`.

- [ ] **Step 4:** run tests → PASS. Also existing `node ui/check.mjs` passes (no viewer change yet).
- [ ] **Step 5:** commit `feat: parts diff in report data`.

### Task 3: Parts tab and PR comment section (no-API version complete)

**Files:** Modify `ui/review.js` (`renderPanel` ~l.452, `S.t` validation ~l.123), `ui/review.css`; Create `ui/sample/review-data-parts.js`; Modify `ui/check.mjs`; Modify `kicad_review.py` (`comment_markdown` ~l.1092, new `parts_markdown`); Test `test_kicad_review.py`.

**Interfaces:** Consumes `project.parts`. Produces `parts_markdown(data) -> str`, `renderParts()` in review.js.

- [ ] **Step 1: failing tests.** Python:

```python
from kicad_review import parts_markdown
p = {"name": "X", "parts": {"lines": [{"refs": ["R1"], "value": "10k", "lcsc": None, "problems": ["missing_lcsc", "missing_mpn"]}],
     "changes": [{"action": "added", "refs": ["R1"], "before": None,
                  "after": {"refs": ["R1"], "value": "10k", "lcsc": None, "problems": ["missing_lcsc", "missing_mpn"]}}],
     "supplier": None}}
m = parts_markdown({"projects": [p]})
assert "1 problem introduced" in m and "R1 missing LCSC number" in m and "lookup not run" in m, m
assert parts_markdown({"projects": [{"name": "Y"}]}) == ""
print("ok")
```
`ui/check.mjs`: add a case loading `ui/sample/review-data-parts.js`, clicking `[data-tab=parts]`, asserting `#panel .parts-row` count equals fixture lines and a `.parts-row.problem` exists first. (Follow the existing `--page` case pattern in `check.mjs`; read it before writing.)

- [ ] **Step 2:** run both → FAIL.
- [ ] **Step 3: implement.**

```python
PROBLEM_TEXT = {"missing_lcsc": "missing LCSC number", "bad_lcsc": "LCSC number malformed", "lcsc_conflict": "one LCSC number on several values",
                "out_of_stock": "out of stock", "not_found": "not found at JLCPCB", "discontinued": "discontinued", "unavailable": "lookup unavailable"}
BLOCKING = {"missing_lcsc", "bad_lcsc", "out_of_stock", "not_found", "discontinued"}


def parts_markdown(data):
    out = []
    for p in data["projects"]:
        parts = p.get("parts")
        if not parts:
            continue
        introduced = [(r["refs"], pr) for r in parts["changes"] if r["after"] and r["action"] != "removed"
                      for pr in r["after"]["problems"] if pr in BLOCKING and pr not in ((r["before"] or {}).get("problems") or [])]
        s = parts["supplier"]
        head = f"#### Parts: {p['name']}" + (f" — {plural(len(introduced), 'problem')} introduced" if introduced else "")
        when = f"JLCPCB data as of {s['fetched_at']}." if s and s.get("fetched_at") else \
               f"Supplier lookup not run ({(s or {}).get('error') or 'no key in this run'})."
        bad = sum(1 for l in parts["lines"] if BLOCKING & set(l["problems"]))
        out += [head, "", f"{when} {plural(len(parts['lines']), 'line')}, {bad} with a problem.", ""]
        out += [f"- {', '.join(refs)} {PROBLEM_TEXT[pr]}" for refs, pr in introduced]
    return "\n".join(out)
```
Call it from `comment_markdown` after the checks section, same size-limit path as `checks_markdown`.

Viewer: add tab button `Parts ${p.parts.lines.length}` only when `p.parts`; `renderParts()` renders the table in A8 (columns Δ, Refs, Value/MPN, LCSC, JLCPCB, PCBWay, Datasheet), problem rows first, two filter chips ("Only problems", "Only changed"), and the age line:

```js
function partsAge(s) {
  if (!s || !s.fetched_at) return { text: `Supplier lookup not run${s && s.error ? `: ${esc(s.error)}` : ""}`, stale: true };
  const h = (Date.now() - Date.parse(s.fetched_at)) / 36e5;
  return { text: `JLCPCB data as of ${esc(s.fetched_at.replace("T", " ").slice(0, 16))} UTC (${h < 48 ? Math.round(h) + " h" : Math.round(h / 24) + " days"} old)`,
           stale: h > 24, warn: h > 6 };
}
```
When `stale`, stock cells get class `stale` (grey, no ✔). Datasheet links `rel="noopener noreferrer" target="_blank"`, URL passed through existing `esc`; only `http(s)` scheme rendered as a link (the server already filters, re-check in JS). Extend `S.t` validation to accept `"parts"`.

Fixture `ui/sample/review-data-parts.js`: copy `review-data.js` shape with one project, 5 lines covering ok / missing_lcsc / out_of_stock / unavailable / swapped, `supplier.fetched_at` 3 days ago is fixed text — the stale path is what check.mjs asserts.

- [ ] **Step 4:** `python3 test_kicad_review.py && node ui/check.mjs && node ui/check.mjs --dark` → PASS.
- [ ] **Step 5: prove on test project.** In `kicad-review-test`, branch `try/parts`: add `[parts] enabled = true` to `kicad-review.toml`, point caller at `@feature/parts-availability`, change one resistor value, open a PR. Requires pushing `feature/parts-availability` — **ask Cameron first.** Expect: Parts tab 29 lines, 28 "missing LCSC number"; comment says "Supplier lookup not run (no key in this run)"; run green.
- [ ] **Step 6:** commit `feat: parts tab and PR comment section`.

### Task 4: JLCPCB lookup (needs key)

Blocked on: approval, and reading the real API docs. Write against the documented response, not guesses. The code shape below fixes everything except `parse_jlc()`.

**Files:** Modify `kicad_review.py` (new `cmd_parts`, `supplier_snapshot`, `parse_jlc`, subcommand in `main` ~l.1199); Modify `.github/workflows/review.yml`, `examples/kicad-review.yml`; Test `test_kicad_review.py`.

**Interfaces:** Produces `review/parts.json` = `{"fetched_at": iso|None, "error": str|None, "parts": {"C17414": {"stock": int, "price": float|None, "class": "basic"|"extended"|"preferred"|None, "fee": float|None, "datasheet": str|None, "status": "ok"|"out_of_stock"|"not_found"|"discontinued"|"unavailable", "fetched_at": iso}}}`. `supplier_snapshot(lines)` reads it, adds problems to lines, returns `{fetched_at (oldest), error}`.

- [ ] **Step 1: failing test** with a stub fetcher (no network):

```python
from kicad_review import lookup_parts
calls = []
def fake(nums):
    calls.append(list(nums))
    if "C2" in nums: raise TimeoutError("timed out")
    return {"C1": {"stock": 0, "price": 0.01, "class": "basic", "fee": None, "datasheet": None, "status": "out_of_stock"}}
cache = {"C3": {"stock": 5, "status": "ok", "fetched_at": "2026-10-11T00:00:00Z"}}
snap = lookup_parts(["C1", "C1", "C2", "C3"], fake, cache, now="2026-10-11T02:00:00Z", batch=1)
assert calls == [["C1"], ["C2"]], calls                          # distinct, cached C3 skipped
assert snap["parts"]["C1"]["status"] == "out_of_stock"
assert snap["parts"]["C2"]["status"] == "unavailable" and "timed out" in snap["error"]
assert snap["fetched_at"] == "2026-10-11T00:00:00Z"              # oldest shown
print("ok")
```

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: implement**

```python
def lookup_parts(numbers, fetch, cache, now, batch=50):
    """Each distinct LCSC number once; cache hits skipped; any failure marks those numbers unavailable, never raises."""
    todo = sorted({n for n in numbers if n not in cache})
    parts, errors = {n: cache[n] for n in set(numbers) & set(cache)}, []
    for i in range(0, len(todo), batch):
        chunk = todo[i:i + batch]
        try:
            got = fetch(chunk)
        except Exception as e:  # supplier down, slow, refusing: never fail the review
            got, errors = {}, errors + [f"{type(e).__name__}: {str(e)[:80]}"]
        for n in chunk:
            parts[n] = {**got.get(n, {"status": "not_found" if n not in got and not errors else "unavailable"}), "fetched_at": now}
            if n not in got and errors:
                parts[n]["status"] = "unavailable"
    ok = [p["fetched_at"] for p in parts.values() if p["status"] != "unavailable"]
    return {"fetched_at": min(ok) if ok else None, "error": errors[0] if errors else None, "parts": parts}
```

`cmd_parts`: exit 0 immediately if `parts.enabled` false or `JLCPCB_API_KEY` empty (write `{"error": "no key in this run"}`); collect LCSC numbers from base+head `parts_lines`; load `.parts-cache/parts.json` dropping entries older than 6 h; `fetch` = `urllib.request` POST/GET to the documented endpoint with `Authorization` header from env, `timeout=20`, whole step wall clock capped at 120 s; write `review/parts.json` and refresh the cache. Never print the request, headers, or env. `parse_jlc(response) -> dict` maps documented fields; written once docs are readable.

Workflow (`review.yml`):

```yaml
on:
  workflow_call:
    secrets:
      JLCPCB_API_KEY:
        required: false
...
      - name: Parts cache
        if: steps.detect.outputs.changed == 'true'
        uses: actions/cache@<pinned sha of current v4/v5, same pinning style as upload-artifact>
        with:
          path: .parts-cache
          key: parts-${{ github.run_id }}
          restore-keys: parts-
      - name: Look up parts at JLCPCB
        if: steps.detect.outputs.changed == 'true'
        continue-on-error: true
        timeout-minutes: 3
        env:
          JLCPCB_API_KEY: ${{ secrets.JLCPCB_API_KEY }}
        run: python3 tools/kicad_review.py parts
```
placed before "Build comparison report and checks". (Cache key per run + restore-keys gives "latest cache"; 6 h expiry enforced in `cmd_parts`, not by key. Simpler than date buckets.)

`examples/kicad-review.yml` caller: `secrets: { JLCPCB_API_KEY: ${{ secrets.JLCPCB_API_KEY }} }`. Callers not passing it keep working.

- [ ] **Step 4:** tests PASS. Local manual run with the key in env only: `JLCPCB_API_KEY=... python3 kicad_review.py parts` in a prepared `review/` dir; check `review/parts.json` and `grep -r "$JLCPCB_API_KEY" review/` → nothing.
- [ ] **Step 5: prove.** Test project with LCSC fields filled on a test branch, secret set: Parts tab shows stock/price/class, age line < 1 h. Second push within 6 h: log shows `0 requests (N cached)`. Break the key (set wrong secret value on a test branch): run green, rows "lookup unavailable: HTTP 401".
- [ ] **Step 6:** commit `feat: JLCPCB part lookup at workflow time`.

### Task 5: Docs

- [ ] README section: setting, secret, what leaves our systems (copy A7), what the team must add (A5). Commit `docs: parts availability`.

---

## C. Deferred (YAGNI until asked)

- Live "refresh stock" button via the Worker (would put the JLCPCB key in Worker secrets and send numbers on view). Add if reviewers complain about stale data.
- DigiKey MPN lookup for PCBWay-side availability (free, 1000/day). Add if PCBWay becomes the main fab.
- Price at quantity: build quantity read from `[parts] quantity = 10` setting. Add with Task 4 once the API's price-break format is known (price shown at qty 1 until then, labelled so).

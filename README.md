# kicad-review

A reusable GitHub Actions workflow for KiCad 10 projects. Whenever someone changes a KiCad project it shows what changed on the actual schematic and board, not in the S-expression text. Everything runs inside GitHub Actions and appears inside GitHub. By default no secret is needed beyond the token GitHub gives every run, and access is whatever the repository already allows. Optional DigiKey stock and price lookup needs two supplier credentials; the optional companion review site is configured separately.

https://github.com/user-attachments/assets/f89d3fee-1f6f-4ac5-9f2a-cba6ffa763be

*A 2½-minute tour of every feature on a real control board: [download the explainer video](docs/explainer.mp4).*

## What you get

**On every pull request**, comparing the head with its merge base, a single comment that is edited in place on each push. It contains:

- A one-line summary per project, for example *"1 footprint moved (R12), R7 value 10k → 4.7k, **3 new DRC errors**"*.
- Before/after pictures of each changed sheet and board, zoomed to the largest change.
- The object-level change table: symbols, footprints, labels, zones, board outline, title block and design rules.
- ERC, DRC, schematic/board parity and BOM-field results, with errors and warnings counted separately and new ones called out.
- A link that opens the interactive report (one HTML file, no unzip) and the `gh api` command that downloads it.
- If a run fails, the comment is replaced with "Review failed — see run" and a link to the run, so results from an earlier commit are never left looking current; the next successful run restores the summary.

**On every push to a branch**, comparing the new commit with the previous branch tip, the same content goes to the run's job summary. A push to a branch with an open pull request skips itself, because the pull request run covers it.

**On demand**: *Actions → KiCad review → Run workflow*, then type any two commits, branches or tags.

**On a `v*` tag**, Gerbers and drill files (one zip), a BOM and a position file per project are attached to the GitHub release, in JLCPCB or PCBWay format. Set `[release] review = true` to also review changes since the previous `v*` tag and merge a "KiCad review" section into the release notes. The first release shows everything as added. Re-runs replace that section and keep surrounding notes. Required check failures appear in the notes and never block fabrication attachments; review errors do not prevent the fabrication steps from running. Tag review is off by default, including for existing `v1` callers.

**The interactive report** is one self-contained HTML file in the run's artifacts. Download it and open it in any browser. It works offline. It offers:

- five comparison modes: Side by side, Overlay (red removed, green added, black unchanged), Wipe, Blend and Semantic (changed objects marked on a faded drawing)
- pan and zoom; j / k step through changes and violations (the arrow keys step too after a click on the drawing)
- Copy link, which copies the review link with the exact view, and Go to…, which opens a pasted link at that spot
- per-layer toggles for boards
- the sheet hierarchy with changed sheets marked
- the change table and the check results, where clicking a row zooms to the object or violation

Every KiCad project in the repository (each folder with a `.kicad_pro`) is reviewed separately. The path filters also start runs for settings and waiver-file changes; a waiver-only pull request shows "No KiCad changes". A newer push to a pull request cancels that pull request's older run. Every push to a branch gets its own run, so no commit goes unreviewed.

## Add it to a repository

1. Copy [`examples/kicad-review.yml`](examples/kicad-review.yml) to `.github/workflows/kicad-review.yml` in the KiCad repository and commit it to the default branch. *Run workflow* only appears once the file is on the default branch.
2. Optional: copy [`examples/kicad-review.toml`](examples/kicad-review.toml) to `kicad-review.toml` at the repository root and change what differs: which checks are required, which BOM fields every part must have, and which fabrication preset to use. Without the file the defaults in that example apply.
3. If the repository belongs to an organisation, open *Organisation settings → Actions → General* and check two things:
   - **Policies** must allow reusable workflows from `Cameronrlewis/kicad-review`, either by allowing all actions or by adding it to the allow list.
   - **Workflow permissions** can stay read-only by default, because the caller file asks for `contents: write` and `pull-requests: write` (also `checks: write` when `github.check_runs` is enabled).
4. Open a pull request that touches a `.kicad_sch` or `.kicad_pcb` file. The comment appears in about two minutes.

To make checks block merging, require the status check **`review / review`** in a branch protection rule or ruleset. **This is not available for private repositories on GitHub Free**: the API answers "Upgrade to GitHub Pro or make this repository public". On Free, a failing required check still marks the run and the pull request with a red ✗, but it cannot block the merge. Enforcement needs GitHub Team for the organisation, or a public repository.

With `[github] check_runs = true` you can require individual checks instead: `kicad-review / ERC`, `kicad-review / DRC`, `kicad-review / Schematic/board parity`, `kicad-review / BOM fields`, and `kicad-review / Threads` when `threads.block_merge` is on. Add `checks: write` to the caller's permissions. `review / review` stays as before.

The site's re-run feature expects the caller workflow to be named `kicad-review.yml`.

## Settings (`kicad-review.toml`)

| Key | Default | Meaning |
|---|---|---|
| `fail_on` | `"new"` | `"new"`: a required check fails only on errors the change introduced. `"all"`: any error fails it. |
| `checks.erc`, `checks.drc`, `checks.parity` | `"required"` | `required`, `informational` or `off` |
| `checks.bom` | `"informational"` | as above |
| `checks.fab_limits` | `"informational"` | as above; eligible vendor geometry limits when opted in |
| `checks.interfaces` | `"off"` | as above; design-review rules on the schematic netlist |
| `interfaces.<rule>` | built-in names | net or pin-function names for a rule (`uart_tx`, `i2c_sda`, `i2c_scl`, `can_h`, `can_l`, `esd_parts`; `spi` is accepted for compatibility but unused) |
| `checks.release` | `"off"` | as above; builds and checks the fabrication package (adds about 2–4 s per board) |
| `bom.required_fields` | `["Value", "Footprint"]` | symbol fields every BOM part must have (DNP and excluded-from-BOM parts are skipped) |
| `bom.critical_prefixes` | `["U", "J", "Q", "D", "Y", "X", "K", "F"]` | reference prefixes whose datasheet coverage is shown separately |
| `bom.order_ready_fields` | preset's fields | fields every part needs to count as order-ready (JLCPCB: Value, Footprint, LCSC; PCBWay: Value, Footprint, MPN) |
| `fabrication.preset` | `"jlcpcb"` | `jlcpcb` or `pcbway`; downloads and BOM preset, not the fab-limit vendor |
| `fabrication.check_limits` | `false` | opt in to both JLCPCB and PCBWay limit checks; requires ordinary DRC (`checks.drc != "off"`) |
| `fabrication.part_field` | `LCSC` / `MPN` | symbol field holding the supplier part number |
| `3d.enabled` | `false` | export each changed board revision as a GLB and record footprints with missing 3D models; failed exports are recorded without failing the review |
| `parts.enabled` | `false` | show the parts list and its changes in the Parts tab and pull request comment |
| `release.review` | `false` | on a `v*` tag, review changes since the previous `v*` tag and add a "KiCad review" section to the release notes |
| `digikey.enabled` | `false` | look up stock and price by MPN; requires `parts.enabled = true` and the credentials below |
| `digikey.site` | `"US"` | DigiKey locale site, two uppercase letters (for example `CA`) |
| `digikey.currency` | `"USD"` | price currency, three uppercase letters (for example `CAD`) |
| `digikey.max_lookups` | `100` | maximum distinct MPNs per run, integer 1–900; excess lines show "not looked up: run limit" |
| `pdf.enabled` | `false` | also make a printable PDF (cover, summaries, pictures, changes, new errors) as a separate artifact; download it from the review site |

| `threads.enabled` | `false` | pin discussion threads to parts and points in the review site; they are stored as pull-request review comments |
| `inventory.enabled` | `false` | add an "All parts" list to the report's Changes tab: every symbol and footprint, searchable, click to zoom |
| `libraries.enabled` | `false` | Review local symbol and footprint libraries: drawings, pin/pad changes, used-by references, and warnings |
| `github.check_runs` | `false` | also publish one GitHub check run per check (`kicad-review / ERC`, `… / DRC`, …); the caller needs `checks: write` |
| `threads.block_merge` | `false` | fail the review while any blocking thread is open; needs `threads.enabled`; creating, resolving or reopening a blocking thread in the review site re-runs the review |
| `waivers.enabled` | `false` | read `kicad-review-waivers.toml`; a waived ERC, DRC, parity or fab-limit finding stays listed but no longer fails its check |

With `checks.release` on, each review also builds the fabrication package for the chosen preset and checks it: a Gerber for every copper layer and the outline, mask and paste on sides with SMD parts, drill files when the board has holes, a position file when SMD parts are fitted, and BOM and position file agreeing on references. Tagged releases also get a `SHA256SUMS` file so the files sent to the fab can be checked against the release.

For pull requests the base revision's settings file wins, so a change cannot relax the checks it is judged by. Only when the base has no settings file is the head's copy used. The workflow reads `release.review` from the tagged revision to decide whether to start its review; check settings still follow the base-first rule.

Set the Actions variable `KICAD_REVIEW_SITE` to your companion review site's URL to make review comments link to its report page.

Review history is off by default. Set the Actions variable `KICAD_REVIEW_HISTORY` to exactly `true` to keep the newest 50 review runs in the PR comment. The log records errors (new errors), not warnings. Failed or cancelled runs add no row; the previous log is carried over.

## Fabrication limit checks (optional)

Opt in to required checks with:

```toml
[checks]
fab_limits = "required"

[fabrication]
preset = "jlcpcb"
check_limits = true
```

Enabled fabrication limits require ordinary DRC (`checks.drc != "off"`); the incompatible combination is rejected. The default is opt-out (`fabrication.check_limits = false`) with `checks.fab_limits = "informational"`. Setting the check to `off` also disables it. Both JLCPCB and PCBWay are checked on every enabled review; `fabrication.preset` still chooses only the fabrication downloads and BOM preset. JLCPCB uses `jlcpcb-2l` for two copper layers and `jlcpcb-multilayer` for four or six; PCBWay uses `pcbway-std` for two, four or six. Other layer counts are explicitly not checked, never a clean pass. With `github.check_runs = true`, both vendor sections aggregate into one stable `kicad-review / Fab limits` check run, with vendor-qualified project rows.

Both base and head revisions are audited. Fab findings are paired as new, existing or fixed, so `fail_on = "new"` counts only fab errors absent from the base audit, rather than all newly audited errors. Without a usable base audit (for example, an added board or unsupported base layers), every head finding is newly audited and `baselineAvailable` is `false`. Other comparison-mode checks still label newly audited findings rather than claiming historical newness. In spec 06 single-mode presentation, absolute current `errors`/`warnings` are shown and comparison-only new/fixed labels are suppressed; status, `baselineAvailable: false` when supplied, and the full coverage ledger are retained. This includes zero-count unsupported failures and no-board `not_run` results: zero is not proof of a pass. A no-board `not_run` has no `baselineAvailable` or `fixed` field because no head audit exists.

The ordinary board DRC remains authoritative and unchanged. Each disposable vendor pass neutralizes house bounds, then enforces the vendor profile constraints; exclusions are cleared only in that temporary copy. Only ordinary-visible findings are subtracted from the vendor pass. An excluded house finding is not itself a vendor failure, while genuine vendor geometry remains checked despite authored Ignore severities or exclusions. Keeping the ordinary results and vendor-only additions preserves stricter house checks without rewriting the original board or rules. Temporary rules own only the section between `# kicad-review fab limits - start` and `# kicad-review fab limits - end`; authored rules outside it stay intact.

The immutable versioned table `fab_limits.json` beside the CLI is distinct from the generated per-project audits `review/<project-id>/head/fab-limits.json` and `review/<project-id>/base/fab-limits.json`. The check name is `fab_limits`: one section per vendor, distinguished by `vendor` (`jlcpcb` or `pcbway`). Explicit `confidence: "deterministic"` and `evidence_source` on checks and findings describe KiCad evidence for checked geometry, not certified vendor capabilities or complete coverage. `warnings` remains the existing integer violation count; optional `coverageWarnings: list[str]` carries nonwaivable uncertainty messages, also stored in cached metadata. The report's Checks ledger separates checked, unchecked and unsupported limits from numeric findings.

Profiles assume 1 oz copper (`assumedCopperOz = 1`, 0.035 mm). Missing/unknown stackup copper thickness or nonstandard thickness produces a coverage warning; these limits do not establish suitability for 2 oz copper. Without a valid closed outline, edge clearance is not checked. Mixed pad–via hole spacing is not checked; pad–pad and via–via checks apply only where the profile supplies their respective limits. Missing profile values, ambiguous mixed-pair limits and otherwise unsupported checks remain visible as unchecked. Retained limits without fresh publication support are explicitly identified as active study assumptions in the provenance section below. This is not a fabrication guarantee; confirm manufacturing options and uncertain study assumptions with the vendor. The provenance section below preserves the 2026-10-24 study values and records the fresh 2026-10-27 vendor-page check and per-profile `checkedOn` dates.

Fab findings can be waived like DRC findings. Waived counts remain visible, and one waiver applies to the same geometry in both vendor sections; uncertainty/coverage warnings cannot be waived. Re-running uses the existing GitHub review workflow (or the connected site's re-run action), not an offline check or a new service. The downloaded report embeds its results and does not fetch profiles or run DRC.

## Fabrication profile provenance

`fab_limits.json` keeps all twelve study profiles. Only `jlcpcb-2l`, `jlcpcb-multilayer` and `pcbway-std` were re-read on **2026-10-27**; the other nine retain their study date. A fresh `checkedOn` means the page was reviewed, not that every stored limit is published or that the board is vendor-certified. All limits below are millimetres and apply to the profile's assumed copper weight, not every manufacturing option.

Changes from the **2026-10-24 study values** (each URL was read on 2026-10-27):

- `jlcpcb-2l.drillPlatedMinMm`: 0.2 -> 0.15 (https://jlcpcb.com/capabilities/pcb-capabilities, 2026-10-27). Drill Diameter: “2-layer: 0.15 – 6.3 mm”.
- `jlcpcb-multilayer.drillPlatedMinMm`: 0.2 -> 0.15 (https://jlcpcb.com/capabilities/pcb-capabilities, 2026-10-27). Drill Diameter: “Multilayer: 0.15 – 6.3 mm”.
- `pcbway-std.drillPlatedMinMm`: 0.2 -> 0.15 (https://www.pcbway.com/capabilities.html, 2026-10-27). Standard Drill Sizes (CNC): “Min drill size is 0.15mm, max drill is 6.0mm.”
- `pcbway-std.holeToHoleMm`: 0.4064 -> 0.45 (https://www.pcbway.com/helpcenter/Engineering_Questions/limited_holes_spacing.html, 2026-10-27). “For standard 1oz copper thickness” and “Currently, the minimum spacing for different nets we can support is 0.45 mm for plated through holes and 0.30 mm for vias.” This supplementary source, not the main standard capability table, supports the change. The existing pad–pad rule does not distinguish nets, so it also conservatively applies the published different-net minimum to same-net pairs. The published via minimum is not added as a new profile field in this refresh; via–via remains unchecked for this profile.

Unchanged limits were compared with the following first-party text, all read on **2026-10-27**. Grouped keys share the quoted source, not an inferred numerical conversion.

| Profile and keys | Retained value | Exact source text | Source URL |
|---|---|---|---|
| `jlcpcb-2l`: `trackWidthOuterMm`, `clearanceOuterMm` | 0.1 | “Min. track width and spacing (1 oz)” / “1- and 2-layer: 0.10 / 0.10 mm (4 / 4 mil)” | https://jlcpcb.com/capabilities/pcb-capabilities |
| `jlcpcb-multilayer`: `trackWidthOuterMm`, `trackWidthInnerMm`, `clearanceOuterMm`, `clearanceInnerMm` | 0.09 | “Multilayer: 0.09 / 0.09 mm (3.5 / 3.5 mil). 3 mil is acceptable in BGA fan-outs.” | https://jlcpcb.com/capabilities/pcb-capabilities |
| `jlcpcb-2l`, `jlcpcb-multilayer`: `drillPlatedMaxMm` | 6.3 | “2-layer: 0.15 – 6.3 mm”; “Multilayer: 0.15 – 6.3 mm”; “Holes with diameter ≥ 6.3 mm are CNC routed from a smaller drilled hole.” | https://jlcpcb.com/capabilities/pcb-capabilities |
| `jlcpcb-2l`, `jlcpcb-multilayer`: `drillNpthMinMm` | 0.5 | “Min. Non-plated holes” / “0.50mm” | https://jlcpcb.com/capabilities/pcb-capabilities |
| `jlcpcb-2l`: `annularMinMm` | 0.18 | “PTH annular ring” / “2-layer:” / “1 oz: Recommended 0.25 mm or above; absolute minimum 0.18 mm” | https://jlcpcb.com/capabilities/pcb-capabilities |
| `jlcpcb-multilayer`: `annularMinMm` | 0.15 | “PTH annular ring” / “Multilayer:” / “1 oz: Recommended 0.20 mm or above; absolute minimum 0.15 mm” | https://jlcpcb.com/capabilities/pcb-capabilities |
| `jlcpcb-2l`, `jlcpcb-multilayer`: `edgeClearanceMm` | 0.2 | “Copper clearance from routed board edges: ≧0.2 mm” | https://jlcpcb.com/capabilities/pcb-capabilities |
| `jlcpcb-2l`, `jlcpcb-multilayer`: `holeToHoleMm` | 0.45 | “Pad Hole-to-Hole Spacing” / “0.45mm” | https://jlcpcb.com/capabilities/pcb-capabilities |
| `jlcpcb-2l`, `jlcpcb-multilayer`: `holeToHoleViaMm` | 0.2 | “Via Hole-to-Hole Spacing” / “0.2mm” | https://jlcpcb.com/capabilities/pcb-capabilities |
| `pcbway-std`: `trackWidthOuterMm`, `trackWidthInnerMm` | 0.1 | “Min manufacturable trace is 4mil(0.1mm), Please view the below \"Advanced PCB\" or contact us if your board exceeds these.” | https://www.pcbway.com/capabilities.html |
| `pcbway-std`: `clearanceOuterMm`, `clearanceInnerMm` | 0.1 | “Min manufacturable spacing is 4mil(0.1mm), Please view the below \"Advanced PCB\" or contact us if your board exceeds these.” | https://www.pcbway.com/capabilities.html |
| `pcbway-std`: `drillPlatedMaxMm` | 6 | “Min drill size is 0.15mm, max drill is 6.0mm. Any holes greater than 6mm or smaller than 0.2mm will be subject to extra charges.” | https://www.pcbway.com/capabilities.html |
| `pcbway-std`: `annularMinMm` | 0.15 | “Min Width of Annular Ring” / “0.15mm(6mil)” / “For pads with vias in the middle, Min width for Annular Ring is 0.15mm(6mil).” | https://www.pcbway.com/capabilities.html |

**Unverified study values retained, not freshly substantiated:** `pcbway-std.drillNpthMinMm = 0.45` and `pcbway-std.edgeClearanceMm = 0.25`. On 2026-10-27, https://www.pcbway.com/capabilities.html did not publish a separate standard-tier NPTH minimum or standard-tier edge-clearance limit supporting these study values. There is no supporting standard-tier quote for either value. The generic drill-size range does not separately identify NPTH. The capability page does list “Line to board edge distance / CNC milling / 0.25mm” in its advanced-tier table; this 0.25 mm value is deliberately not applied to `pcbway-std`. https://www.pcbway.com/advanced-pcb-capabilities.html was also read on 2026-10-27, but its advanced-tier values are not used for `pcbway-std`. These two stored constraints remain active study assumptions, not verified vendor minima; obtain vendor confirmation before relying on them for fabrication sign-off. The former `pcbway-std.holeToHoleMm = 0.4064` study value corresponds to the capabilities page's advanced-table “Hole to hole spacing >=16MIL” row, not its standard table; it is superseded by 0.45 mm, supported by the standard-1 oz different-net plated-hole rule in PCBWay's help-center page cited above.

Scope cautions: the lower JLCPCB drill option is conditional; the quoted general range above is used instead. JLCPCB's routed-edge limit does not cover V-cuts. PCBWay's hole-to-trace page (https://www.pcbway.com/helpcenter/Engineering_Questions/the_spacing_from_hole_to_trace.html, read 2026-10-27) says “min 0.2 mm from non-plated hole to trace, and min 0.35 mm from plated hole to trace”; neither is a hole-to-hole or board-edge limit, so neither replaces a profile value. The refreshed drill minima describe capability, not the preferred economical drilling option, and a drill exactly at the minimum is not a guaranteed fab finding.

## Interface checks (optional)

With `checks.interfaces` set to `informational` or `required` (default `off`), each review exports the schematic netlist and applies these rules:
- UART TX wired to TX;
- I2C pull-ups missing or doubled;
- CAN without a 120 Ω termination;
- USB-C CC pins floating (no 5.1 kΩ to GND and no PD controller);
- connector signal pins without an ESD or TVS part on the same net;
- signals joining parts powered from different rails.

Each finding names the nets and pins it is based on and states its assumption. A coverage line under the checks says what was detected and how many connector signal pins are protected. Pin-function names must contain the role token (e.g. `USART1_TX`, `SDA`). Symbols with only port names (`PA9`) or fused names (`U0TXD`) are not matched; add patterns under `[interfaces]`. Names are matched by whole tokens of the net name (last path element) and pin functions. Extend them under `[interfaces]`, for example `i2c_sda = ["SDA", "TOUCH_SDA"]`.

## Parts (optional)

Set `enabled = true` under `[parts]` in `kicad-review.toml` (default: `false`). The Parts tab and pull request comment section list each distinct part's value, footprint, references, LCSC number and manufacturer part number, with a datasheet link from the symbol's `Datasheet` field (http/https only). They flag missing or malformed LCSC numbers and one LCSC number used on several values, and show which parts the change added, removed, swapped to another LCSC number, or gave a new value or footprint.

Add an `LCSC` field to each symbol for its JLCPCB part (for example `C17414`), and `Manufacturer_Part_Number` for the PCBWay BOM. Optionally add `"LCSC"` to `bom.required_fields` to require it. It also shows BOM coverage per field (with the change from base), field-by-field edits per reference, placeholder values such as `TBD`, one MPN used on several footprints, and parts that are DNP on only one of schematic and board.

Recognised field names (case-insensitive):

- LCSC: `lcsc`, `lcsc part`, `lcsc part #`, `lcsc part number`, `jlcpcb part #`.
- Manufacturer part number: `mpn`, `manufacturer_part_number`, `manufacturer part number`, `mfr. part #`, `mfg part #`.

### DigiKey stock and price (optional)

**Keep it off in public repositories: DigiKey's terms forbid passing its data to third parties.** The lookup is off by default. Use it only for permitted internal purchasing use in a private repository; the report artifact is visible to repository readers. See [DigiKey's API User Agreement](https://developer.digikey.com/api-user-agreement) for permitted display and attribution.

1. Sign in at [developer.digikey.com](https://developer.digikey.com/). Create or join an Organization, then open **Organizations → Operations → Production Apps → Create Production App**. If the form requires a callback URL, use `https://localhost`; this client-credentials flow never uses it.
2. Subscribe the app to **Product Information V4**. Copy its Client ID and Client Secret into repository Actions secrets named `DIGIKEY_CLIENT_ID` and `DIGIKEY_CLIENT_SECRET`. Each repository uses its own credentials; never commit or paste them into a workflow's `run:` script.
3. Add `secrets: inherit` to the caller's `review:` job, as in [`examples/kicad-review.yml`](examples/kicad-review.yml). Existing callers without secrets remain supported. Credentials are passed as environment variables only to the separate lookup step, not to the render, report or comment steps.
4. Enable both features in the repository-root `kicad-review.toml`:

   ```toml
   [parts]
   enabled = true

   [digikey]
   enabled = true
   site = "US"
   currency = "USD"
   max_lookups = 100
   ```

   The base revision's settings still win: enabling it only on a pull request's head does not enable that run when the base already has a settings file.

The runner sends **MPNs only** from the design, never references, values, footprints or manufacturer fields. It trims and collapses whitespace, rejects placeholders and invalid MPNs, and deduplicates case-insensitively. Normally it makes one token call plus one search per distinct MPN, capped by `max_lookups`. Calls are paced 0.6 seconds apart; DigiKey's Product Information limits are **120 per minute** and **1000 per day**, shared by every run using the same app. One rejected/expired token (401) permits one token refresh and one retry, adding at most two calls. A second 401, 429 or 403 stops the run. Other failures affect only that line; three consecutive failures stop further lookups. The step has a five-minute timeout, so large caps may time out before finishing (900 searches alone need about nine minutes).

Only exact MPN matches are used. If several manufacturers share an MPN, the symbol's `Manufacturer` field is stripped and matched as a **case-insensitive prefix** against DigiKey's manufacturer names. This is not an alias or fuzzy-name lookup: abbreviations may fail to match, and a short prefix can still match several manufacturers. Conflicting manufacturer fields across lines sharing one MPN disable that hint. If no manufacturer matches, or several still match, the result stays **ambiguous**, with no stock or price.

The Parts tab shows stock, quantity-1 unit price in the selected currency, product status, the fetch time and **Stock and price from DigiKey** attribution, with a link to the DigiKey product page. Data older than 24 hours is greyed and never shown as in stock. Missing/invalid MPNs and the run cap are counted separately; counts refer to distinct displayed BOM lines, not physical component quantities. The PR comment and job summary contain **counts only**, never stock quantities or prices.

Fork pull requests and repositories without credentials show **DigiKey lookup skipped: no credentials (forked pull request or secrets not set)** and make no API call. Lookup failures show **unavailable** and never fail the review; successful lines remain visible after a partial failure. With DigiKey off there is no call, and report/comment output stays unchanged.

Results are kept **only in the run's report**, not in a persistent supplier database, Actions cache, repository branch or site store. Temporary lookup JSON is used only within that run; the report artifact keeps its normal retention period. PCBWay publishes no parts API.

## Threads (optional)

With `[threads] enabled = true` and the review site, a reviewer starts a thread on a part or point of a changed sheet or board. Right-click the drawing, or press `c` and click. Each thread is a pull-request review comment on the `.kicad_sch` or `.kicad_pcb` file. Its first line names the part and position and links back to the exact view, so it reads well on GitHub too. Replies, @mentions, notifications and resolving all work on GitHub as for any review comment.

Every later review places the thread on the same part by its KiCad UUID, or by its reference if the UUID changed, and says when the part moved or was removed. A thread whose part is in neither revision shows as "Detached". Threads exist only on pull requests. They are file-level comments, so the review site places them from the anchor in the comment, not from GitHub's line position.

When thread collection succeeds, the pull request comment shows "Threads: N open (M blocking), K resolved". The counts cover only threads started from the review site, among the pull request's first 100 review threads. The offline report file shows no threads.

Threads are off by default. The site exposes them only on review pages for `pull_request` runs. The GitHub App needs Pull requests and Contents permissions (read and write); GitHub requires Contents write to resolve review threads. A 403 response shows a hint to ask the repository owner to accept those permissions. A rate-limit response shows "GitHub rate limit reached. Try again later." (429).

When enabled, the workflow's "Collect review threads" step reads the pull request's review threads with `gh api graphql` for the summary counts. If collection fails, the review continues without thread counts unless `threads.block_merge` is enabled, in which case the gate fails closed. Each blocking-thread create, resolve or reopen re-runs the whole review (about 2–3 Actions minutes); anyone with write access can trigger a re-run, so only writers can spend Actions minutes this way. GitHub requires a run no older than 30 days.

## Waivers (optional)

A waiver accepts one specific ERC, DRC, parity or fab-limit finding: for example a deliberate clearance under a connector shield. For fab limits, the same geometry is waived in both vendor sections, and waived counts remain visible; coverage uncertainty cannot be waived. BOM-field findings cannot be waived; fix their fields in the schematic. Waivers are off by default. Enable them with `enabled = true` under `[waivers]` in `kicad-review.toml` on the default branch. Settings still come from the review's base revision, so open pull requests pick up that setting after merging the default branch into their head.

Press **Waive…** on a finding in the report to get a TOML snippet, not an automatic waiver. Fill in `reason` and `by`, and add the entry to `kicad-review-waivers.toml` at the repository root through a separate pull request to the target branch. See the fully commented [example file](examples/kicad-review-waivers.toml). Once that merges, re-run the review that had the finding.

In GitHub Actions, waivers are read only from the current tip of the pull request's target branch (`origin/<base.ref>`), or the repository's default branch for push and manual-dispatch runs. They never apply from the change being reviewed, so a pull request cannot waive its own findings, and waivers merged later apply on re-run. Protect the target branch: anyone who can push directly to it can accept waivers without review. Direct pushes to the default branch already bypass review. For local CLI runs without `WAIVERS_REF`, the comparison's base revision is the fallback.

When a review includes KiCad changes, valid extra entries in its head file appear as "proposed" in the comment, not as active waivers (entries already active on the target branch are not repeated). A waiver-only pull request has no KiCad changes to review; its entries apply once it merges. Its comment shows **No KiCad changes**, not proposed entries.

A waived finding stays listed, tagged **WAIVED** with its reason, under the report's **Waived** filter, which appears when something is waived. It does not count toward `fail_on`; the comment's **Ready to merge?** block lists waived findings as not blocking. Each entry needs `until = <date>` or `permanent = true`. The `until` date is inclusive through that day in UTC; expiry starts the next UTC day. Malformed files warn and are ignored; invalid entries warn and are skipped without breaking the review. The comment lists invalid, expired and proposed entries, and waivers not matched in this review; these lists are not shown in the offline HTML report. An unmatched entry may belong to an unchanged project or a check that is off, so remove it only if its finding is gone. The file's git history records who accepted what and when.

Waiver keys have limits. Several unconnected items on one net are keyed by occurrence in KiCad's output, so fixing one can shift another's key, making its waiver stale or matching a different occurrence. A finding without part UUIDs uses a position-based fallback, so moving the part makes its waiver stale. Recheck these waivers after edits.

## Review site (optional)

The small Cloudflare Worker review site lets people sign in with GitHub and open reviews only in repositories they can already read. See [the site setup guide](site/README.md) to create the GitHub App, run it locally, and deploy it manually.

The review list can group pull-request reviews by GitHub milestone. Choose **Milestones** to see open and merged PR counts, review verdicts, and a link to each milestone. This view reads the latest 100 PRs live and needs the App's **Pull requests: read** permission; without it, the page shows permission guidance. Reviews join to the newest PR with the same head branch, so reused or same-named fork branches can be ambiguous. Manual comparisons and unmatched reviews appear under **No milestone**. No milestone data is stored.

Optional [read-only share links](site/README.md#share-links-optional) let writers share one expiring review with guests; they are off until the owner enables the required App permission and worker secrets.

Pull-request reviews have a **History** page: commits, approvals and change requests, review threads, and logged check results, newest first. Checks, Reviews, Threads and Commits filters narrow the timeline. Thread resolution is shown at creation time because GitHub supplies no resolution time. Waiver history is deferred until the waivers feature lands.

The check log is **off by default**. Alongside `KICAD_REVIEW_SITE`, set the calling repository's Actions variable `KICAD_REVIEW_HISTORY=true` to keep the newest 50 check-result rows in the existing bot comment. This adds a comments fetch on same-repository PR runs; forks do not fetch it. With the variable unset, comments and job summaries stay unchanged. History still shows commits, reviews and threads without the log.

Logged results outlive the 90-day reports; links disappear when their artifacts expire or are unavailable. Rows record errors (total and new), not warnings. Failed or cancelled runs add no row; failure and no-change comments carry the previous log. The log is editable by anyone who can edit the bot comment, not immutable. History trusts only the GitHub Actions bot's marked comment and reads the first 100 comments/threads and last 100 commits/reviews.

## When the workflow repository moves (for example to ParadigmEngineering)

The owner name appears in exactly one place per KiCad repository: the `uses:` line of its `.github/workflows/kicad-review.yml`.

1. Transfer this repository: *Settings → General → Transfer ownership*. Keep it public; it holds no secrets, and the minutes are always charged to the calling repository.
2. In the new location, push the `v1` tag again if the transfer did not carry it over (tags normally move with the repository).
3. In every KiCad repository, change
   `uses: Cameronrlewis/kicad-review/.github/workflows/review.yml@v1` to
   `uses: ParadigmEngineering/kicad-review/.github/workflows/review.yml@v1`.
   Do not rely on GitHub's redirect from the old name.
4. Update the organisation's Actions allow list (step 3 above) to the new name.
5. In this repository, replace `Cameronrlewis` in `README.md` and `examples/kicad-review.yml`.

The workflow finds its own scripts through `job.workflow_repository`, so nothing inside it needs editing.

If the repository has to become private instead, also set *Settings → Actions → General → Access* to "Accessible from repositories in the organisation".

## Cost on GitHub Free

Private repositories get 2,000 Actions minutes and 500 MB of artifact storage per month. Measured on the test repository:

- **Review run:** about 110 s, billed as 2 minutes. Pulling the 1.4 GB KiCad image takes 55–100 s of that; the KiCad work itself takes a few seconds.
- **Skipped run** (a push to a branch with an open pull request): about 15 s, billed as 1 minute.
- **Release run:** about 100 s.
- **Storage:** reports are kept 90 days. They are 1–3 MB each for a small project and about 3 MB for KiCad's 8-sheet `video` demo with one sheet and the board changed.

So roughly 900 reviews a month fit in the free minutes, shared by every private repository of the owner.

## Issues (optional)

Set `[issues] enabled = true` in `kicad-review.toml` to track located findings with **Track as issue**, or a discussion with **Create issue**. The review site creates a normal GitHub issue as the signed-in person, with the same KiCad anchor and a link back to the review and PR. A thread gets a “Tracked in #N.” reply. Open anchored issues appear as `#N` pins and in the Threads tab's **Issues** group on later reviews, including push and manual comparisons; removed objects pin to the base drawing. Pins open GitHub in a new tab.

This is off by default, independent of `[threads] enabled`. The site's GitHub App needs **Issues: read and write**; the owner must add it and each installation must accept it. Opted-in workflow callers must add `issues: read` to `permissions`. On pull-request runs only, the workflow reads the first 100 open repository issues and adds “Touches parts named in #12, #15.” when their anchored references changed. Without permission it warns and skips that line; the site explains a 403. Existing `v1` callers need no changes. Offline reports make no issue requests and offer no issue actions.

## How it works

`review.yml` runs one job on `ubuntu-24.04`.

1. It checks out the full history.
2. It resolves the two revisions:
   - pull request: head and its merge base
   - push: before and after the push
   - manual run: the two revisions typed in
3. It finds changed projects and checks out both revisions side by side as git worktrees.
4. It then runs, in the official `kicad/kicad:10.0.6-full` image pinned by digest:
   - `kicad-cli` for SVG renders, ERC and DRC with schematic parity
   - Gerber, drill, position and BOM export on tags
5. Everything else is `kicad_review.py`, which uses only the Python standard library, plus the review page in `ui/` (plain HTML, CSS and JavaScript), filled with the run's data in format v1:
   - parsing the KiCad files
   - matching objects by UUID, with the reference designator as fallback when a UUID was regenerated
   - matching violations between revisions
   - the report, the comment and the release files

**Comment pictures in private repositories.** Artifacts cannot be shown in a comment, and GitHub strips `data:` and inline-SVG images. So the run takes screenshots of the report with the runner's preinstalled Chrome. It pushes them to a separate branch, `kicad-review-assets` (a single commit rewritten each run, folders untouched for 30 days pruned), and links them as `https://github.com/<owner>/<repo>/raw/kicad-review-assets/…`. Repository members' browsers load these. This is the reason for `contents: write`. The workflow never writes to any other branch.

To update KiCad, change `KICAD_IMAGE` in `review.yml` to a new tag and its digest, taken from https://hub.docker.com/r/kicad/kicad/tags.

Run the self-check with `python3 test_kicad_review.py`.

## Schematic viewer

Schematics retain KiCad's exported drawing sheet and title block. Paper stays
warm white in both interface themes. The dot grid is 50 mil (1.27 mm), anchored
to the drawing origin; distant views omit intermediate dots for legibility.
Ctrl+U toggles schematic coordinates between mm and mil without moving the view.
PageUp/PageDown visit the previous/next sheet by page number; Alt+Up visits the
parent. The hierarchy shows Name (page n), with the active sheet in bold.

Schematic colours use an exact-value map from KiCad's default SVG palette.
Roles with the same exported RGB value stay linked. Unknown/custom export
colours are preserved. Schematic diff outlines and recolour/hatch marks use
changed bounding regions because CLI SVG paths do not carry object UUIDs.
Existing reports without sheet renders still show the no-render message.

## Board viewer

New reports can draw both board revisions with retained **WebGL2** geometry. The board
background remains KiCad navy in either chrome theme. Side by side shares one camera;
Appearance provides **Layers**, **Objects**, and **Nets**, including layer eyes, colour and
alpha, active-layer promotion, net highlighting, Normal/Dim/Hide inactive layers, and
horizontal-only flip. Active B.Cu does not itself flip the board.

Drag with the left, middle, or right button to pan; wheel/trackpad zoom anchors at the
pointer. Click an object to select its change; right-click without dragging places a
thread pin when online threads are enabled. Pointer coordinates and delta, units, zoom,
and physical grid spacing appear in the status bar. Native input controls keep their
editing keys; shortcuts act when focus is outside inputs and open dialogs.

| Board shortcut | Action |
|---|---|
| Home / Ctrl+0 | Fit both revisions |
| F1 / F2, Ctrl+plus / Ctrl+minus | Zoom in / out |
| F4 | Centre at pointer |
| Ctrl+U | Cycle mm / mil / inches (camera stays in mm) |
| Page Up / Page Down | Activate F.Cu / B.Cu |
| + / − | Next / previous declared layer |
| H | Normal → Dim → Hide inactive layers |
| N / Shift+N | Next / previous physical grid spacing; show grid |
| { / } | Decrease / increase active-layer opacity |
| ? | Shortcut sheet |

The default PCB grid spacing is **0.5 mm**, matching KiCad 10's
`common/settings/app_settings.cpp` default PCB grid index 15. The Objects tab toggles
grid visibility. Tracks, vias, pads and filled shapes default to 100% opacity; zones and
images to 60%. Images, ratsnest, DRC markers and drawing-sheet rows explain when data
is unavailable. Validated per-viewer appearance persists under localStorage key
`kr.appearance.v1`; **Reset to KiCad defaults** restores the initial settings. Blocked
storage does not prevent viewing.

### Geometry, text and fallback

Optional `project.board.geometry = {base, head}` contains gzip/base64 **blob IDs**, not
nested scenes; either revision may be `null`. Decoded JSON has its own `version: 1`,
`units: "um"`, integer-micrometre bounds and dimensions (angles in millidegrees), declared
layers/nets and drawable objects. `uuid` identifies the child; `changeUuid` identifies its
owning semantic object; `changeIds` preserves report change links. Identical serialized
scenes deduplicate through the existing blob store. Camera/hash `x`, `y` and `z` remain
millimetres and CSS pixels per millimetre, independent of display units.

Supported drawings include segments, tessellated arcs, vias, circle/rect/oval/roundrect/
trapezoid pads, supported custom pad rings and layer-specific pad primitives, round or
slotted drills, footprint transforms, lines/polygons, stored zone fills with holes and
islands, and text. Zone outlines without stored fills are not invented copper. Text uses
a **system monospace glyph atlas**, not KiCad's exact stroke font; glyph shapes/spacing
are an approximation and unsupported glyphs use a replacement. No external font or
texture is downloaded.

A current browser needs WebGL2 with stencil support plus the native gzip
`DecompressionStream` API for geometry. Unsupported drawable types make that revision
incomplete: the **authoritative KiCad-exported SVG** is retained, not a partially drawn
WebGL board. Old reports, invalid scenes, unavailable WebGL2 and context loss also use
SVG with a diagnostic and reduced Appearance controls. Existing SVG Side, Overlay,
Wipe, Blend and Semantic comparisons remain available. Stage 4 supplies geometry and
Appearance; Stage 5 enables the new WebGL diff compositor (already integrated in this
branch). This does not claim the later change-mark styling is complete.

### Local board proof

Generate an offline report with the normal `detect`, `render`, `report` pipeline and
supply its absolute path. The default sample suite deliberately skips the hardware
performance gate; **a skip is not performance evidence**. Explicit measurement is strict
about two complete WebGL revision scenes and runs three six-second pan/zoom samples,
each with a one-second warm-up. Every warm run must reach 50 FPS with both scenes
drawn and no geometry or net-texture uploads. Evidence includes counts, viewport/DPR,
frame-interval p95, CPU submission time, and a separate `gl.finish()` diagnostic. rAF
measures scheduled draws, not guaranteed GPU completion. No performance claim is made
without passing measurements on the target board and machine.

```sh
CHECK_PERF=1 CHECK_PORT=9386 CHECK_TIMEOUT=60000 CHECK_WALL_TIMEOUT=120000 \
  timeout 150 node ui/check.mjs 'board fps two revisions' --no-skip --page "$REPORT"
CHECK_PORT=9386 CHECK_TIMEOUT=60000 timeout 120 node ui/check.mjs \
  'board proof Layers Normal' --page "$REPORT" --shot "$SHOT"
# Also: Objects, Nets, Dim, Hide, Flip, active B.Cu; add --dark for chrome theme.
# Repeat the FPS gate with --dpr 2 for a separate robustness measurement.
# --offline blocks HTTP(S), and fails any attempted external resource request.
```

The harness uses headless Chrome, ANGLE SwiftShader, 1920×1080 and DPR1 by default.
Keep generated reports, measurement logs and screenshots outside the repository.
The added offline payload target is at most 1,500,000 raw HTML bytes versus the
pre-renderer report for identical inputs/settings, including base64 scenes and assets;
compressed geometry size alone is not the budget.

## Developing the review page

Open `ui/review.html` in a browser: it loads real data from `ui/sample/review-data.js`.
Run the page checks with `node ui/check.mjs` (headless Chrome; set `CHROME=` to its path on Linux),
or `node ui/check.mjs --dark` for the dark theme. Run the site checks with `node --import ./site/css-loader.mjs --test site/test.mjs`.

To refresh the sample, take the data out of any generated report (a CI artifact or a local run of
`detect`, `render` and `report`):

```sh
python3 -c "import re; h = open('kicad-review.html', encoding='utf-8').read(); open('ui/sample/review-data.js', 'w', encoding='utf-8').write(re.search(r'(window\.REVIEW_DATA = .*?;)\s*</script>', h, re.S).group(1) + '\n')"
```

### Data format

The workflow and the page share one contract, `window.REVIEW_DATA` (`version: 1`): `repo`; `links`
(`review`, `base`, `head`, `run` — github.com URLs, empty outside Actions); `base`, `head`, `reason`;
`settings`; `projects[]` (all projects, changed first and unchanged afterward), each with `sheets[]`
(UUID `path`, `parent`, `status`, `size` in mm and `svg.base`/`svg.head` blob ids for every sheet), `board` (`changed`, `status`, `size`, `layers[]` with
`changed` and blob ids), `changes[]` (`id`, `action`, `kind`, `ref`, `where`, `pos`, `pos_before`, `box`,
and `changes` or `props`) and `checks[]` (counts and `violations[]` with `id`, `new`, `severity`, `pos`,
`box`, `where`); and `blobs` (gzip + base64 SVG text, optional board-scene JSON, and opted-in GLB bytes). When `3d.enabled` is true
on every review, `board.model3d` has base/head GLB blob ids (or `null`), `enabled`, `changed`, and
an `errors` map for unavailable exports, and `board.no_model` lists `{ref, side, reason}` entries (`file not found` or `no model in
footprint`). Positions and boxes are drawing millimetres.

Unchanged sheets, board layers (including blank layers), board geometry, and enabled 3D views remain
available at both revisions. The viewer labels these views “No layout changes”, “No schematic changes
on this sheet”, or “No 3D changes” without hiding the design. Identical board/model inputs share one
GLB export, including its generated timestamp. Actions caches rendered outputs per commit, project,
settings, KiCad image, and tool version; a complete warm hit avoids starting the KiCad container.

Library review (`[libraries] enabled = true`) covers only library files inside the project folder. Nicknames come from the file name (`Parts.kicad_sym` or `Parts.pretty` means `Parts`); library tables and external libraries are not resolved. Footprint item names come from `.kicad_mod` file stems, including legacy KiCad `module` files; symbol item names come from their declarations without a library prefix. For placed-part usage, exact library IDs win. When a placed part's nickname is not a local library, its item name is matched only if exactly one local library across the compared revisions contains that item of the same kind. This supports renamed or global nicknames without guessing when names are ambiguous, including duplicates in unchanged local libraries. All symbol units contribute pins; the drawing shows unit 1. Pad removals or renumbering and symbol electrical-type changes warn when placed parts use the item.
With waivers enabled, format v1 adds `violations[].waiver_key`, `violations[].waived` for matched findings, `checks[].waived` counts on waivable checks, and top-level `waivers` lists (`stale`, `expired`, `proposed`, `invalid`); these additive fields are absent when waivers are off.

# kicad-review

A reusable GitHub Actions workflow for KiCad 10 projects. Whenever someone changes a KiCad project it shows what changed on the actual schematic and board, not in the S-expression text. Everything runs inside GitHub Actions and appears inside GitHub. There is no server, no web app and no secret beyond the token GitHub gives every run, and access is whatever the repository already allows.

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

**On a `v*` tag**, Gerbers and drill files (one zip), a BOM and a position file per project are attached to the GitHub release, in JLCPCB or PCBWay format.

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
| `checks.release` | `"off"` | as above; builds and checks the fabrication package (adds about 2–4 s per board) |
| `bom.required_fields` | `["Value", "Footprint"]` | symbol fields every BOM part must have (DNP and excluded-from-BOM parts are skipped) |
| `bom.critical_prefixes` | `["U", "J", "Q", "D", "Y", "X", "K", "F"]` | reference prefixes whose datasheet coverage is shown separately |
| `bom.order_ready_fields` | preset's fields | fields every part needs to count as order-ready (JLCPCB: Value, Footprint, LCSC; PCBWay: Value, Footprint, MPN) |
| `fabrication.preset` | `"jlcpcb"` | `jlcpcb` or `pcbway` |
| `fabrication.part_field` | `LCSC` / `MPN` | symbol field holding the supplier part number |
| `3d.enabled` | `false` | export each changed board revision as a GLB and record footprints with missing 3D models; failed exports are recorded without failing the review |
| `parts.enabled` | `false` | show the parts list and its changes in the Parts tab and pull request comment |
| `threads.enabled` | `false` | pin discussion threads to parts and points in the review site; they are stored as pull-request review comments |
| `inventory.enabled` | `false` | add an "All parts" list to the report's Changes tab: every symbol and footprint, searchable, click to zoom |
| `libraries.enabled` | `false` | Review local symbol and footprint libraries: drawings, pin/pad changes, used-by references, and warnings |
| `github.check_runs` | `false` | also publish one GitHub check run per check (`kicad-review / ERC`, `… / DRC`, …); the caller needs `checks: write` |
| `threads.block_merge` | `false` | fail the review while any blocking thread is open; needs `threads.enabled`; creating, resolving or reopening a blocking thread in the review site re-runs the review |
| `waivers.enabled` | `false` | read `kicad-review-waivers.toml`; a waived ERC, DRC or parity finding stays listed but no longer fails its check |

With `checks.release` on, each review also builds the fabrication package for the chosen preset and checks it: a Gerber for every copper layer and the outline, mask and paste on sides with SMD parts, drill files when the board has holes, a position file when SMD parts are fitted, and BOM and position file agreeing on references. Tagged releases also get a `SHA256SUMS` file so the files sent to the fab can be checked against the release.

For pull requests the base revision's settings file wins, so a change cannot relax the checks it is judged by. Only when the base has no settings file is the head's copy used.

Set the Actions variable `KICAD_REVIEW_SITE` to your companion review site's URL to make review comments link to its report page.

## Parts (optional)

Set `enabled = true` under `[parts]` in `kicad-review.toml` (default: `false`). The Parts tab and pull request comment section list each distinct part's value, footprint, references, LCSC number and manufacturer part number, with a datasheet link from the symbol's `Datasheet` field (http/https only). They flag missing or malformed LCSC numbers and one LCSC number used on several values, and show which parts the change added, removed, swapped to another LCSC number, or gave a new value or footprint.

Add an `LCSC` field to each symbol for its JLCPCB part (for example `C17414`), and `Manufacturer_Part_Number` for the PCBWay BOM. Optionally add `"LCSC"` to `bom.required_fields` to require it. It also shows BOM coverage per field (with the change from base), field-by-field edits per reference, placeholder values such as `TBD`, one MPN used on several footprints, and parts that are DNP on only one of schematic and board.

Recognised field names (case-insensitive):

- LCSC: `lcsc`, `lcsc part`, `lcsc part #`, `lcsc part number`, `jlcpcb part #`.
- Manufacturer part number: `mpn`, `manufacturer_part_number`, `manufacturer part number`, `mfr. part #`, `mfg part #`.

Supplier stock/price is not yet available; a JLCPCB Components API lookup at workflow time is planned and needs approved API access. Today nothing is sent to any supplier, and no supplier API secret is needed. PCBWay publishes no parts API.

## Threads (optional)

With `[threads] enabled = true` and the review site, a reviewer starts a thread on a part or point of a changed sheet or board. Right-click the drawing, or press `c` and click. Each thread is a pull-request review comment on the `.kicad_sch` or `.kicad_pcb` file. Its first line names the part and position and links back to the exact view, so it reads well on GitHub too. Replies, @mentions, notifications and resolving all work on GitHub as for any review comment.

Every later review places the thread on the same part by its KiCad UUID, or by its reference if the UUID changed, and says when the part moved or was removed. A thread whose part is in neither revision shows as "Detached". Threads exist only on pull requests. They are file-level comments, so the review site places them from the anchor in the comment, not from GitHub's line position.

When thread collection succeeds, the pull request comment shows "Threads: N open (M blocking), K resolved". The counts cover only threads started from the review site, among the pull request's first 100 review threads. The offline report file shows no threads.

Threads are off by default. The site exposes them only on review pages for `pull_request` runs. The GitHub App needs Pull requests and Contents permissions (read and write); GitHub requires Contents write to resolve review threads. A 403 response shows a hint to ask the repository owner to accept those permissions. A rate-limit response shows "GitHub rate limit reached. Try again later." (429).

When enabled, the workflow's "Collect review threads" step reads the pull request's review threads with `gh api graphql` for the summary counts. If collection fails, the review continues without thread counts unless `threads.block_merge` is enabled, in which case the gate fails closed. Each blocking-thread create, resolve or reopen re-runs the whole review (about 2–3 Actions minutes); anyone with write access can trigger a re-run, so only writers can spend Actions minutes this way. GitHub requires a run no older than 30 days.

## Waivers (optional)

A waiver accepts one specific ERC, DRC or parity finding: for example a deliberate clearance under a connector shield. BOM-field findings cannot be waived; fix their fields in the schematic. Waivers are off by default. Enable them with `enabled = true` under `[waivers]` in `kicad-review.toml` on the default branch. Settings still come from the review's base revision, so open pull requests pick up that setting after merging the default branch into their head.

Press **Waive…** on a finding in the report to get a TOML snippet, not an automatic waiver. Fill in `reason` and `by`, and add the entry to `kicad-review-waivers.toml` at the repository root through a separate pull request to the target branch. See the fully commented [example file](examples/kicad-review-waivers.toml). Once that merges, re-run the review that had the finding.

In GitHub Actions, waivers are read only from the current tip of the pull request's target branch (`origin/<base.ref>`), or the repository's default branch for push and manual-dispatch runs. They never apply from the change being reviewed, so a pull request cannot waive its own findings, and waivers merged later apply on re-run. Protect the target branch: anyone who can push directly to it can accept waivers without review. Direct pushes to the default branch already bypass review. For local CLI runs without `WAIVERS_REF`, the comparison's base revision is the fallback.

When a review includes KiCad changes, valid extra entries in its head file appear as "proposed" in the comment, not as active waivers (entries already active on the target branch are not repeated). A waiver-only pull request has no KiCad changes to review; its entries apply once it merges. Its comment shows **No KiCad changes**, not proposed entries.

A waived finding stays listed, tagged **WAIVED** with its reason, under the report's **Waived** filter, which appears when something is waived. It does not count toward `fail_on`; the comment's **Ready to merge?** block lists waived findings as not blocking. Each entry needs `until = <date>` or `permanent = true`. The `until` date is inclusive through that day in UTC; expiry starts the next UTC day. Malformed files warn and are ignored; invalid entries warn and are skipped without breaking the review. The comment lists invalid, expired and proposed entries, and waivers not matched in this review; these lists are not shown in the offline HTML report. An unmatched entry may belong to an unchanged project or a check that is off, so remove it only if its finding is gone. The file's git history records who accepted what and when.

Waiver keys have limits. Several unconnected items on one net are keyed by occurrence in KiCad's output, so fixing one can shift another's key, making its waiver stale or matching a different occurrence. A finding without part UUIDs uses a position-based fallback, so moving the part makes its waiver stale. Recheck these waivers after edits.

## Review site (optional)

The small Cloudflare Worker review site lets people sign in with GitHub and open reviews only in repositories they can already read. See [the site setup guide](site/README.md) to create the GitHub App, run it locally, and deploy it manually.

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
`settings`; `projects[]`, each with `sheets[]` (UUID `path`, `parent`, `status`, and for changed sheets
`size` in mm and `svg.base`/`svg.head` blob ids), `board` (`changed`, `status`, `size`, `layers[]` with
`changed` and blob ids), `changes[]` (`id`, `action`, `kind`, `ref`, `where`, `pos`, `pos_before`, `box`,
and `changes` or `props`) and `checks[]` (counts and `violations[]` with `id`, `new`, `severity`, `pos`,
`box`, `where`); and `blobs` (gzip + base64 SVG text, and opted-in GLB bytes). When `3d.enabled` is true
and an export runs, `board.model3d` has base/head GLB blob ids (or `null`), `board.model3d_failed` marks
failed exports, and `board.no_model` lists `{ref, side, reason}` entries (`file not found` or `no model in
footprint`). Positions and boxes are drawing millimetres.

Library review (`[libraries] enabled = true`) covers only library files inside the project folder. Nicknames come from the file name (`Parts.kicad_sym` or `Parts.pretty` means `Parts`); library tables and external libraries are not resolved. Footprint item names come from `.kicad_mod` file stems, including legacy KiCad `module` files; symbol item names come from their declarations without a library prefix. For placed-part usage, exact library IDs win. When a placed part's nickname is not a local library, its item name is matched only if exactly one local library across the compared revisions contains that item of the same kind. This supports renamed or global nicknames without guessing when names are ambiguous, including duplicates in unchanged local libraries. All symbol units contribute pins; the drawing shows unit 1. Pad removals or renumbering and symbol electrical-type changes warn when placed parts use the item.
With waivers enabled, format v1 adds `violations[].waiver_key`, `violations[].waived` for matched findings, `checks[].waived` counts on waivable checks, and top-level `waivers` lists (`stale`, `expired`, `proposed`, `invalid`); these additive fields are absent when waivers are off.

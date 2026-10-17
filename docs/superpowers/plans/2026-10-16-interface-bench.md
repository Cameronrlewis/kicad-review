# Interface redesign "Bench" — implementation plan

> For agentic workers: each task goes to its own general-purpose agent (model sonnet, effort medium) that first invokes `ui-ux-pro-max:ui-ux-pro-max` and `ui-ux-pro-max:ui-styling`. Tasks after Task 1 run in parallel.

**Goal:** Replace the whole interface frame of kicad-review (opening screens, header, review bar, toolbar, left and right docks, inspector, status bar) with the owner-approved direction A "Bench", keeping the drawing area KiCad-authoritative.

**Architecture:** One shared token/identity layer (ui/tokens.css + ui/icons) used by the site (site/pages.js, site.css) and the report (ui/review.html/css/js). The site's review page becomes a thin frame (header + review bar) around the report iframe; the report owns toolbar, docks, inspector and status bar. Nothing is shown twice: when the report runs framed inside the site, its own header row is hidden and the site header/review bar carry that information; when opened offline, the report shows the same header + review bar itself.

**Tech stack:** plain HTML/CSS/vanilla JS, CSS custom properties, inline SVG icon sprite, system fonts only. No framework, no component library.

**Design source (binding):** ~/Code/kicad-review-ui-reference/directions/a-instrument/ (README.md tokens/type/layout, review.html, start.html and screenshots). Owner requirements: the owner's message of 2026-10-16 (summarised in Global constraints).

## Global constraints
- Exactly one header: mark, breadcrumb (repository › PR/review), one review-status readout, user menu containing Theme (Dark / Light / System). No second Theme button anywhere.
- Exactly one review bar: BASE → HEAD chips, PR link, run result, merge readiness as ONE badge that opens a 3-row popover (latest review, GitHub approval, blocking threads). No full-width readiness banners.
- Toolbar groups View / Change (prev, n of N, next) / Zoom (out, %, in, fit) / Marks (Outline, Recolour); icon + short label + tooltip; History, Share, Copy link and Go to move into the review bar overflow menu or the header menu; nothing cut off at 1440×900.
- Left dock tabs: Project (tree of project, sheets, board, 3D, libraries; full names wrap, never silently cut; change chips by shape + glyph) and Appearance (existing Layers/Objects/Nets panel restyled to Bench).
- Right dock tabs Changes, Checks, Parts, Threads: resizable by splitter, collapsible, widen-to-700 button, Parts/Checks open a full-width table view. Compact rows; refs as ranges (C1–C5, C20) with full list on hover; problems as small tags with hover text; BOM coverage as one compact strip.
- Inspector (bottom of the drawing, collapsible): every property of the selected object, base → head diff.
- Status bar like KiCad: X/Y in chosen units, dx/dy, grid, zoom, units, active layer, selected object, view mode, `?` shortcut overlay.
- Depth: splitter-resizable docks with persisted sizes, right-click context menus on canvas and list rows, keyboard shortcut overlay, real tooltips, search + sort + filter + group on every list.
- Start page: quick actions (open latest PR review, compare commits, open repository, paste review link), recent reviews table with LED/check chips/readiness, repositories with latest status, activity. Repositories and reviews pages share the identity.
- 1440×900: docks collapse; no horizontal page scroll. Dark and light both AA.
- Keep: comment pins, deep links (p v m x y z s t l c h, and t=appearance), change list, offline single-file report, all modes, mark styles, site CSP and iframe sandbox, share security.
- Commits: no Co-Authored-By line, no "Generated with Claude Code" line. New browser checks appended at END of CHECKS.

## Tasks
1. **Identity foundation** — ui/tokens.css rewritten to Bench tokens (dark + light, AA verified), type scale, spacing (header 36, review bar 34, toolbar 34, status 24), ui/icons sprite (16 px stroke set from the mock-up), product mark; site/site.css and ui/review.css consume them. Proof: token contrast check; existing screens still render.
2. **Header + review bar + merge badge** (site/pages.js reviewPage/sharedPage frame, report header when offline) — one header, one review bar, readiness popover; remove readiness banners and duplicate rows; user menu with Theme; overflow menu (History, Share, Copy link, Go to, Open run).
3. **Toolbar** (ui/review.html/js/css) — four groups with icons, tooltips, nothing cut at 1440; dock toggles at the right end.
4. **Left dock** — tabbed Project / Appearance, full-name wrapping tree, shape-glyph chips, search/sort/filter.
5. **Right dock** — splitter resize (persisted), collapse, widen-to-700, full-width table view for Parts and Checks, compact Parts rows (ref ranges, tags with hover), BOM coverage strip.
6. **Inspector** — bottom dock under the drawing, collapsible, every property with base → head diff; replaces per-card property dumps where duplicated.
7. **Status bar + shortcut overlay + context menus + tooltips** — KiCad-like status fields; `?` overlay; right-click menus on canvas and rows.
8. **Opening screens** — start page, repositories, reviews list, compare commits in Bench.
9. **Proof** — the owner's judging steps 1–4 and 10 with screenshots at 1440×900 and 1920×1080, both themes, next to the mock-up and KiCad references; full browser suite once per theme; site and Python suites.

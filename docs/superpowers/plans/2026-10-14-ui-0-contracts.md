# UI redesign — cross-stage contracts

Binding for stages 1–7. Where a stage plan names an interface differently,
this file wins; the executor ledgers the rename as a ruling.

## Theme (owner: Stage 1)
- `window.KRTheme.get(): 'dark'|'light'`
- `window.KRTheme.set(theme, {persist?, broadcast?}={}): void` — persists to `localStorage['kr.theme']` (try/catch).
- DOM event `kr-theme-change`, `detail: 'dark'|'light'`; toggle buttons carry `[data-theme-toggle]`.
- Wrapper → sandboxed report iframe: `postMessage({kicadReviewTheme})`.
- Stage 2 (site screens) and Stage 3 (report chrome) consume exactly this; they add no theme code of their own.

## Appearance (owner: Stage 4; extended by 5 and 7)
One global store, `window.Appearance`:
- `get(): AppearanceState` — validated snapshot.
- `patch(partial): AppearanceState` — validates, persists to `localStorage['kr.appearance.v1']` (try/catch), notifies.
- `subscribe(fn): () => void`.
- `reset(): AppearanceState` — KiCad defaults (`KicadColors.themeDefaults`).
- Stage 4 keeps `boardAppearance()` and `changeBoardAppearance(p)` only as one-line aliases of `get()` / `patch(p)`.
- Stage 5 adds field `markStyle: 'outline'|'recolour'` (default `'outline'`).
- Stage 7 adds `import(text): AppearanceState` (throws `ThemeImportError`, applies nothing on error) and the presets UI. Stage 7's `createStore` is the implementation behind `window.Appearance`, not a second store; `validateState`, `parseTheme`, `markPalette`, `parseColor`, `contrast` are its helpers.

## Renderers
- Board: `BoardGL.create(canvas, opts) -> BoardGL|null` (null = no WebGL2, SVG fallback). `boardGL.setAppearance(state)` is the only way colours, opacity, visibility, high contrast and flip reach the renderer. `draw({mask?, ...})` and `hitTest(point) -> object[]` with `object.changeIds` retained (Stage 5).
- Schematic: Stage 6 `themeSchematic(svg)` recolours via CSS variables `--sch-ink-<hex>`; Stage 7 sets those variables from `Appearance.get()` (the plan's `SchematicTheme.setAppearance` is this).

## Shared camera
`S.x`, `S.y` (mm, viewport centre), `S.z` (px/mm) stay the single camera; board, schematic and status bar read it. Hash keys `p v m x y z s t l c h` unchanged.

## Open ruling for owner review
Board text uses a system monospace glyph atlas, not KiCad's stroke font; exact stroke glyphs would need a separate font-licence decision.

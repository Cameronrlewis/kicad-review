# Task S6 Evidence: Downloads by Manifest Record; Errors Keep Cleanup and Cookies (Findings 8, 9)

## 1. Non-Empty Review Range (Finding 1)

The implementation of Task S6 fixes was completed across branch commits:
- `4d621cc` fix(site): select downloads by manifest record and keep cookies on form and user errors
- `d413aa0` fix(site): fail closed on unprefixed manifest paths and deduplicate callback error

Branch range containing Task S6 fixes:
`19765c1..d413aa0` (commits `4d621cc`, `d413aa0`).
Base before fix commits: `19765c11626081d33c87d83bb2f0a471d7b35f71`.
Current branch HEAD: `909194ce40cb683e44147b70b7477afd74464684`.

## 2. RED-to-GREEN Regression Evidence (Finding 2)

Both findings reproduce as failures (RED) on pre-fix code (baseline `19765c1`), and both pass (GREEN) on post-fix code.

Reproduction runner command:
```bash
# Pre-fix baseline test (RED, exit code 1)
node --import ./site/css-loader.mjs .superpowers/sdd/overnight-site-fixes/run-repro-s6.mjs --baseline

# Post-fix HEAD test (GREEN, exit code 0)
node --import ./site/css-loader.mjs .superpowers/sdd/overnight-site-fixes/run-repro-s6.mjs
```

### Finding 8: Downloads selected by extension instead of signed manifest record
- **Scope:** `site/worker.js` (`downloadFile` route)
- **Pre-fix Baseline RED:**
  - Expected: `404 Not Found` (`{ error: 'Download unavailable' }`)
  - Actual: `200 OK` (`Stale PDF export should return 404, got 200`)
  - Cause: Pre-fix code filtered entries solely using filename regex (`e.name.startsWith("${index}/") && suffix.test(e.name)`), ignoring `downloads.json` manifest records. When a manifest recorded a failed export (`{ kind: 'pdf', error: 'export failed' }`), pre-fix served stale `0/old.pdf` with status 200. Similarly, unlisted entries with path or size mismatches were served without checking manifest declared path or bytes.
- **Post-fix GREEN:**
  - Output: `PASS`
  - Verification: `downloadFile` parses `manifest.files`, matches exactly one record with `kind === kind && !record.error`, enforces path prefix `${index}/`, checks safe filename and suffix regex, validates declared byte size, and verifies that the ZIP central-directory entry matches the record path and byte size. Unlisted, failed, path-mismatched, or size-mismatched entries return 404.

### Finding 9: Uncaught body/API errors bypass route cleanup and refreshed cookies
- **Scope:** `site/worker.js` (`compare`, `callback`)
- **Pre-fix Baseline RED:**
  - Expected: `400 Bad Request` with renewed session cookie `s` on compare; `502 Bad Gateway` with cleared `st` cookie on OAuth callback error
  - Actual: `Failed to parse body as FormData.` uncaught in `compare`, escaping to outer handler catch returning generic 500 without refreshed session cookie `s`; uncaught `/user` fetch/JSON error in `callback` escaping to outer 500 without clearing `st` cookie
  - Cause: In pre-fix code, `request.formData()` in `compare` was not wrapped in try-catch. When parsing failed on a malformed multipart body after token rotation in `access()`, the uncaught error escaped to the outer handler catch, returning anonymous 500 and dropping the renewed session cookie `s`. In `callback`, `gh('/user')` and `userResponse.json()` were not wrapped, escaping to outer 500 and leaving the `st` cookie uncleared after consuming the authorization code.
- **Post-fix GREEN:**
  - Output: `PASS`
  - Verification: In `compare`, `request.formData()` is wrapped in try-catch and returns `errorPage(400, ..., allowed.s)`, preserving the renewed session cookie `s`. In `callback`, `/user` fetch and JSON parsing are wrapped in try-catch and call `signinError()`, returning 502 while clearing the `st` cookie via `Set-Cookie: st=; ... Max-Age=0`.

## 3. Test Suite Verification

- `node --import ./site/css-loader.mjs --test site/test.mjs`: 349/349 passed
- `node --test ui/image-view.test.mjs`: 57/57 passed
- `python3 test_kicad_review.py`: passed (exit 0)

# Task S5 Evidence: Bounded GitHub List Pagination (Findings 6, 7, 10, 11, 12)

## 1. Non-Empty Review Range (Finding 1)

The implementation of Task S5 fixes was completed across branch commits:
- `b4f8b29` fix(site): paginate GitHub list reads and prefer the newest review per head
- `5582794` fix(site): permit overflow on GET issues and paginate home artifacts
- `a3e89a0` fix(site): paginate review threads in readiness route
- `19765c1` fix(site): return 200 with empty list when review threads are missing

Branch range containing Task S5 fixes:
`7a02f45..19765c1` (commits `b4f8b29`, `5582794`, `a3e89a0`, `19765c1`).
Base before fix commits: `62fea5f26698b6ad14ac1cabd2242f8994991e79`.

## 2. RED-to-GREEN Regression Evidence (Finding 2)

All five findings reproduce as failures (RED) on pre-fix code (baseline `7a02f45`), and all five pass (GREEN) on post-fix code.

Reproduction runner command:
```bash
# Pre-fix baseline test (RED, exit code 1)
node --import ./site/css-loader.mjs .superpowers/sdd/overnight-site-fixes/run-repro-s5.mjs --baseline

# Post-fix HEAD test (GREEN, exit code 0)
node --import ./site/css-loader.mjs .superpowers/sdd/overnight-site-fixes/run-repro-s5.mjs
```

### Finding 6: Completed runs omit reports beyond GitHub's first 30 artifacts
- **Scope:** `site/worker.js` (`run` route)
- **Pre-fix Baseline RED:**
  - Expected: `302 Found` (redirect to report artifact `/r/Cameronrlewis/repo/a/56?pdf=1`)
  - Actual: `200 OK` (`Expected status 302, got 200`)
  - Cause: Pre-fix `run()` queried unparameterized `/actions/runs/${id}/artifacts` (default 30 per page). The report was located at index 100 (after 100 filler artifacts). Pre-fix code missed the report and rendered the status page (200) instead of redirecting (302).
- **Post-fix GREEN:**
  - Output: `PASS`
  - Verification: `ghPages` paginates up to 10 pages of 100 artifacts each, discovers artifact 56, redirects with 302, and rejects ambiguous matching reports with 404.

### Finding 7: Merge readiness ignores reviews past 100
- **Scope:** `site/readiness.js` (`readinessRoute`)
- **Pre-fix Baseline RED:**
  - Expected: `ann` state `CHANGES_REQUESTED`
  - Actual: `ann` state `APPROVED` (`state: 'APPROVED' !== 'CHANGES_REQUESTED'`)
  - Cause: Pre-fix code fetched only page 1 (`/pulls/${number}/reviews?per_page=100`). Reviewer `ann` approved on page 1 and submitted `CHANGES_REQUESTED` on page 2. Pre-fix code stopped at page 1 and reported stale approval.
- **Post-fix GREEN:**
  - Output: `PASS`
  - Verification: `readinessRoute` uses `ghPages` to paginate all review pages before `latestDecisions()` computes reviewer state.

### Finding 10: Commit history links oldest review for repeatedly reviewed head
- **Scope:** `site/worker.js` (`commitsData`)
- **Pre-fix Baseline RED:**
  - Expected: commits page links newest review artifact `/a/20`
  - Actual: `AssertionError [ERR_ASSERTION]: Missing link to newest review artifact /a/20`
  - Cause: `byHead` was built using `new Map(reviewList.map(...))`. Iterating newest-first caused subsequent older artifacts with the same 7-character head to overwrite newer ones in the map.
- **Post-fix GREEN:**
  - Output: `PASS`
  - Verification: `byHead` uses `if (!byHead.has(key)) byHead.set(key, item)`, preserving the first (newest) review.

### Finding 11: Thread listing silently truncates threads and comments
- **Scope:** `site/threads.js` (`threadsRoute`, `loadReviewThreads`)
- **Pre-fix Baseline RED:**
  - Expected: 101 threads returned, comment 51 present
  - Actual: `AssertionError [ERR_ASSERTION]: 100 !== 101`
  - Cause: GraphQL query requested first 100 threads without cursor pagination, and did not paginate comments beyond the first 50.
- **Post-fix GREEN:**
  - Output: `PASS`
  - Verification: `loadReviewThreads` cursor-paginates `reviewThreads` up to 10 pages, paginates comments on anchored threads up to 10 pages, and returns 502 (fails closed) if truncated.

### Finding 12: Duplicate issue prevention examines only first 100 open issues
- **Scope:** `site/issues.js` (`issuesRoute`, `loadIssues`)
- **Pre-fix Baseline RED:**
  - Expected: `409 Conflict` (existing issue with matching anchor found on page 2)
  - Actual: `201 Created` (`Expected 409 duplicate conflict, got 201`)
  - Cause: Pre-fix `loadIssues` only fetched page 1 (`/issues?state=open&per_page=100`). It failed to see the existing anchored issue on page 2 and allowed creation of a duplicate issue.
- **Post-fix GREEN:**
  - Output: `PASS`
  - Verification: `loadIssues` paginates open issues across pages. Duplicate conflict is caught and returned as 409. Fails closed with 502 on scan overflow.

## 3. Test Suite Verification

- `node --import ./site/css-loader.mjs --test site/test.mjs`: 349/349 passed
- `node --test ui/image-view.test.mjs`: 57/57 passed
- `python3 test_kicad_review.py`: passed (exit 0)

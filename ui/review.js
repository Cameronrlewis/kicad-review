"use strict";
// KiCad review page. Data contract: window.REVIEW_DATA, format v1 (see docs/superpowers/plans/2026-10-07-review-ui.md §A5).
const D = window.REVIEW_DATA;
const $ = s => document.querySelector(s);
window.reviewReady = true;

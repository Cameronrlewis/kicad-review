window.REVIEW_DATA = {
  version: 1, repo: "example/parts", base: "base", head: "head", reason: "Parts fixture",
  links: {}, blobs: {}, projects: [{
    name: "Parts", dir: "", status: "modified", sheets: [], changes: [], checks: [],
    board: { changed: false, layers: [] },
    parts: {
      supplier: { fetched_at: "2026-10-08T14:02:00Z", error: null },
      lines: [
        { key: "ok", refs: ["R1"], value: "10k", footprint: "R_0603", lcsc: "C17414", mpn: "RC0603", datasheet: "https://example.com/part.pdf", problems: [], status: "ok", stock: 1200000, price: 0.0005, category: "basic" },
        { key: "missing", refs: ["J5"], value: "<img src=x onerror=alert(1)>", footprint: "", lcsc: null, mpn: null, datasheet: "javascript:alert(1)", problems: ["missing_lcsc", "missing_mpn"] },
        { key: "empty", refs: ["U4"], value: "ESP32", footprint: "", lcsc: "C2913202", mpn: "ESP32", datasheet: null, problems: ["out_of_stock"], status: "out_of_stock", stock: 0 },
        { key: "unavailable", refs: ["U5"], value: "IC", footprint: "", lcsc: "C100", mpn: "IC", datasheet: null, problems: ["unavailable"], status: "unavailable", error: "503 <offline>" },
        { key: "swapped", refs: ["R6", "R7"], value: "4.7k", footprint: "R_0603", lcsc: "C17673", mpn: "RC0603", datasheet: "http://example.com/other.pdf", problems: [], status: "ok", stock: 3410, price: 0.31, category: "extended", fee: 3 }
      ],
      changes: []
    }
  }]
};
const fixtureParts = window.REVIEW_DATA.projects[0].parts;
fixtureParts.changes = [
  { action: "added", refs: ["J5"], before: null, after: fixtureParts.lines[1] },
  { action: "swapped", refs: ["R7"], before: { ...fixtureParts.lines[4], value: "10k", lcsc: "C17414" }, after: fixtureParts.lines[4] }
];

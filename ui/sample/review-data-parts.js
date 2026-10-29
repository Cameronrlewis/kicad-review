window.REVIEW_DATA = {
  version: 1, repo: "example/parts", base: "base", head: "head", reason: "Parts fixture",
  links: {}, blobs: {}, projects: [{
    name: "Parts", dir: "", status: "modified", sheets: [], changes: [], checks: [],
    board: { changed: false, layers: [] },
    parts: {
      supplier: { name: "DigiKey", currency: "USD", fetched_at: "2026-10-08T14:02:00Z", error: null },
      summary: { components: 6, unique: 5, withMpn: 4, byCategory: { "Resistors": 3, "Connectors": 1, "ICs & Modules": 2 } },
      // Shortened on purpose: the browser checks compare the saved bytes with these strings, not with a real BOM.
      exports: { preset: "jlcpcb",
        csv: "Category,Quantity,Value,Footprint,References,MPN,LCSC,Datasheet\r\nResistors,1,10k,R_0603,R1,RC0603,C17414,https://example.com/part.pdf\r\n",
        fab: "Comment,Designator,Footprint,LCSC,Quantity\r\n10k,R1,R_0603,C17414,1\r\n" },
      lines: [
        { key: "ok", category: "Resistors", refs: ["R1"], refsCompressed: "R1", value: "10k", footprint: "R_0603", lcsc: "C17414", mpn: "RC0603", datasheet: "https://example.com/part.pdf", problems: [], supplier: { status: "ok", quantity: 1200000, unit_price: 0.0005 } },
        { key: "missing", category: "Connectors", refs: ["J5"], refsCompressed: "J5", value: "<img src=x onerror=alert(1)>", footprint: "", lcsc: null, mpn: null, datasheet: "javascript:alert(1)", problems: ["missing_lcsc", "missing_mpn"] },
        { key: "empty", category: "ICs & Modules", refs: ["U4"], refsCompressed: "U4", value: "ESP32", footprint: "", lcsc: "C2913202", mpn: "ESP32", datasheet: null, problems: ["out_of_stock"], supplier: { status: "out_of_stock", quantity: 0 } },
        { key: "unavailable", category: "ICs & Modules", refs: ["U5"], refsCompressed: "U5", value: "IC", footprint: "", lcsc: "C100", mpn: "IC", datasheet: null, problems: ["unavailable"], supplier: { status: "unavailable" } },
        { key: "swapped", category: "Resistors", refs: ["R6", "R7"], refsCompressed: "R6-R7", value: "4.7k", footprint: "R_0603", lcsc: "C17673", mpn: "RC0603", datasheet: "http://example.com/other.pdf", problems: [], supplier: { status: "ok", quantity: 3410, unit_price: 0.31 } }
      ],
      changes: []
    }
  }]
};
const fixtureParts = window.REVIEW_DATA.projects[0].parts;
fixtureParts.changes = [
  { action: "added", refs: ["J5"], before: null, after: fixtureParts.lines[1] },
  { action: "mpn", refs: ["R1"], before: { ...fixtureParts.lines[0], mpn: "OLD-MPN" }, after: fixtureParts.lines[0] },
  { action: "swapped", refs: ["R7"], before: { ...fixtureParts.lines[4], value: "10k", lcsc: "C17414" }, after: fixtureParts.lines[4] }
];

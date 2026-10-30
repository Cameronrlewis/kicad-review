// Isolate-local only. Callers must authorize and validate live artifact metadata before get().
export class ReportCache {
  constructor(maxBytes = 40 * 1024 * 1024, maxEntries = 8) {
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.bytes = 0;
    this.entries = new Map();
  }

  get(key) {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  clear() { this.entries.clear(); this.bytes = 0; }

  set(key, entry) {
    if (!Number.isFinite(entry.bytes) || entry.bytes < 0 || entry.bytes > this.maxBytes) return;
    const previous = this.entries.get(key);
    if (previous) { this.bytes -= previous.bytes; this.entries.delete(key); }
    this.entries.set(key, entry);
    this.bytes += entry.bytes;
    while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.bytes -= this.entries.get(oldest).bytes;
      this.entries.delete(oldest);
    }
  }
}

// ponytail: ceiling is 40 MiB of accounted report data and eight entries per isolate;
// use KV/R2 if cross-isolate hits are needed. No Cache API dependency on workers.dev.
export const reportCache = new ReportCache();

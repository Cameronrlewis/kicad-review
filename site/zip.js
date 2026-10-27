// ponytail: ZIP32 only, single-disk archives under 4 GB; reject ZIP64/encryption rather than guessing.
const u16 = (b, o) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(o, true);
const u32 = (b, o) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o, true);
const fail = message => { throw new Error(message); };
const names = new TextDecoder('utf-8', { fatal: true });

export async function exactRange(range, start, end, total, stream = false) {
  if (!Number.isSafeInteger(total) || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= total) fail('bad range');
  const response = await range(start, end);
  if (response.status !== 206 || response.headers.get('Content-Range') !== `bytes ${start}-${end}/${total}` || !response.body) {
    await response.body?.cancel(); fail('range not honoured');
  }
  const wanted = end - start + 1;
  if (!stream) {
    const b = new Uint8Array(await response.arrayBuffer());
    if (b.length !== wanted) fail('bad range length');
    return b;
  }
  let seen = 0;
  return response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > wanted) fail('bad range length');
      controller.enqueue(chunk);
    },
    flush() { if (seen !== wanted) fail('bad range length'); },
  }));
}

export async function zipEntries(range, total) {
  if (!Number.isSafeInteger(total) || total < 22 || total >= 0xffffffff) fail('not a zip');
  const start = Math.max(0, total - 65557), tail = await exactRange(range, start, total - 1, total);
  let end = tail.length - 22;
  while (end >= 0 && !(u32(tail, end) === 0x06054b50 && end + 22 + u16(tail, end + 20) === tail.length)) end--;
  if (end < 0) fail('not a zip');
  const count = u16(tail, end + 10), size = u32(tail, end + 12), offset = u32(tail, end + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) fail('zip64 unsupported');
  if (u16(tail, end + 4) || u16(tail, end + 6) || u16(tail, end + 8) !== count || offset + size !== start + end) fail('bad directory');
  if (!count) { if (size !== 0) fail('bad directory'); return []; }
  if (size < count * 46) fail('bad directory');
  const dir = await exactRange(range, offset, offset + size - 1, total), out = [], unique = new Set();
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > dir.length || u32(dir, p) !== 0x02014b50) fail('bad directory');
    const n = u16(dir, p + 28), x = u16(dir, p + 30), c = u16(dir, p + 32), next = p + 46 + n + x + c;
    if (!n || next > dir.length || u16(dir, p + 34)) fail('bad directory');
    const name = names.decode(dir.subarray(p + 46, p + 46 + n)), method = u16(dir, p + 10), flags = u16(dir, p + 8);
    const entry = { name, method, flags, crc: u32(dir, p + 16), size: u32(dir, p + 20), bytes: u32(dir, p + 24), offset: u32(dir, p + 42), total, directory: offset };
    if ([entry.size, entry.bytes, entry.offset].includes(0xffffffff)) fail('zip64 unsupported');
    if ((flags & ~0x808) || ![0, 8].includes(method)) fail('unsupported zip method');
    if (unique.has(name) || name.includes('\0') || entry.offset + 30 > offset || entry.offset + 30 + n + entry.size > offset || (method === 0 && entry.size !== entry.bytes)) fail('bad entry');
    unique.add(name); out.push(entry); p = next;
  }
  if (p !== dir.length) fail('bad directory');
  return out;
}

export async function zipEntryStream(range, entry) {
  const head = await exactRange(range, entry.offset, entry.offset + 29, entry.total);
  if (u32(head, 0) !== 0x04034b50 || u16(head, 6) !== entry.flags || u16(head, 8) !== entry.method) fail('bad entry');
  const n = u16(head, 26), x = u16(head, 28), start = entry.offset + 30 + n + x;
  if (!n || start > entry.directory || start + entry.size > entry.directory) fail('bad entry');
  if (!(entry.flags & 8) && (u32(head, 14) !== entry.crc || u32(head, 18) !== entry.size || u32(head, 22) !== entry.bytes)) fail('bad entry');
  const name = await exactRange(range, entry.offset + 30, entry.offset + 30 + n - 1, entry.total);
  if (names.decode(name) !== entry.name) fail('bad entry');
  if (!entry.size) return new Response(new Uint8Array(0)).body;
  let body = await exactRange(range, start, start + entry.size - 1, entry.total, true);
  if (entry.method === 8) body = body.pipeThrough(new DecompressionStream('deflate-raw'));
  let seen = 0;
  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) { seen += chunk.byteLength; if (seen > entry.bytes) fail('bad entry length'); controller.enqueue(chunk); },
    flush() { if (seen !== entry.bytes) fail('bad entry length'); },
  }));
}

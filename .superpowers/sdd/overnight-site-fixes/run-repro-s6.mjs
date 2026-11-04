import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

const useBaseline = process.argv.includes('--baseline');
let prefix = path.resolve('site');
let cleanupDir = null;

if (useBaseline) {
  cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), 's6-baseline-'));
  execFileSync('git', ['archive', '19765c1', 'site'], {
    stdio: ['ignore', fs.openSync(path.join(cleanupDir, 'site.tar'), 'w'), 'inherit'],
  });
  execFileSync('tar', ['-xf', path.join(cleanupDir, 'site.tar'), '-C', cleanupDir]);
  // Symlink ui for report-shell
  fs.symlinkSync(path.resolve('ui'), path.join(cleanupDir, 'ui'));
  prefix = path.join(cleanupDir, 'site');
}

function fixtureCrc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(files) {
  const parts = [], central = []; let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name), body = f.deflate ? deflateRawSync(f.data) : f.data, method = f.deflate ? 8 : 0, extra = Buffer.alloc(4);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(fixtureCrc32(f.data), 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(f.data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(extra.length, 28);
    parts.push(local, name, extra, body);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(fixtureCrc32(f.data), 16); entry.writeUInt32LE(body.length, 20); entry.writeUInt32LE(f.data.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += 30 + name.length + extra.length + body.length;
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

try {
  console.log(`Running against: ${useBaseline ? 'BASELINE 19765c1 (pre-fix)' : 'CURRENT HEAD (post-fix)'}`);

  const env = { ALLOWED_OWNERS: 'Cameronrlewis', SESSION_KEY: Buffer.alloc(32, 7).toString('base64') };
  const workerMod = await import(`${prefix}/worker.js`);
  const worker = workerMod.default;
  const seal = workerMod.seal;

  async function signedIn(overrides = {}) {
    return seal({ t: 'user-token', r: 'refresh-token', e: Date.now() + 3_600_000, re: Date.now() + 7_200_000, u: 'octocat', ...overrides }, env);
  }

  const cookies = (response) => response.headers.getSetCookie();
  const cookieValue = (response, name) => {
    const match = cookies(response).find((value) => value.startsWith(`${name}=`));
    return match?.split(';', 1)[0].slice(name.length + 1);
  };

  const results = {};

  function setupDownloadFetch(zip) {
    const report = { name: 'kicad-review-aaaaaaa-bbbbbbb-pass.html', workflow_run: { id: 9, head_sha: 'b'.repeat(40) } };
    const bundle = { id: 124, name: 'kicad-review-downloads-bbbbbbb', expired: false, workflow_run: { id: 9, head_sha: 'b'.repeat(40) } };
    globalThis.fetch = async (url, options = {}) => {
      url = String(url);
      if (url === 'https://api.github.com/repos/Cameronrlewis/repo') return Response.json({ owner: { login: 'Cameronrlewis' }, permissions: { pull: true, push: true }, default_branch: 'main' });
      if (url === 'https://api.github.com/repos/Cameronrlewis/repo/actions/artifacts/123') return Response.json(report);
      if (url === 'https://api.github.com/repos/Cameronrlewis/repo/actions/runs/9') return Response.json({ id: 9, event: 'pull_request' });
      if (url.includes('/actions/runs/9/artifacts?')) return Response.json({ artifacts: [bundle] });
      if (url === 'https://api.github.com/repos/Cameronrlewis/repo/actions/artifacts/124/zip') {
        return new Response(null, { status: 302, headers: { Location: 'https://blob.example/z' } });
      }
      if (url === 'https://blob.example/z') {
        const m = /^bytes=(\d+)-(\d+)$/.exec(options.headers?.Range || options.headers?.range || '');
        if (!m) return new Response(zip, { status: 200 });
        const start = +m[1], end = Math.min(+m[2], zip.length - 1);
        return new Response(zip.subarray(start, end + 1), {
          status: 206,
          headers: { 'Content-Range': `bytes ${start}-${end}/${zip.length}` },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
  }

  // Finding 8: Downloads selected by manifest record
  try {
    const sealed = await signedIn();
    const head = 'b'.repeat(40);

    // 1. Stale PDF in zip when manifest records failed export
    const stalePdfZip = makeZip([
      { name: '0/old.pdf', data: Buffer.from('%PDF-stale') },
      { name: '0/downloads.json', data: Buffer.from(JSON.stringify({ files: [{ kind: 'pdf', error: 'export failed' }], head })) },
    ]);
    setupDownloadFetch(stalePdfZip);
    const res1 = await worker.fetch(new Request('https://site.example/r/Cameronrlewis/repo/a/123/download/0/pdf', { headers: { Cookie: `s=${sealed}` } }), env);
    assert.equal(res1.status, 404, `Stale PDF export should return 404, got ${res1.status}`);

    // 2. Unlisted GLB in zip not matching manifest declared path
    const pathMismatchZip = makeZip([
      { name: '0/unlisted.glb', data: Buffer.from('glTF-unlisted') },
      { name: '0/downloads.json', data: Buffer.from(JSON.stringify({ files: [{ kind: 'glb', path: '0/manifest.glb', bytes: 13 }], head })) },
    ]);
    setupDownloadFetch(pathMismatchZip);
    const res2 = await worker.fetch(new Request('https://site.example/r/Cameronrlewis/repo/a/123/download/0/glb', { headers: { Cookie: `s=${sealed}` } }), env);
    assert.equal(res2.status, 404, `Unlisted glb in zip should return 404, got ${res2.status}`);

    // 3. Central directory entry size mismatch from manifest bytes
    const sizeMismatchZip = makeZip([
      { name: '0/board.glb', data: Buffer.from('glTF-data') },
      { name: '0/downloads.json', data: Buffer.from(JSON.stringify({ files: [{ kind: 'glb', path: '0/board.glb', bytes: 9999 }], head })) },
    ]);
    setupDownloadFetch(sizeMismatchZip);
    const res3 = await worker.fetch(new Request('https://site.example/r/Cameronrlewis/repo/a/123/download/0/glb', { headers: { Cookie: `s=${sealed}` } }), env);
    assert.equal(res3.status, 404, `Size mismatch should return 404, got ${res3.status}`);

    results['finding 8'] = { status: 'PASS' };
  } catch (err) {
    results['finding 8'] = { status: 'FAIL', error: err.message };
  }

  // Finding 9: Uncaught body/API errors keep cleanup and cookies
  try {
    // Part 1: Malformed multipart compare request retains renewed session cookie on 400
    const expired = await seal({ t: 'old-token', r: 'old-refresh', e: Date.now() - 1, re: Date.now() + 7_200_000, u: 'octocat' }, env);
    globalThis.fetch = async (url) => {
      url = String(url);
      if (url === 'https://github.com/login/oauth/access_token') {
        return Response.json({ access_token: 'new-token', refresh_token: 'new-refresh', expires_in: 3600, refresh_token_expires_in: 7200 });
      }
      if (url === 'https://api.github.com/repos/Cameronrlewis/repo') {
        return Response.json({ owner: { login: 'Cameronrlewis' }, permissions: { pull: true, push: true }, default_branch: 'main' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const resCompare = await worker.fetch(new Request('https://site.example/r/Cameronrlewis/repo/compare', {
      method: 'POST',
      headers: {
        Origin: 'https://site.example',
        Cookie: `s=${expired}`,
        'Content-Type': 'multipart/form-data; boundary=invalid-boundary',
      },
      body: '--invalid-boundary\r\nContent-Disposition: form-data; name="x"\r\n',
    }), env);

    assert.equal(resCompare.status, 400, `Expected 400 for malformed multipart compare, got ${resCompare.status}`);
    assert.ok(cookieValue(resCompare, 's'), 'Renewed session cookie must be present on 400');

    // Part 2: OAuth callback /user network error clears state cookie and returns 502
    const loginRes = await worker.fetch(new Request('https://site.example/login'), env);
    const savedState = cookieValue(loginRes, 'st');
    assert.ok(savedState, 'Expected login to issue state cookie');

    globalThis.fetch = async (url) => {
      url = String(url);
      if (url.includes('access_token')) {
        return Response.json({ access_token: 'token', refresh_token: 'ref', expires_in: 3600, refresh_token_expires_in: 7200 });
      }
      if (url === 'https://api.github.com/user') throw new Error('network down');
      throw new Error(`unexpected fetch: ${url}`);
    };

    const resUserErr = await worker.fetch(new Request(`https://site.example/callback?code=code&state=${encodeURIComponent(savedState)}`, {
      headers: { Cookie: `st=${savedState}` },
    }), env);
    assert.equal(resUserErr.status, 502, `Expected 502 for /user network failure, got ${resUserErr.status}`);
    assert.match(cookies(resUserErr).join('\n'), /st=;.*Max-Age=0/, 'State cookie must be cleared on /user network failure');

    // Part 3: OAuth callback /user malformed JSON clears state cookie and returns 502
    globalThis.fetch = async (url) => {
      url = String(url);
      if (url.includes('access_token')) {
        return Response.json({ access_token: 'token', refresh_token: 'ref', expires_in: 3600, refresh_token_expires_in: 7200 });
      }
      if (url === 'https://api.github.com/user') return new Response('invalid json {', { status: 200, headers: { 'Content-Type': 'application/json' } });
      throw new Error(`unexpected fetch: ${url}`);
    };

    const resUserJson = await worker.fetch(new Request(`https://site.example/callback?code=code&state=${encodeURIComponent(savedState)}`, {
      headers: { Cookie: `st=${savedState}` },
    }), env);
    assert.equal(resUserJson.status, 502, `Expected 502 for /user invalid JSON, got ${resUserJson.status}`);
    assert.match(cookies(resUserJson).join('\n'), /st=;.*Max-Age=0/, 'State cookie must be cleared on /user invalid JSON');

    results['finding 9'] = { status: 'PASS' };
  } catch (err) {
    results['finding 9'] = { status: 'FAIL', error: err.message };
  }

  console.log(JSON.stringify(results, null, 2));
  const expectedFindings = ['finding 8', 'finding 9'];
  const hasFailures = expectedFindings.some(f => results[f]?.status !== 'PASS');
  if (hasFailures) {
    process.exitCode = 1;
  }
} finally {
  if (cleanupDir) {
    fs.rmSync(cleanupDir, { recursive: true, force: true });
  }
}

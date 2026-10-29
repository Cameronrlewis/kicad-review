import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {FrameCDP} from './test-cdp.mjs';

test('CDP helper refuses the study browser and invalid ports before connecting', async () => {
  for (const port of [9222, 0, -1, 65536, NaN]) {
    await assert.rejects(FrameCDP.open(port), /dedicated Chrome debug port/);
  }
});

test('CDP helper reports an unreachable dedicated Chrome port', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  await assert.rejects(FrameCDP.open(port), /fetch failed/);
});

test('CDP readiness retries when navigation replaces its execution context', async () => {
  let attempts = 0;
  const page = {async evalRoot() {
    if (++attempts === 1) throw Error('Execution context was destroyed.');
    return true;
  }};
  await FrameCDP.prototype.waitRoot.call(page, 'document.readyState === "complete"');
  assert.equal(attempts, 2);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {gzipSync} from 'node:zlib';

function worker() {
  const replies = [];
  const self = {postMessage: (message, transfer) => replies.push({message, transfer})};
  runInNewContext(readFileSync(new URL('./three-decode.js', import.meta.url), 'utf8'),
    {self, Uint8Array, atob, Blob, Response, DecompressionStream});
  return {self, replies};
}

test('BR02 worker transfers decoded bytes and reports malformed gzip', async () => {
  const {self, replies} = worker();
  await self.onmessage({data: {id: 1, b64: gzipSync('glTF').toString('base64')}});
  assert.equal(new TextDecoder().decode(replies[0].message.buffer), 'glTF');
  assert.equal(replies[0].message.id, 1);
  assert.equal(replies[0].transfer[0], replies[0].message.buffer);
  await self.onmessage({data: {id: 2, b64: 'not base64!'}});
  assert.equal(replies[1].message.id, 2);
  assert.ok(replies[1].message.error);
  await self.onmessage({data: {id: 3, b64: Buffer.from('not gzip').toString('base64')}});
  assert.equal(replies[2].message.id, 3);
  assert.equal(typeof replies[2].message.error, 'string');
  assert.ok(replies[2].message.error);
  assert.equal(replies[2].transfer, undefined);
});

test('BR02 worker accepts transferred gzip and raw ArrayBuffers', async () => {
  const {self, replies} = worker();
  for (const gzip of [true, false]) {
    const bytes = Uint8Array.from(gzip ? gzipSync('glTF') : Buffer.from('glTF')).buffer;
    await self.onmessage({data: {id: gzip ? 4 : 5, bytes, gzip}});
  }
  assert.deepEqual(replies.map(({message}) => message.id), [4, 5]);
  for (const {message, transfer} of replies) {
    assert.equal(new TextDecoder().decode(message.buffer), 'glTF');
    assert.equal(transfer.length, 1);
    assert.equal(transfer[0], message.buffer);
    assert.equal(message.error, undefined);
  }
});

test('BR02 worker handles empty raw data and recovers after a decode error', async () => {
  const {self, replies} = worker();
  await self.onmessage({data: {id: 6, bytes: new Uint8Array([1, 2]).buffer, gzip: true}});
  await self.onmessage({data: {id: 7, bytes: new Uint8Array().buffer, gzip: false}});
  assert.ok(replies[0].message.error);
  assert.equal(replies[1].message.id, 7);
  assert.equal(replies[1].message.buffer.byteLength, 0);
  assert.equal(replies[1].transfer[0], replies[1].message.buffer);
});

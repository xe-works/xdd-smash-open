import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { readBody } from '../../core/server.js';

const BID = { id: 'r1', imp: [{ id: 'i1' }], tmax: 200 };

// node:http always yields Buffers, never strings — model that exactly, or the
// test passes on input the server can never receive.
function makeReq(payload, headers = {}) {
  const req = Readable.from([Buffer.from(payload)]);
  req.headers = headers;
  return req;
}

test('reads an uncompressed body when no encoding is declared', async () => {
  assert.deepEqual(await readBody(makeReq(JSON.stringify(BID))), BID);
});

test('reads an uncompressed body declared as identity', async () => {
  const req = makeReq(JSON.stringify(BID), { 'content-encoding': 'identity' });
  assert.deepEqual(await readBody(req), BID);
});

test('reads a gzip body', async () => {
  const req = makeReq(gzipSync(JSON.stringify(BID)), { 'content-encoding': 'gzip' });
  assert.deepEqual(await readBody(req), BID);
});

test('matches the encoding regardless of case or padding', async () => {
  const req = makeReq(gzipSync(JSON.stringify(BID)), { 'content-encoding': ' GZIP ' });
  assert.deepEqual(await readBody(req), BID);
});

test('reads the x-gzip alias', async () => {
  const req = makeReq(gzipSync(JSON.stringify(BID)), { 'content-encoding': 'x-gzip' });
  assert.deepEqual(await readBody(req), BID);
});

test('rejects an encoding it does not implement, naming it', async () => {
  const req = makeReq(JSON.stringify(BID), { 'content-encoding': 'br' });
  await assert.rejects(readBody(req), /unsupported content-encoding: br/);
});

test('rejects a body that does not match the encoding it declares', async () => {
  const req = makeReq(JSON.stringify(BID), { 'content-encoding': 'gzip' });
  await assert.rejects(readBody(req), /could not decode gzip body/);
});

test('reports bad JSON as bad JSON once it decompresses', async () => {
  const req = makeReq(gzipSync('not json'), { 'content-encoding': 'gzip' });
  await assert.rejects(readBody(req), /invalid JSON/);
});

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getRedis, _reset } from '../../features/intent-iq/redis.js';

// Refused immediately, so nothing here waits on a network.
const DEAD = 'redis://127.0.0.1:1';
const OTHER = 'redis://127.0.0.1:2';

afterEach(_reset);

test('no url means no client', () => {
  assert.equal(getRedis(''), null);
  assert.equal(getRedis(undefined), null);
});

test('one connection per url, not one per process', async () => {
  const a = getRedis(DEAD);
  assert.equal(getRedis(DEAD), a, 'the same url shares the pending promise');

  const b = getRedis(OTHER);
  assert.notEqual(b, a, 'a different url gets its own connection');

  await Promise.all([a, b]);
});

test('a connection that fails is forgotten, so the next call retries', async () => {
  const first = getRedis(DEAD);
  assert.equal(await first, null, 'fails open rather than throwing');

  const second = getRedis(DEAD);
  assert.notEqual(second, first, 'a dead server is not memoised for the process lifetime');
  assert.equal(await second, null);
});

test('a malformed url fails open', async () => {
  // createClient throws synchronously here, but connect() is async, so it
  // reaches the caller as a rejection.
  assert.equal(await getRedis('not-a-url'), null);
  assert.equal(await getRedis('http://wrong-protocol'), null);
});

function fakeClient() {
  const handlers = {};
  return { on: (event, fn) => { handlers[event] = fn; }, emit: event => handlers[event]?.() };
}

test('a connection that drops is forgotten', async () => {
  const client = fakeClient();
  const connected = getRedis(DEAD, async () => client);

  assert.equal(await connected, client);
  assert.equal(getRedis(DEAD, async () => client), connected, 'memoised while alive');

  // reconnectStrategy is false, so this client is gone for good.
  client.emit('end');
  assert.notEqual(getRedis(DEAD, async () => fakeClient()), connected,
    'the dead client is not handed to the next caller');
});

test('a connect that throws synchronously fails open', () => {
  assert.equal(getRedis(DEAD, () => { throw new Error('boom'); }), null);
  assert.equal(getRedis(DEAD, async () => fakeClient()) === null, false,
    'and nothing is left memoised to block the retry');
});

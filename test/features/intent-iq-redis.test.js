import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
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
  return {
    isOpen: true,
    on: (event, fn) => { (handlers[event] ??= []).push(fn); },
    emit: event => handlers[event]?.forEach(fn => fn()),
  };
}

// Answers +OK to every command, enough for node-redis to connect, and can be
// killed like a restarting server.
async function okServer() {
  const sockets = new Set();
  const server = net.createServer(sock => {
    sockets.add(sock);
    sock.on('data', buf => {
      const commands = buf.toString().split('\r\n').filter(l => l.startsWith('*')).length;
      sock.write('+OK\r\n'.repeat(commands));
    });
    sock.on('close', () => sockets.delete(sock));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    url: `redis://127.0.0.1:${server.address().port}`,
    kill: () => new Promise(r => { sockets.forEach(s => s.destroy()); server.close(r); }),
  };
}

test('a real client whose server restarts is forgotten, so the next call reconnects', async () => {
  const srv = await okServer();
  const first = await getRedis(srv.url);
  assert.ok(first?.isReady, 'connected to the stand-in server');

  await srv.kill();
  await new Promise(r => setTimeout(r, 50));

  assert.equal(first.isOpen, false, 'node-redis gives up: reconnectStrategy is false');
  const next = getRedis(srv.url);
  assert.notEqual(await next, first, 'the dead client is not handed out again');
});

test('a transient error on a live client keeps it', async () => {
  const client = fakeClient();
  const connected = getRedis(DEAD, async () => client);
  await connected;

  client.emit('error');
  assert.equal(getRedis(DEAD, async () => fakeClient()), connected, 'still open, still memoised');

  client.isOpen = false;
  client.emit('error');
  assert.notEqual(getRedis(DEAD, async () => fakeClient()), connected, 'closed after the error, forgotten');
});

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

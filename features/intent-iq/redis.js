import { createClient } from 'redis';

const _conns = new Map();

async function connect(url) {
  // reconnectStrategy: false — otherwise node-redis retries forever and
  // connect() never rejects, so a dead Redis hangs inside tmax instead of
  // failing open. createClient throws synchronously on a malformed url, but
  // this function is async, so that surfaces as a rejection like any other.
  const client = createClient({ url, socket: { reconnectStrategy: false, connectTimeout: 300 } });
  client.on('error', () => {});
  await client.connect();
  return client;
}

// Memoises the promise, not the client. Awaiting the client instead lets every
// concurrent caller past the null check, each opening a connection that is then
// orphaned — still connected, never used, never closed.
//
// Keyed by url: the throttle reads the static module config and the hook reads
// the per-request one, so the two can ask for different servers.
export function getRedis(url, connectFn = connect) {
  if (!url) return null;

  const hit = _conns.get(url);
  if (hit) return hit;

  let pending;
  const forget = () => { if (_conns.get(url) === pending) _conns.delete(url); };

  try {
    pending = connectFn(url).then(client => {
      // reconnectStrategy is false, so a connection that drops never comes
      // back. node-redis reports a server going away only as 'error' with
      // isOpen false; 'end' fires solely on a close we asked for. Listening
      // for 'end' alone kept a dead client until the process restarted.
      client.on('end', forget);
      client.on('error', () => { if (client.isOpen === false) forget(); });
      return client;
    }).catch(() => { forget(); return null; });
  } catch {
    return null;
  }

  _conns.set(url, pending);
  return pending;
}

export function _reset() {
  _conns.clear();
}

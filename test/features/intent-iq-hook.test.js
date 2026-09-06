import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeConfig } from '../../core/utils.js';
import { resolveConfig } from '../../core/config.js';
import { _run } from '../../features/intent-iq/prebid-dsp.js';

const DEFAULTS = JSON.parse(readFileSync(new URL('../../features/intent-iq/config.json', import.meta.url)));

function cfgWith(over) {
  return mergeConfig(mergeConfig(DEFAULTS, {
    enabled: true,
    redisUrl: 'redis://x',
    regions: { us: { dpi: '111' }, eu: { host: 'gdpr.example', dpi: '333' } },
  }), over);
}

function ctx({ country = 'USA', ifa = 'device-1', eids = [], params } = {}) {
  const patches = [];
  return {
    dsp: { id: '333', endpointId: '4444', knownBidder: 'pubmatic', params: params ? { intentIq: params } : {} },
    ssp: { id: '100', endpointId: '200' },
    device: { country, ifa, ip: '1.2.3.4', ua: 'UA', os: 'iOS', osv: '17.5', type: 4 },
    user: { id: null, eids },
    publisher: { bundle: 'com.app', domain: null, name: null },
    content: { page: null },
    privacy: { gdpr: null, consent: null },
    impression: { inventoryCode: 'slot-1' },
    experimentByNs: {},
    configOverrides: {},
    meta: { requestId: 'r1', errors: [], warnings: [] },
    _patches: patches,
    set(path, value) { patches.push({ path, value }); return this; },
    track(ns, data) { this._trackExt ??= {}; this._trackExt[ns] = { ...this._trackExt[ns], ...data }; return this; },
    patch(path) { return patches.filter(p => p.path === path).at(-1)?.value; },
  };
}

function redisWith(store = new Map(), { readThrows = false } = {}) {
  return {
    calls: { set: [] },
    async get(k) { if (readThrows) throw new Error('down'); return store.get(k) ?? null; },
    async set(k, v, opts) { this.calls.set.push({ k, v, opts }); store.set(k, v); },
  };
}

const okGate = { admit: () => true, record: () => {} };
const closedGate = { admit: () => false, record: () => {} };

function fetchStub(result) {
  const calls = [];
  const fn = async args => { calls.push(args); return result; };
  fn.calls = calls;
  return fn;
}

const EIDS = [{ source: 'adsrvr.org', uids: [{ id: 'TTD-1' }] }];


test('mergeConfig merges nested objects instead of replacing them', () => {
  const out = mergeConfig({ a: { b: 1, c: 2 }, d: 3 }, { a: { c: 9 } });
  assert.deepEqual(out, { a: { b: 1, c: 9 }, d: 3 });
});

test('mergeConfig replaces arrays rather than merging element-wise', () => {
  assert.deepEqual(mergeConfig({ t: [{ a: 1 }, { b: 2 }] }, { t: [{ c: 3 }] }), { t: [{ c: 3 }] });
});

test('mergeConfig lets an explicit null win and ignores undefined', () => {
  assert.deepEqual(mergeConfig({ a: { b: 1 } }, { a: null }), { a: null });
  assert.deepEqual(mergeConfig({ a: 1 }, undefined), { a: 1 });
});

test('mergeConfig does not mutate its inputs', () => {
  const base = { a: { b: 1 } };
  mergeConfig(base, { a: { b: 2 } });
  assert.deepEqual(base, { a: { b: 1 } });
});

test('a partial per-request region override keeps the other regions and its own host', () => {
  const cfg = mergeConfig(cfgWith({}), { regions: { us: { dpi: '999' } } });
  assert.equal(cfg.regions.us.dpi, '999');
  assert.equal(cfg.regions.eu.dpi, '333', 'sibling region survived');
  assert.equal(cfg.regions.eu.host, 'gdpr.example', 'sibling host survived');
  assert.equal(cfg.regions.apac.dpi, '', 'region only present in defaults survived');
});

test('a partial reporting override keeps the host', () => {
  const cfg = mergeConfig(cfgWith({}), { reporting: { enabled: false } });
  assert.equal(cfg.reporting.enabled, false);
  assert.equal(cfg.reporting.host, 'reports-s2s.intentiq.com');
});

test('resolveConfig applies an A/B variant override without flattening siblings', () => {
  const c = { ...ctx(), configOverrides: { intentIq: { regions: { us: { dpi: 'AB' } } } } };
  const cfg = resolveConfig(c, cfgWith({}), 'intentIq');
  assert.equal(cfg.regions.us.dpi, 'AB');
  assert.equal(cfg.regions.eu.host, 'gdpr.example');
});


test('a target miss passes the request through untouched', async () => {
  const c = ctx();
  const fetch = fetchStub({ outcome: 'ok', eids: EIDS });
  await _run(c, cfgWith({ targets: [{ _side: 'ssp', knownBidder: 'nope' }] }), redisWith(), { fetch, gate: okGate });
  assert.equal(fetch.calls.length, 0);
  assert.equal(c._patches.length, 0);
});

test('a request with no usable identity passes through', async () => {
  const c = ctx({ ifa: null });
  c.device.ip = null;
  c.device.ua = null;
  const fetch = fetchStub({ outcome: 'ok', eids: EIDS });
  await _run(c, cfgWith({}), redisWith(), { fetch, gate: okGate });
  assert.equal(fetch.calls.length, 0);
});

test('no Redis means the feature is off, not uncached — it never calls IntentIQ', async () => {
  const c = ctx();
  const fetch = fetchStub({ outcome: 'ok', eids: EIDS });
  await _run(c, cfgWith({}), null, { fetch, gate: okGate });
  assert.equal(fetch.calls.length, 0, 'an outage must not turn every request into a fetch');
  assert.equal(c._patches.length, 0);
});

test('a Redis read error passes through without fetching', async () => {
  const c = ctx();
  const fetch = fetchStub({ outcome: 'ok', eids: EIDS });
  await _run(c, cfgWith({}), redisWith(new Map(), { readThrows: true }), { fetch, gate: okGate });
  assert.equal(fetch.calls.length, 0);
});

test('a cache hit enriches without calling IntentIQ', async () => {
  const store = new Map([['iiq:ifa:DEVICE-1', JSON.stringify({ eids: EIDS, abTestUuid: 'AB-1', dpi: '111' })]]);
  const c = ctx();
  const fetch = fetchStub({ outcome: 'ok', eids: [] });

  await _run(c, cfgWith({}), redisWith(store), { fetch, gate: okGate });

  assert.equal(fetch.calls.length, 0);
  assert.deepEqual(c.patch('user.ext.eids'), EIDS);
  assert.deepEqual(c.patch('user.eids'), EIDS);
  assert.equal(c._trackExt.iiq.abTestUuid, 'AB-1');
  assert.equal(c._trackExt.iiq.dpi, '111');
  assert.equal(c._trackExt.iiq.bidder, 'pubmatic');
  assert.equal(c._trackExt.iiq.placementId, 'slot-1');
});

test('a cached entry from another account does not lend its abTestUuid', async () => {
  const store = new Map([['iiq:ifa:DEVICE-1', JSON.stringify({ eids: EIDS, abTestUuid: 'AB-OTHER', dpi: '999' })]]);
  const c = ctx();
  await _run(c, cfgWith({}), redisWith(store), { fetch: fetchStub({}), gate: okGate });
  assert.equal(c._trackExt.iiq.abTestUuid, null);
});

test('a cached empty entry attaches nothing and still does not fetch', async () => {
  const store = new Map([['iiq:ifa:DEVICE-1', JSON.stringify({ eids: [], abTestUuid: 'AB-1', dpi: '111' })]]);
  const c = ctx();
  const fetch = fetchStub({ outcome: 'ok', eids: EIDS });

  await _run(c, cfgWith({}), redisWith(store), { fetch, gate: okGate });
  assert.equal(fetch.calls.length, 0);
  assert.equal(c.patch('user.ext.eids'), undefined);
});

test('an unserved country is never sent to IntentIQ', async () => {
  const c = ctx({ country: 'UKR' });
  const fetch = fetchStub({ outcome: 'ok', eids: EIDS });
  await _run(c, cfgWith({}), redisWith(), { fetch, gate: okGate });
  assert.equal(fetch.calls.length, 0);
});

test('without a dpi the feature reads the cache but never calls out', async () => {
  const shared = new Map([['iiq:ifa:DEVICE-1', JSON.stringify({ eids: EIDS, abTestUuid: 'AB-1', dpi: '111' })]]);
  const cfg = cfgWith({ regions: { us: { dpi: '' } } });

  const hit = ctx();
  const fetch = fetchStub({ outcome: 'ok', eids: EIDS });
  await _run(hit, cfg, redisWith(shared), { fetch, gate: okGate });
  assert.deepEqual(hit.patch('user.ext.eids'), EIDS, 'still enriched from the shared cache');
  assert.equal(hit._trackExt, undefined, 'nothing to report without an account');

  const miss = ctx({ ifa: 'device-2' });
  await _run(miss, cfg, redisWith(new Map()), { fetch, gate: okGate });
  assert.equal(fetch.calls.length, 0);
});

test('a throttled request passes through without fetching', async () => {
  const c = ctx();
  const fetch = fetchStub({ outcome: 'ok', eids: EIDS });
  await _run(c, cfgWith({}), redisWith(), { fetch, gate: closedGate });
  assert.equal(fetch.calls.length, 0);
});

test('a fetch attaches eids, caches them, and records the account that fetched', async () => {
  const c = ctx();
  const redis = redisWith();
  const fetch = fetchStub({ outcome: 'ok', eids: EIDS, abTestUuid: 'AB-2', cttl: 600_000 });

  await _run(c, cfgWith({}), redis, { fetch, gate: okGate });

  assert.equal(fetch.calls[0].host, 'be-api-s2s.intentiq.com');
  assert.equal(fetch.calls[0].dpi, '111');
  assert.equal(fetch.calls[0].identity.pcid, 'device-1', 'pcid sent as received');
  assert.deepEqual(c.patch('user.ext.eids'), EIDS);

  const [write] = redis.calls.set;
  assert.equal(write.k, 'iiq:ifa:DEVICE-1');
  assert.deepEqual(JSON.parse(write.v), { eids: EIDS, abTestUuid: 'AB-2', dpi: '111' });
  assert.equal(write.opts.PX, 600_000, 'their cttl is honoured');
  assert.equal(c._trackExt.iiq.abTestUuid, 'AB-2');
});

test('an empty answer is cached so the same device is not asked again', async () => {
  const c = ctx();
  const redis = redisWith();
  await _run(c, cfgWith({}), redis, { fetch: fetchStub({ outcome: 'ok', eids: [], cttl: 600_000 }), gate: okGate });

  assert.equal(redis.calls.set.length, 1);
  assert.deepEqual(JSON.parse(redis.calls.set[0].v).eids, []);
  assert.equal(c.patch('user.ext.eids'), undefined);
});

test('a timeout or error caches nothing and leaves the request alone', async () => {
  for (const outcome of ['timeout', 'error', 'qps', 'badjson']) {
    const c = ctx();
    const redis = redisWith();
    await _run(c, cfgWith({}), redis, { fetch: fetchStub({ outcome }), gate: okGate });
    assert.equal(redis.calls.set.length, 0, outcome);
    assert.equal(c._patches.length, 0, outcome);
  }
});

test('the cohort tier gets a shorter ttl than their cttl asks for', async () => {
  const c = ctx({ ifa: null });
  const redis = redisWith();
  await _run(c, cfgWith({}), redis, { fetch: fetchStub({ outcome: 'ok', eids: EIDS, cttl: 86_400_000 }), gate: okGate });
  assert.equal(redis.calls.set[0].opts.PX, DEFAULTS.coarseTtlMs);
});

test('incoming eids are kept and ours are only added for new sources', async () => {
  const incoming = [
    { source: 'adsrvr.org', uids: [{ id: 'SSP-OWN' }] },
    { source: 'intentiq.com', uids: [{ id: 'UID-1' }] },
  ];
  const fresh = [
    { source: 'adsrvr.org', uids: [{ id: 'IIQ-VERSION' }] },
    { source: 'pubmatic.com', uids: [{ id: 'PM-1' }] },
  ];
  const c = ctx({ eids: incoming });
  await _run(c, cfgWith({}), redisWith(), { fetch: fetchStub({ outcome: 'ok', eids: fresh }), gate: okGate });

  const merged = c.patch('user.ext.eids');
  assert.equal(merged.length, 3);
  assert.equal(merged[0].uids[0].id, 'SSP-OWN', 'the SSP value is never overwritten');
  assert.ok(merged.some(e => e.source === 'intentiq.com'));
  assert.ok(merged.some(e => e.source === 'pubmatic.com'));
});

test('the incoming IIQ universal id is forwarded on the fetch', async () => {
  const eids = [{ source: 'intentiq.com', uids: [{ id: 'UID-7' }] }];
  const fetch = fetchStub({ outcome: 'ok', eids: [] });
  await _run(ctx({ eids }), cfgWith({}), redisWith(), { fetch, gate: okGate });
  assert.equal(fetch.calls[0].identity.iiquid, 'UID-7');
});

test('awaitFetch false returns before the answer and still stores it', async () => {
  const c = ctx();
  const redis = redisWith();
  let release;
  const fetch = async () => new Promise(r => { release = () => r({ outcome: 'ok', eids: EIDS, cttl: 1000 }); });

  await _run(c, cfgWith({ awaitFetch: false }), redis, { fetch, gate: okGate });
  assert.equal(c._patches.length, 0, 'the auction is not delayed');

  release();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(redis.calls.set.length, 1, 'the answer still lands in the cache');
});

test('a per-request region override wins over config on the wire', async () => {
  const fetch = fetchStub({ outcome: 'ok', eids: [] });
  const c = ctx({ params: { regions: { us: { dpi: 'REQ-DPI' } } } });
  const cfg = mergeConfig(cfgWith({}), c.dsp.params.intentIq);
  await _run(c, cfg, redisWith(), { fetch, gate: okGate });
  assert.equal(fetch.calls[0].dpi, 'REQ-DPI');
  assert.equal(fetch.calls[0].host, 'be-api-s2s.intentiq.com', 'the default host still resolves');
});

test('gdpr traffic goes to the gdpr account and carries the consent string', async () => {
  const c = ctx({ country: 'GBR' });
  c.privacy = { gdpr: 1, consent: 'CONSENT-STR' };
  const fetch = fetchStub({ outcome: 'ok', eids: [] });
  await _run(c, cfgWith({}), redisWith(), { fetch, gate: okGate });

  assert.equal(fetch.calls[0].host, 'gdpr.example');
  assert.equal(fetch.calls[0].dpi, '333');
  assert.equal(fetch.calls[0].gdpr, 1);
  assert.equal(fetch.calls[0].consent, 'CONSENT-STR');
});

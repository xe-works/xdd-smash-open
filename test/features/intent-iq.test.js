import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRegion, COUNTRY_REGION, DEFAULT_HOSTS } from '../../features/intent-iq/regions.js';
import { cacheKeyFor, cohortOf, identityFor, hasRealIfa, IDTYPE } from '../../features/intent-iq/identity.js';
import { createThrottle } from '../../features/intent-iq/throttle.js';
import { ttlFor, abTestUuidFor, entryFor } from '../../features/intent-iq/cache.js';
import { buildRdata, createConsumer } from '../../features/intent-iq/reporting.js';
import { s2sPath, reportPath, interpretEids } from '../../features/intent-iq/client.js';

const TTL_CFG = { ttlMs: 43_200_000, coarseTtlMs: 3_600_000, maxTtlMs: 86_400_000 };

// now stays below SYNC_MS so admit() never fires a sync on its own.
function throttleWith(rows, { fail = false } = {}) {
  const calls = [];
  const th = createThrottle({
    now: () => 500,
    redis: async () => (rows === null ? null : {
      eval: async (_lua, opts) => {
        calls.push(opts.arguments.map(Number));
        if (fail) throw new Error('redis down');
        return rows;
      },
    }),
  });
  return { th, calls };
}

const REGIONS = {
  us: { dpi: '111' },
  apac: { dpi: '' },
  eu: { host: 'custom-gdpr.example', dpi: '333' },
};

function ctx({ device = {}, user = {}, publisher = {}, content = {}, ssp = { id: '100' }, inventory = null } = {}) {
  return { device, user, publisher, content, ssp, inventory };
}

test('resolveRegion maps a country to its region, host and dpi', () => {
  assert.deepEqual(resolveRegion('USA', REGIONS), {
    region: 'us', host: DEFAULT_HOSTS.us, dpi: '111', reason: null,
  });
});

test('resolveRegion honours a configured host over the default', () => {
  assert.equal(resolveRegion('GBR', REGIONS).host, 'custom-gdpr.example');
});

test('resolveRegion reports an unserved country instead of guessing', () => {
  assert.deepEqual(resolveRegion('UKR', REGIONS), { region: null, reason: 'country_unsupported' });
  assert.equal(resolveRegion('POL', REGIONS).reason, 'country_unsupported', 'GDPR does not imply coverage');
  assert.equal(resolveRegion(null, REGIONS).reason, 'country_unsupported');
});

test('resolveRegion reports no_dpi as a mode, not an error', () => {
  const r = resolveRegion('JPN', REGIONS);
  assert.equal(r.region, 'apac');
  assert.equal(r.reason, 'no_dpi');
  assert.equal(r.dpi, undefined);
});

test('every country in the table maps to a region that has a default host', () => {
  for (const [country, region] of Object.entries(COUNTRY_REGION)) {
    assert.ok(DEFAULT_HOSTS[region], `${country} -> ${region} has no default host`);
  }
  assert.equal(Object.keys(COUNTRY_REGION).length, 19);
});

test('hasRealIfa rejects a zero-filled opt-out IFA', () => {
  assert.equal(hasRealIfa('00000000-0000-0000-0000-000000000000'), false);
  assert.equal(hasRealIfa(''), false);
  assert.equal(hasRealIfa(null), false);
  assert.equal(hasRealIfa('e621e1f8-c36c-495a-93fc-0c247a3e6e5f'), true);
});

test('cacheKeyFor prefers the IFA tier and normalises case', () => {
  const k = cacheKeyFor(ctx({ device: { ifa: 'abc-def', ip: '1.2.3.4', ua: 'x' } }));
  assert.deepEqual(k, { tier: 'ifa', key: 'iiq:ifa:ABC-DEF' });
});

test('cacheKeyFor falls back to the cohort tier without an IFA', () => {
  const k = cacheKeyFor(ctx({
    device: { ifa: '00000000-0000-0000-0000-000000000000', ip: '203.0.113.42', os: 'iOS', osv: '17.5.1', type: 4, browsers: ['Safari'] },
    inventory: 'site',
  }));
  assert.equal(k.tier, 'cohort');
  assert.equal(k.key, 'iiq:ua:ios_17.5_mobile_webkit_site_203.0.113.42');
});

test('cacheKeyFor uses the IIQ UID only when there is no ip for a cohort', () => {
  const eids = [{ source: 'intentiq.com', uids: [{ id: 'IIQ-UID-1' }] }];
  const k = cacheKeyFor(ctx({ device: {}, user: { eids } }));
  assert.deepEqual(k, { tier: 'iiquid', key: 'iiq:uid:IIQ-UID-1' });
});

test('cacheKeyFor is null when the request carries no identity at all', () => {
  assert.equal(cacheKeyFor(ctx()), null);
});

test('cacheKeyFor never includes the dpi, so deployments share entries', () => {
  const a = cacheKeyFor(ctx({ device: { ifa: 'same-device' } }));
  const b = cacheKeyFor(ctx({ device: { ifa: 'same-device' }, ssp: { id: '999' } }));
  assert.deepEqual(a, b);
});

test('engine ignores the "like Gecko" literal every webkit and blink UA carries', () => {
  const safari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15';
  const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const firefox = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/119.0';
  const at = key => key.split('_')[3];

  assert.equal(at(cohortOf(ctx({ device: { ip: '1.1.1.1', ua: safari } }))), 'webkit');
  assert.equal(at(cohortOf(ctx({ device: { ip: '1.1.1.1', ua: chrome } }))), 'blink');
  assert.equal(at(cohortOf(ctx({ device: { ip: '1.1.1.1', ua: firefox } }))), 'gecko');
});

test('engine skips the GREASE brand client hints inject', () => {
  const browsers = ['Not/A)Brand', 'Chromium', 'Google Chrome'];
  const key = cohortOf(ctx({ device: { ip: '1.1.1.1', os: 'Android', osv: '15', type: 4, browsers } }));
  assert.equal(key.split('_')[3], 'blink');
});

test('cohort drops the patch version so a point release does not fragment the cache', () => {
  const base = { ip: '1.1.1.1', os: 'Android', type: 4, browsers: ['Chrome'] };
  const a = cohortOf(ctx({ device: { ...base, osv: '15.0.1' } }));
  const b = cohortOf(ctx({ device: { ...base, osv: '15.0.7' } }));
  assert.equal(a, b);
  assert.notEqual(a, cohortOf(ctx({ device: { ...base, osv: '16.0.1' } })));
});

test('cohort falls back to the user agent only for what the protocol left empty', () => {
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
  const key = cohortOf(ctx({ device: { ip: '9.9.9.9', ua }, inventory: 'app' }));
  assert.equal(key, 'ios_18.3_mobile_webkit_app_9.9.9.9');
});

test('cohort is null without an ip', () => {
  assert.equal(cohortOf(ctx({ device: { os: 'iOS', osv: '17.0' } })), null);
});

test('cohort takes app vs site from ctx.inventory, not from optional fields', () => {
  const base = { ip: '1.1.1.1', os: 'iOS', osv: '17.0', type: 4, browsers: ['Safari'] };
  const at = key => key.split('_')[4];

  // bundle and page are optional, so an app request that omits bundle must
  // still read as app — the old guess returned neither.
  assert.equal(at(cohortOf({ ...ctx({ device: base }), inventory: 'app' })), 'app');
  assert.equal(at(cohortOf({ ...ctx({ device: base }), inventory: 'site' })), 'site');
  assert.equal(at(cohortOf({ ...ctx({ device: base }), inventory: 'dooh' })), 'dooh');
  assert.equal(at(cohortOf(ctx({ device: base }))), 'inv?', 'no inventory object at all');
});

test('cohort no longer depends on publisher.bundle or content.page', () => {
  const base = { ip: '1.1.1.1', os: 'iOS', osv: '17.0', type: 4, browsers: ['Safari'] };
  const withFields = { ...ctx({ device: base, publisher: { bundle: 'com.app' } }), inventory: 'app' };
  const without = { ...ctx({ device: base }), inventory: 'app' };
  assert.equal(cohortOf(withFields), cohortOf(without), 'same device, same key either way');
});

test('identityFor sends the IFA exactly as received', () => {
  // Their footnote puts the uppercase rule on IDFV alone, and an AAID is
  // conventionally lower case, so normalising it would send an id nobody else
  // sends and fail to resolve.
  const identity = identityFor(ctx({ device: { ifa: 'aaaa-bbbb', ip: '1.2.3.4', ua: 'UA' } }));
  assert.equal(identity.idtype, IDTYPE.IFA);
  assert.equal(identity.pcid, 'aaaa-bbbb');
  assert.equal(identity.ip, '1.2.3.4');
  assert.equal(identity.uas, 'UA');
});

test('the cache key still folds case, even though the outgoing pcid does not', () => {
  const lower = cacheKeyFor(ctx({ device: { ifa: 'aaaa-bbbb' } }));
  const upper = cacheKeyFor(ctx({ device: { ifa: 'AAAA-BBBB' } }));
  assert.deepEqual(lower, upper, 'one device, one entry');
});

test('identityFor sends idtype 8 for CTV and 0 for a site user id', () => {
  const ctv = identityFor(ctx({ device: { ifa: 'roku-1', type: 3 } }));
  assert.equal(ctv.idtype, IDTYPE.CTV);

  const web = identityFor(ctx({ device: { ip: '1.1.1.1' }, user: { id: 'cookie-1' } }));
  assert.equal(web.idtype, IDTYPE.COOKIE);
  assert.equal(web.pcid, 'cookie-1');
});

test('identityFor forwards the IIQ universal id from the incoming eids', () => {
  const eids = [{ source: 'intentiq.com', uids: [{ id: 'UID-9' }] }];
  const identity = identityFor(ctx({ user: { eids } }));
  assert.equal(identity.iiquid, 'UID-9');
});



test('throttle counts demand even while blocking, so a worker with no share still reports it', async () => {
  const { th, calls } = throttleWith(['100:50']);
  for (let i = 0; i < 12; i++) th.admit('D1');
  await th.sync();

  const [demand, blocked] = calls.at(-1);
  assert.equal(demand, 12, 'every attempt counted, not just the granted ones');
  assert.equal(blocked, 7, 'FLOOR granted, the rest recorded as blocked');
});

test('throttle takes a share proportional to its own demand', async () => {
  const { th } = throttleWith(['100:50']);
  for (let i = 0; i < 12; i++) th.admit('D1');
  await th.sync();
  // r=100, fleet demand=50, mine=12 -> 24
  assert.equal(th._states.get('D1').rate, 24);
});

test('throttle never takes more than the discovered rate', async () => {
  const { th } = throttleWith(['40:1']);
  for (let i = 0; i < 12; i++) th.admit('D1');
  await th.sync();
  assert.equal(th._states.get('D1').rate, 40);
});

test('throttle holds the floor when the fleet reported no demand', async () => {
  const { th } = throttleWith(['900:0']);
  th.admit('D1');
  await th.sync();
  assert.equal(th._states.get('D1').rate, th.FLOOR);
});

test('throttle fails closed to the floor when Redis is unreachable', async () => {
  const { th } = throttleWith(['500:1']);
  th.admit('D1');
  await th.sync();
  assert.equal(th._states.get('D1').rate, 500);

  const down = createThrottle({ now: () => 500, redis: async () => null });
  down.admit('D1');
  await down.sync();
  assert.equal(down._states.get('D1').rate, down.FLOOR, 'an outage must not become a flood');
});

test('throttle fails closed when the sync script throws', async () => {
  const { th } = throttleWith(['500:1'], { fail: true });
  th.admit('D1');
  await th.sync();
  assert.equal(th._states.get('D1').rate, th.FLOOR);
});

test('throttle keeps separate budgets per dpi in one round trip', async () => {
  const { th, calls } = throttleWith(['100:10', '200:10']);
  th.admit('DPI-A');
  th.admit('DPI-B');
  th.admit('DPI-B');
  await th.sync();

  assert.equal(calls.length, 1, 'one Redis call regardless of dpi count');
  assert.deepEqual(calls[0], [1, 0, 0, 0, 0, 2, 0, 0, 0, 0]);
  assert.equal(th._states.get('DPI-A').rate, 10);
  assert.equal(th._states.get('DPI-B').rate, 40);
});

test('throttle separates their QPS limit from transport errors', async () => {
  const { th, calls } = throttleWith(['100:10']);
  th.admit('D1');
  th.record('D1', 'qps');
  th.record('D1', 'error');
  th.record('D1', 'ok');
  await th.sync();

  const [, , ok, qps, err] = calls.at(-1);
  assert.deepEqual([ok, qps, err], [1, 1, 1]);
});

test('ttlFor prefers the cttl IntentIQ sent', () => {
  assert.equal(ttlFor(600_000, 'ifa', TTL_CFG), 600_000);
});

test('ttlFor falls back to the configured default for a missing or bad cttl', () => {
  assert.equal(ttlFor(undefined, 'ifa', TTL_CFG), TTL_CFG.ttlMs);
  assert.equal(ttlFor(0, 'ifa', TTL_CFG), TTL_CFG.ttlMs);
  assert.equal(ttlFor('nope', 'ifa', TTL_CFG), TTL_CFG.ttlMs);
});

test('ttlFor caps a cttl that would pin stale eids', () => {
  assert.equal(ttlFor(999_999_999, 'ifa', TTL_CFG), TTL_CFG.maxTtlMs);
});

test('ttlFor keeps the cohort tier short — it is a bucket of devices, not one device', () => {
  assert.equal(ttlFor(86_400_000, 'cohort', TTL_CFG), TTL_CFG.coarseTtlMs);
  assert.equal(ttlFor(60_000, 'cohort', TTL_CFG), 60_000, 'a shorter cttl still wins');
});

test('abTestUuid is only reused for the account that fetched it', () => {
  const entry = entryFor([], 'AB-1', '111');
  assert.equal(abTestUuidFor(entry, '111'), 'AB-1');
  assert.equal(abTestUuidFor(entry, '222'), null, 'another account must not report it');
  assert.equal(abTestUuidFor(entryFor([], 'AB-1', null), '111'), null);
});

test('buildRdata skips a deployment with no dpi of its own', () => {
  assert.equal(buildRdata({ price: 1.5, ext: { iiq: { abTestUuid: 'AB-1' } } }), null);
  assert.equal(buildRdata({ price: 1.5 }), null);
});

test('buildRdata skips when there is no price to report', () => {
  assert.equal(buildRdata({ ext: { iiq: { dpi: '111' } } }), null);
});

test('buildRdata fills the reporting payload from the token', () => {
  const r = buildRdata({
    price: 1.18, req: 'req-1', dsp: '333',
    ext: { iiq: { dpi: '111', abTestUuid: 'AB-1', bidder: 'pubmatic', placementId: 'div1', vrref: 'cnnApp', ip: '1.2.3.4', ua: 'UA' } },
  });
  assert.equal(r.bidderCode, 'pubmatic');
  assert.equal(r.partnerId, '111');
  assert.equal(r.cpm, 1.18);
  assert.equal(r.currency, 'USD');
  assert.equal(r.biddingPlatformId, '4');
  assert.equal(r.abTestUuid, 'AB-1');
  assert.equal(r.partnerAuctionId, 'req-1');
});

test('buildRdata falls back to the dsp id when the bidder is unrecognised', () => {
  const r = buildRdata({ price: 1, dsp: '333', ext: { iiq: { dpi: '111' } } });
  assert.equal(r.bidderCode, '333');
});

test('buildRdata omits abTestUuid rather than sending an empty one', () => {
  const r = buildRdata({ price: 1, dsp: '333', ext: { iiq: { dpi: '111' } } });
  assert.equal('abTestUuid' in r, false);
});

// URLSearchParams is not in the eslint globals allowlist; URL is.
const params = path => new URL(`https://h${path}`).searchParams;

test('s2sPath carries the static params, the dpi and the identity', () => {
  const p = s2sPath('123', { ip: '1.2.3.4', uas: 'Mozilla/5.0 (X)', pcid: 'ABC', idtype: 4 });
  const q = params(p);

  assert.equal(p.split('?')[0], '/profiles_engine/ProfilesEngineServlet');
  assert.equal(q.get('at'), '39');
  assert.equal(q.get('mi'), '10');
  assert.equal(q.get('pt'), '17');
  assert.equal(q.get('dpn'), '1');
  assert.equal(q.get('srvrReq'), 'true');
  assert.equal(q.get('dpi'), '123');
  assert.equal(q.get('uas'), 'Mozilla/5.0 (X)', 'user agent survives encoding intact');
  assert.equal(q.get('idtype'), '4');
});

test('s2sPath sends iiquid without iiqidtype', () => {
  // iiqidtype describes iiqpcid, the browser-side first-party id, and the docs
  // require iiqpcid, iiqidtype and iiqpciddate to travel together. We have no
  // first-party id server-side, so sending one of the three alone was wrong.
  const q = params(s2sPath('1', { iiquid: 'UID' }));
  assert.equal(q.get('iiquid'), 'UID');
  assert.equal(q.get('iiqidtype'), null);
  assert.equal(q.get('iiqpcid'), null);
  assert.equal(q.get('iiqpciddate'), null);
});

test('reportPath url-encodes rdata as one JSON value', () => {
  const rdata = { bidderCode: 'pubmatic', cpm: 1.18, currency: 'USD', abTestUuid: 'a-b-c' };
  const q = params(reportPath('123', rdata));

  assert.equal(q.get('at'), '45');
  assert.equal(q.get('rtype'), '1');
  assert.equal(q.get('dpi'), '123');
  assert.deepEqual(JSON.parse(q.get('rdata')), rdata, 'round-trips through the query string');
});

test('interpretEids reads a good response', () => {
  const body = JSON.stringify({
    data: { eids: [{ source: 'adsrvr.org', uids: [{ id: 'x' }] }] },
    abTestUuid: 'uuid-1',
    cttl: 86400000,
  });
  assert.deepEqual(interpretEids({ status: 'ok', code: 200, body }), {
    outcome: 'ok',
    eids: [{ source: 'adsrvr.org', uids: [{ id: 'x' }] }],
    abTestUuid: 'uuid-1',
    cttl: 86400000,
  });
});

test('interpretEids treats 302 as no data, not a redirect', () => {
  assert.equal(interpretEids({ status: 'ok', code: 302, body: '' }).outcome, 'nodata');
});

test('interpretEids spots the QPS refusal inside an otherwise fine response', () => {
  const res = { status: 'ok', code: 200, body: '{"error":"QPS_LIMIT_REACHED"}' };
  assert.equal(interpretEids(res).outcome, 'qps', 'must not be read as a parse failure');
});

test('interpretEids separates a timeout from an error', () => {
  assert.equal(interpretEids({ status: 'timeout' }).outcome, 'timeout');
  assert.equal(interpretEids({ status: 'error' }).outcome, 'error');
  assert.equal(interpretEids({ status: 'ok', code: 503, body: '' }).outcome, 'error');
});

test('interpretEids reports unparseable json distinctly', () => {
  assert.equal(interpretEids({ status: 'ok', code: 200, body: '{oops' }).outcome, 'badjson');
});

test('interpretEids honours isOptedOut over any eids present', () => {
  const body = JSON.stringify({ isOptedOut: true, data: { eids: [{ source: 'x' }] }, cttl: 600000 });
  const out = interpretEids({ status: 'ok', code: 200, body });
  assert.deepEqual(out.eids, [], 'an opted-out user yields nothing regardless of payload');
  assert.equal(out.cttl, 600000);
});

test('interpretEids caches an empty answer rather than treating it as failure', () => {
  const body = JSON.stringify({ data: { eids: [] }, abTestUuid: 'u', cttl: 600000 });
  const out = interpretEids({ status: 'ok', code: 200, body });
  assert.equal(out.outcome, 'ok');
  assert.deepEqual(out.eids, []);
  assert.equal(out.cttl, 600000, 'their short ttl for a miss is preserved');
});

const IIQ_CTX = {
  price: 1.18, dsp: '333', req: 'req-1',
  ext: { iiq: { dpi: '123', abTestUuid: 'u-1', vrref: 'com.app', placementId: 'slot-1', ip: '1.2.3.4', ua: 'UA' } },
};

function consumerWith(cfg, result = { ok: true, code: 200 }) {
  const sent = [];
  const send = async args => { sent.push(args); if (result instanceof Error) throw result; return result; };
  return { run: createConsumer(cfg, send), sent };
}

test('the impression consumer sends the report to the configured host', async () => {
  const { run, sent } = consumerWith({ reporting: { enabled: true, host: 'reports.example' } });
  await run(IIQ_CTX);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].host, 'reports.example');
  assert.equal(sent[0].dpi, '123');
  assert.equal(sent[0].rdata.abTestUuid, 'u-1');
  assert.equal(sent[0].rdata.cpm, 1.18);
  assert.equal(sent[0].rdata.biddingPlatformId, '4');
});

test('the consumer sends nothing when reporting is off', async () => {
  const { run, sent } = consumerWith({ reporting: { enabled: false, host: 'reports.example' } });
  await run(IIQ_CTX);
  assert.equal(sent.length, 0);
});

test('the consumer sends nothing without a dpi — the one case their spec exempts', async () => {
  const { run, sent } = consumerWith({ reporting: { enabled: true, host: 'h' } });
  await run({ price: 1, ext: { iiq: { abTestUuid: 'u' } } });
  await run({ price: 1 });
  assert.equal(sent.length, 0);
});

test('the consumer survives a transport failure without throwing', async () => {
  const { run } = consumerWith({ reporting: { enabled: true, host: 'h' } }, new Error('socket died'));
  await run(IIQ_CTX);
});

test('the consumer survives a rejected report without throwing', async () => {
  const { run, sent } = consumerWith({ reporting: { enabled: true, host: 'h' } }, { ok: false, code: 503 });
  await run(IIQ_CTX);
  assert.equal(sent.length, 1);
});

test('buildRdata refuses a non-numeric price rather than reporting nonsense', () => {
  assert.equal(buildRdata({ ...IIQ_CTX, price: null }), null);
  assert.equal(buildRdata({ ...IIQ_CTX, price: 'free' }), null);
});

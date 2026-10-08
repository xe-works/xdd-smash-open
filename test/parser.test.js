import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../core/protocol/openrtb25/parser.js';
import { Seat } from '../core/signal.js';

const signal = {
  ssp: new Seat({ type: 'ssp', id: 100, knownBidder: 'pubmatic', params: {} }),
  dsp: new Seat({ type: 'dsp', id: 333, knownBidder: 'triplelift', params: {} }),
  destination: { url: 'https://tlx.3lift.com' },
};

test('parses tmax', () => {
  const ctx = parse({ id: 'r1', imp: [], tmax: 300 }, signal);
  assert.equal(ctx.meta.tmax, 300);
});

test('parses banner impression', () => {
  const body = { imp: [{ id: 'i1', banner: { w: 300, h: 250 }, bidfloor: 0.5 }] };
  const ctx = parse(body, signal);
  assert.equal(ctx.impression.isBanner, true);
  assert.equal(ctx.impression.isVideo, false);
  assert.equal(ctx.impression.width, 300);
  assert.equal(ctx.impression.height, 250);
  assert.equal(ctx.impression.floor, 0.5);
});

test('parses video impression', () => {
  const body = { imp: [{ id: 'i1', video: { w: 640, h: 480, minduration: 5, maxduration: 30 } }] };
  const ctx = parse(body, signal);
  assert.equal(ctx.impression.isVideo, true);
  assert.equal(ctx.impression.videoMinduration, 5);
  assert.equal(ctx.impression.videoMaxduration, 30);
});

test('parses native impression', () => {
  const request = JSON.stringify({
    ver: '1.2',
    plcmttype: 4,
    context: 1,
    assets: [{ id: 1, required: 1, title: { len: 90 } }],
  });
  const ctx = parse({ imp: [{ id: 'i1', native: { ver: '1.2', request } }] }, signal);

  assert.equal(ctx.impression.isNative, true);
  assert.equal(ctx.impression.isBanner, false);
  assert.equal(ctx.impression.nativeVer, '1.2');
  assert.equal(ctx.impression.nativePlcmttype, 4);
  assert.equal(ctx.impression.nativeContext, 1);
  assert.equal(ctx.impression.nativeAssets.length, 1);
  assert.equal(ctx.impression.nativeAssets[0].title.len, 90);
});

test('unwraps a native request nested under "native"', () => {
  const request = JSON.stringify({ native: { plcmttype: 2, assets: [] } });
  const ctx = parse({ imp: [{ id: 'i1', native: { request } }] }, signal);
  assert.equal(ctx.impression.nativePlcmttype, 2);
});

test('native request is parsed lazily, once, and survives a bad payload', () => {
  const request = JSON.stringify({ assets: [] });
  const ctx = parse({ imp: [{ id: 'i1', native: { request } }] }, signal);

  // Non-enumerable, so a spread or clone of the impression cannot force a parse.
  assert.ok(!Object.keys(ctx.impression).includes('nativeRequest'));
  assert.deepEqual({ ...ctx.impression }.nativeRequest, undefined);

  assert.equal(ctx.impression.nativeRequest, ctx.impression.nativeRequest, 'memoised');

  const broken = parse({ imp: [{ id: 'i1', native: { request: '{bad' } }] }, signal);
  assert.equal(broken.impression.nativeRequest, null);
  assert.equal(broken.impression.nativeAssets, null);
});

test('native accessors are null on a non-native impression', () => {
  const ctx = parse({ imp: [{ id: 'i1', banner: { w: 300, h: 250 } }] }, signal);
  assert.equal(ctx.impression.nativeVer, null);
  assert.equal(ctx.impression.nativeRequest, null);
  assert.equal(ctx.impression.nativeAssets, null);
  assert.equal(ctx.impression.nativePlcmttype, null);
});

test('parses gdpr from regs', () => {
  const body = { imp: [], regs: { gdpr: 1 } };
  const ctx = parse(body, signal);
  assert.equal(ctx.privacy.gdpr, 1);
});

test('parses us_privacy from regs.ext', () => {
  const body = { imp: [], regs: { ext: { us_privacy: '1YNN' } } };
  const ctx = parse(body, signal);
  assert.equal(ctx.privacy.usPrivacy, '1YNN');
});

test('parses consent from user.ext', () => {
  const body = { imp: [], user: { ext: { consent: 'CONSENTSTR' } } };
  const ctx = parse(body, signal);
  assert.equal(ctx.privacy.consent, 'CONSENTSTR');
});

test('parses device fields', () => {
  const body = { imp: [], device: { ua: 'agent', ip: '1.2.3.4', geo: { country: 'US' }, ifa: 'ifa-123' } };
  const ctx = parse(body, signal);
  assert.equal(ctx.device.ua, 'agent');
  assert.equal(ctx.device.country, 'US');
  assert.equal(ctx.device.ifa, 'ifa-123');
});


test('parses site content', () => {
  const body = { imp: [], site: { page: 'https://example.com', cat: ['IAB1'], ref: 'https://ref.com' } };
  const ctx = parse(body, signal);
  assert.equal(ctx.content.page, 'https://example.com');
  assert.deepEqual(ctx.content.cats, ['IAB1']);
  assert.equal(ctx.content.ref, 'https://ref.com');
});

test('preserves raw body reference (no clone)', () => {
  const body = { id: 'r1', imp: [] };
  const ctx = parse(body, signal);
  assert.equal(ctx._raw, body);
});

test('passes signal ssp and dsp to ctx', () => {
  const ctx = parse({ imp: [] }, signal);
  assert.equal(ctx.dsp.knownBidder, 'triplelift');
  assert.equal(ctx.ssp.knownBidder, 'pubmatic');
});

test('handles missing device gracefully', () => {
  const ctx = parse({ imp: [] }, signal);
  assert.equal(ctx.device.country, null);
  assert.equal(ctx.device.ua, null);
});

test('folds sua into the flat device fields it mirrors', () => {
  const body = { imp: [], device: { sua: {
    platform: { brand: 'Android', version: ['15', '0', '1'] },
    browsers: [{ brand: 'Not/A)Brand' }, { brand: 'Chromium' }, { brand: 'Google Chrome' }],
    mobile: 1,
  } } };
  const ctx = parse(body, signal);
  assert.equal(ctx.device.os, 'Android');
  assert.equal(ctx.device.osv, '15.0', 'patch component dropped');
  assert.equal(ctx.device.type, 1, 'sua.mobile mapped into the devicetype enum');
  assert.deepEqual(ctx.device.browsers, ['Not/A)Brand', 'Chromium', 'Google Chrome'],
    'every brand kept — client hints inject a GREASE brand and do not guarantee its position');
});

test('plain device fields win over sua', () => {
  const body = { imp: [], device: {
    os: 'iOS', osv: '18.3', devicetype: 4,
    sua: { platform: { brand: 'Android', version: ['15'] }, mobile: 0 },
  } };
  const ctx = parse(body, signal);
  assert.equal(ctx.device.os, 'iOS');
  assert.equal(ctx.device.osv, '18.3');
  assert.equal(ctx.device.type, 4);
});

test('sua.mobile 0 maps to a personal computer', () => {
  const ctx = parse({ imp: [], device: { sua: { mobile: 0 } } }, signal);
  assert.equal(ctx.device.type, 2);
});

test('device fields stay null without sua or plain values', () => {
  const ctx = parse({ imp: [], device: {} }, signal);
  assert.equal(ctx.device.osv, null);
  assert.equal(ctx.device.browsers, null);
  assert.equal(ctx.device.type, null);
});

test('inventory names which inventory object the request carried', () => {
  assert.equal(parse({ imp: [], app: { bundle: 'com.x' } }, signal).inventory, 'app');
  assert.equal(parse({ imp: [], site: { page: 'https://x.com' } }, signal).inventory, 'site');
  assert.equal(parse({ imp: [], dooh: {} }, signal).inventory, 'dooh');
  assert.equal(parse({ imp: [] }, signal).inventory, null);
});

test('inventory does not depend on the optional fields inside app or site', () => {
  // bundle and page are both optional, so deriving app-vs-site from them
  // misreads a request that omits them.
  assert.equal(parse({ imp: [], app: { name: 'Some App' } }, signal).inventory, 'app');
  assert.equal(parse({ imp: [], site: { domain: 'x.com' } }, signal).inventory, 'site');
  assert.equal(parse({ imp: [], app: {} }, signal).inventory, 'app');
  assert.equal(parse({ imp: [], site: {} }, signal).inventory, 'site');
});

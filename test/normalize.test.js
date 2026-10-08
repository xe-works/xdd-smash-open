import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseResponse, buildResponse, buildNoResponse } from '../core/protocol/openrtb25/normalize.js';

const DSP_RESPONSE = {
  id: 'r1',
  seatbid: [{
    seat: 'tl',
    bid: [{ id: 'b1', impid: 'i1', price: 1.5, adm: '<div>ad</div>', w: 300, h: 250 }],
  }],
  cur: 'USD',
};

function makeCtx(responses, rawDsp = DSP_RESPONSE) {
  return {
    responses,
    _rawDspResponse: rawDsp,
    meta: { requestId: 'req-1', tmax: 300, dsp: { latency: 50, status: 'ok', code: 200 }, errors: [] },
  };
}

test('parseResponse returns null for empty body', () => {
  assert.equal(parseResponse(null), null);
  assert.equal(parseResponse({}), null);
  assert.equal(parseResponse({ seatbid: [] }), null);
});

test('parseResponse skips bids without price', () => {
  const body = { seatbid: [{ bid: [{ id: 'b1', impid: 'i1' }] }] };
  assert.equal(parseResponse(body), null);
});

test('parseResponse parses bid fields', () => {
  const bids = parseResponse(DSP_RESPONSE);
  assert.equal(bids.length, 1);
  assert.equal(bids[0].price, 1.5);
  assert.equal(bids[0].id, 'b1');
  assert.equal(bids[0]._seat, 'tl');
});

test('parseResponse tracks seat and bid positions', () => {
  const bids = parseResponse(DSP_RESPONSE);
  assert.equal(bids[0]._seatIndex, 0);
  assert.equal(bids[0]._bidIndex, 0);
});

test('parseResponse tracks position across multiple seats', () => {
  const body = {
    seatbid: [
      { seat: 'a', bid: [{ id: 'b1', impid: 'i1', price: 1.0 }] },
      { seat: 'b', bid: [{ id: 'b2', impid: 'i2', price: 2.0 }] },
    ],
  };
  const bids = parseResponse(body);
  assert.equal(bids[0]._seatIndex, 0);
  assert.equal(bids[1]._seatIndex, 1);
});

test('buildResponse returns null if no responses', () => {
  assert.equal(buildResponse(makeCtx([])), null);
});

test('buildResponse returns null if no _rawDspResponse', () => {
  const ctx = { responses: [{}], _rawDspResponse: null };
  assert.equal(buildResponse(ctx), null);
});

test('buildResponse does not mutate raw DSP response', () => {
  const raw = JSON.parse(JSON.stringify(DSP_RESPONSE));
  const bids = parseResponse(raw);
  buildResponse(makeCtx(bids, raw));
  assert.equal(raw.seatbid[0].bid[0].price, 1.5); // unchanged
});

test('buildResponse removes filtered bids', () => {
  const rawWithTwo = {
    id: 'r1',
    seatbid: [{ seat: 'tl', bid: [
      { id: 'b1', impid: 'i1', price: 1.0 },
      { id: 'b2', impid: 'i2', price: 2.0 },
    ]}],
  };
  const bids = parseResponse(rawWithTwo);
  const ctx = makeCtx([bids[0]], rawWithTwo); // keep only first
  const result = buildResponse(ctx);
  assert.equal(result.seatbid[0].bid.length, 1);
  assert.equal(result.seatbid[0].bid[0].id, 'b1');
});

test('buildResponse applies per-bid patches', () => {
  const bids = parseResponse(DSP_RESPONSE);
  bids[0].set('price', 9.99);
  const result = buildResponse(makeCtx(bids));
  assert.equal(result.seatbid[0].bid[0].price, 9.99);
});

test('buildResponse replaces adm when creative is dirty', () => {
  const bids = parseResponse(DSP_RESPONSE);
  bids[0].creative.inject(adm => adm + '<!-- tracked -->');
  const result = buildResponse(makeCtx(bids));
  assert.ok(result.seatbid[0].bid[0].adm.includes('<!-- tracked -->'));
});

test('buildResponse does not call serialize when creative is clean', () => {
  const bids = parseResponse(DSP_RESPONSE);
  const result = buildResponse(makeCtx(bids));
  // adm should be exactly the original (no transformation applied)
  assert.equal(result.seatbid[0].bid[0].adm, '<div>ad</div>');
});

test('buildResponse includes meta in ext.smash', () => {
  const bids = parseResponse(DSP_RESPONSE);
  const result = buildResponse(makeCtx(bids));
  assert.equal(result.ext.smash.requestId, 'req-1');
  assert.equal(result.ext.smash.dsp.latency, 50);
});

test('buildResponse carries reported feature data in ext.smash.ext', () => {
  const ctx = makeCtx(parseResponse(DSP_RESPONSE));
  ctx._reportExt = { creativeGuard: { rejected: [{ crid: 'cr1', reason: 'no adm' }] } };

  const result = buildResponse(ctx);
  assert.deepEqual(result.ext.smash.ext.creativeGuard.rejected, [{ crid: 'cr1', reason: 'no adm' }]);
});

test('a no-bid carries reported feature data too', () => {
  const ctx = makeCtx([]);
  ctx._reportExt = { creativeGuard: { rejected: 3 } };

  const result = buildNoResponse(ctx);
  assert.deepEqual(result.seatbid, [], 'still a no-bid');
  assert.equal(result.ext.smash.ext.creativeGuard.rejected, 3);
});

test('ext.smash has no ext key when nothing was reported', () => {
  const result = buildResponse(makeCtx(parseResponse(DSP_RESPONSE)));
  assert.equal(result.ext.smash.ext, undefined);
});

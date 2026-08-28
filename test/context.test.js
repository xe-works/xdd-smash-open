import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BidContext, DEFAULT_CONTEXT_FIELDS } from '../core/BidContext.js';

function makeCtx() {
  const c = new BidContext({
    dsp: { id: 'd1', endpointId: 'ep1' },
    ssp: { id: 's1' },
    device: { country: 'US', ifa: 'ifa1' },
  });
  c.experiment = { exp: 'A' };
  return c;
}

const RES = { id: 'b1', impid: '1', price: 1.5, crid: 'cr1', w: 300, h: 250 };

test('serialize() emits the default field set', () => {
  const out = makeCtx().serialize(RES);
  assert.deepEqual(Object.keys(out).sort(), [...DEFAULT_CONTEXT_FIELDS].sort());
  assert.equal(out.dsp, 'd1');
  assert.equal(out.price, 1.5);
  assert.equal(out.crid, 'cr1');
  assert.deepEqual(out.experiment, { exp: 'A' });
});

test('serialize() honours an explicit field list', () => {
  const out = makeCtx().serialize(RES, ['dsp', 'ssp', 'country', 'ifa', 'experiment']);
  assert.deepEqual(out, { dsp: 'd1', ssp: 's1', country: 'US', ifa: 'ifa1', experiment: { exp: 'A' } });
});

test('serialize() skips unknown fields', () => {
  assert.deepEqual(makeCtx().serialize(RES, ['dsp', 'nope']), { dsp: 'd1' });
});

test('res-derived fields read from the bid response', () => {
  const out = makeCtx().serialize({ id: 'x', price: 9, crid: 'y' }, ['bidId', 'price', 'crid']);
  assert.deepEqual(out, { bidId: 'x', price: 9, crid: 'y' });
});

test('endpoint fields map to the seat endpointId', () => {
  assert.deepEqual(makeCtx().serialize(RES, ['dspEndpoint']), { dspEndpoint: 'ep1' });
});

test('track() carries feature data into the token under ext', () => {
  const ctx = makeCtx();
  ctx.track('iiq', { abTestUuid: 'u-1' });
  ctx.track('iiq', { dpi: '123' });
  ctx.track('other', { a: 1 });

  const out = ctx.serialize(RES);
  assert.deepEqual(out.ext, { iiq: { abTestUuid: 'u-1', dpi: '123' }, other: { a: 1 } });
});

test('track() data survives a field list that does not mention it', () => {
  // A feature must not be silently disabled by an operator trimming contextFields.
  const ctx = makeCtx();
  ctx.track('iiq', { abTestUuid: 'u-1' });
  assert.deepEqual(ctx.serialize(RES, ['price']).ext, { iiq: { abTestUuid: 'u-1' } });
});

test('serialize() omits ext entirely when nothing tracked', () => {
  assert.equal('ext' in makeCtx().serialize(RES), false);
});

test('tracked data stays nested, so it cannot be addressed as a flat metric label', () => {
  // A/B recorders resolve labels by flat lookup on the serialized record.
  const ctx = makeCtx();
  ctx.track('iiq', { abTestUuid: 'unique-per-response' });
  const out = ctx.serialize(RES);
  assert.equal(out.abTestUuid, undefined);
  assert.equal(out['ext.iiq.abTestUuid'], undefined);
});

test('header() and endpoint() collect the outbound overrides', () => {
  const ctx = makeCtx();
  assert.equal(ctx.header('Authorization', 'Basic x'), ctx, 'chainable');
  ctx.header('X-Other', '1');
  assert.equal(ctx.endpoint('https://override.example/bid'), ctx, 'chainable');

  assert.deepEqual(ctx._headers, { Authorization: 'Basic x', 'X-Other': '1' });
  assert.equal(ctx._endpoint, 'https://override.example/bid');
});

test('timeLeft() subtracts elapsed time and the overhead, never going negative', () => {
  const ctx = new BidContext({ tmax: 500 });
  const left = ctx.timeLeft(10);
  assert.ok(left > 0 && left <= 490, `expected just under 490, got ${left}`);

  const tight = new BidContext({ tmax: 5 });
  assert.equal(tight.timeLeft(100), 0, 'clamped at zero rather than reporting a negative budget');
});

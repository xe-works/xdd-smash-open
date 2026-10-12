import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pipeline } from '../core/pipeline.js';
import { createRegistry } from '../core/registry.js';

function makeReq(protocol = 'openrtb/2.5') {
  return { headers: { 'x-smash-protocol': protocol } };
}

function makeBidRequest() {
  return {
    id: 'r1',
    imp: [{ id: 'i1', banner: { w: 300, h: 250 }, ext: { smash: {
      dsp: { id: 333, knownBidder: 'triplelift', params: { inventoryCode: 'slot' }, destination: { url: 'https://tlx.3lift.com' } },
      ssp: { id: 100, knownBidder: 'pubmatic' },
    }}}],
    site: { page: 'https://example.com' },
    tmax: 500,
  };
}

function makeDspResponse() {
  return {
    id: 'r1',
    seatbid: [{
      seat: 'tl',
      bid: [{ id: 'b1', impid: 'i1', price: 1.5, adm: '<div>ad</div>', w: 300, h: 250 }],
    }],
    cur: 'USD',
  };
}

function makeClient(result) {
  return { request: async () => result };
}

function isNoBid(result) {
  return Array.isArray(result?.seatbid) && result.seatbid.length === 0;
}

test('returns bid response on success', async () => {
  const registry = createRegistry();
  const client = makeClient({ status: 'ok', body: makeDspResponse() });
  const result = await pipeline(makeReq(), makeBidRequest(), registry, client);
  assert.ok(result);
  assert.equal(result.seatbid[0].bid[0].price, 1.5);
});

test('response has ext.smash meta', async () => {
  const registry = createRegistry();
  const client = makeClient({ status: 'ok', body: makeDspResponse() });
  const result = await pipeline(makeReq(), makeBidRequest(), registry, client);
  assert.ok(result.ext?.smash?.requestId);
  assert.equal(result.ext.smash.dsp.status, 'ok');
});

test('ext.smash has elapsed and pipeline on success', async () => {
  const registry = createRegistry();
  const client = makeClient({ status: 'ok', body: makeDspResponse() });
  const result = await pipeline(makeReq(), makeBidRequest(), registry, client);
  assert.ok(result.ext.smash.elapsed >= 0);
  assert.ok(Array.isArray(result.ext.smash.pipeline));
});

test('no-bid on DSP no-bid: seatbid empty + ext.smash', async () => {
  const registry = createRegistry();
  const client = makeClient({ status: 'no-bid' });
  const result = await pipeline(makeReq(), makeBidRequest(), registry, client);
  assert.ok(isNoBid(result));
  assert.ok(result.ext?.smash?.requestId);
  assert.equal(result.ext.smash.dsp.status, 'no-bid');
});

test('no-bid on DSP timeout: dsp.status=timeout', async () => {
  const registry = createRegistry();
  const client = makeClient({ status: 'timeout' });
  const result = await pipeline(makeReq(), makeBidRequest(), registry, client);
  assert.ok(isNoBid(result));
  assert.equal(result.ext.smash.dsp.status, 'timeout');
});

test('no-bid when prebid-dsp hook blocks: blockedBy=prebid-dsp', async () => {
  const registry = createRegistry();
  registry.register('prebid-dsp', null, () => null, 'blocker');
  const client = makeClient({ status: 'ok', body: makeDspResponse() });
  const result = await pipeline(makeReq(), makeBidRequest(), registry, client);
  assert.ok(isNoBid(result));
  assert.equal(result.ext.smash.blockedBy, 'prebid-dsp');
});

test('no-bid when prebid-ssp blocks: blockedBy=prebid-ssp, no dsp field', async () => {
  const registry = createRegistry();
  registry.register('prebid-ssp', null, () => null, 'blocker');
  const client = makeClient({ status: 'ok', body: makeDspResponse() });
  const result = await pipeline(makeReq(), makeBidRequest(), registry, client);
  assert.ok(isNoBid(result));
  assert.equal(result.ext.smash.blockedBy, 'prebid-ssp');
  assert.equal(result.ext.smash.dsp, undefined);
});

test('records blockedBy when hook returns null', async () => {
  let capturedCtx;
  const registry = createRegistry();
  registry.register('prebid-ssp', null, ctx => { capturedCtx = ctx; return null; }, 'spy');
  const client = makeClient({ status: 'ok', body: makeDspResponse() });
  await pipeline(makeReq(), makeBidRequest(), registry, client);
  assert.equal(capturedCtx.meta.blockedBy, 'prebid-ssp');
});

test('catches handler errors and records them in meta.errors', async () => {
  let capturedCtx;
  const registry = createRegistry();
  registry.register('prebid-ssp', null, ctx => { capturedCtx = ctx; return ctx; }, 'passthrough');
  registry.register('prebid-dsp', null, () => { throw new Error('boom'); }, 'thrower');
  const client = makeClient({ status: 'ok', body: makeDspResponse() });
  await pipeline(makeReq(), makeBidRequest(), registry, client);
  assert.equal(capturedCtx.meta.errors.length, 1);
  assert.equal(capturedCtx.meta.errors[0].error, 'boom');
});

test('throws ProtocolError on missing protocol header', async () => {
  const registry = createRegistry();
  const client = makeClient({ status: 'ok', body: makeDspResponse() });
  await assert.rejects(
    () => pipeline({ headers: {} }, makeBidRequest(), registry, client),
    { name: 'ProtocolError' },
  );
});

test('prebid hook can modify request (set patches)', async () => {
  const registry = createRegistry();
  registry.register('prebid-dsp', null, ctx => {
    ctx.set('imp.secure', 1);
    return ctx;
  }, 'hook');

  let capturedDspBody;
  const client = {
    request: async ({ body }) => {
      capturedDspBody = body;
      return { status: 'no-bid' };
    },
  };

  await pipeline(makeReq(), makeBidRequest(), registry, client);
  assert.equal(capturedDspBody.imp[0].secure, 1);
});

test('pipeline trace records stages and handler labels', async () => {
  const registry = createRegistry();
  registry.register('prebid-dsp', null, ctx => ctx, 'my-hook');
  const client = makeClient({ status: 'ok', body: makeDspResponse() });
  const result = await pipeline(makeReq(), makeBidRequest(), registry, client);

  const stages = result.ext.smash.pipeline.map(e => e.stage);
  assert.ok(stages.includes('prebid-dsp'));

  const dspStage = result.ext.smash.pipeline.find(e => e.stage === 'prebid-dsp');
  assert.ok(dspStage.handlers.includes('my-hook'));
});

test('pipeline trace records blocking handler label', async () => {
  const registry = createRegistry();
  registry.register('postbid-ssp', null, () => null, 'my-filter');
  const client = makeClient({ status: 'ok', body: makeDspResponse() });
  const result = await pipeline(makeReq(), makeBidRequest(), registry, client);

  assert.ok(isNoBid(result));
  const stage = result.ext.smash.pipeline.find(e => e.stage === 'postbid-ssp');
  assert.ok(stage.handlers.includes('my-filter'));
  assert.equal(result.ext.smash.blockedBy, 'postbid-ssp');
});

test('no-bid response always has ext.smash.elapsed', async () => {
  const registry = createRegistry();
  registry.register('prebid-ssp', null, () => null, 'early-block');
  const client = makeClient({ status: 'ok', body: makeDspResponse() });
  const result = await pipeline(makeReq(), makeBidRequest(), registry, client);
  assert.ok(result.ext.smash.elapsed >= 0);
});

// stored response

test('storedResponse: DSP client is not called when hook sets ctx._storedResponse', async () => {
  const registry = createRegistry();
  let clientCalled = false;
  const client = { request: async () => { clientCalled = true; return { status: 'ok', body: makeDspResponse() }; } };
  registry.register('prebid-dsp', null, ctx => {
    ctx._storedResponse = makeDspResponse();
    ctx.responses = [];
    return ctx;
  }, 'stored-response-hook');
  await pipeline(makeReq(), makeBidRequest(), registry, client);
  assert.equal(clientCalled, false);
});

test('storedResponse: bid from _storedResponse is returned', async () => {
  const registry = createRegistry();
  const stored = { id: 'r1', seatbid: [{ seat: 'mock', bid: [{ id: 'b1', impid: 'i1', price: 5.0, adm: '<div>stored</div>', w: 300, h: 250 }] }], cur: 'USD' };
  registry.register('prebid-dsp', null, ctx => {
    ctx._storedResponse = stored;
    return ctx;
  }, 'stored-response-hook');
  const client = makeClient({ status: 'ok', body: makeDspResponse() });
  const result = await pipeline(makeReq(), makeBidRequest(), registry, client);
  assert.ok(result.seatbid?.length > 0);
  assert.equal(result.seatbid[0].bid[0].price, 5.0);
});

test('storedResponse: ctx._rawDspResponse is set to _storedResponse body', async () => {
  const registry = createRegistry();
  const stored = makeDspResponse();
  let capturedCtx;
  registry.register('prebid-dsp', null, ctx => {
    ctx._storedResponse = stored;
    return ctx;
  }, 'stored-response-hook');
  registry.register('postbid-dsp', null, ctx => {
    capturedCtx = ctx;
    return ctx;
  }, 'spy');
  const client = makeClient({ status: 'ok', body: makeDspResponse() });
  await pipeline(makeReq(), makeBidRequest(), registry, client);
  assert.equal(capturedCtx._rawDspResponse, stored);
});

test('storedResponse: postbid-dsp and postbid-ssp hooks run after stored response', async () => {
  const registry = createRegistry();
  const stages = [];
  registry.register('prebid-dsp', null, ctx => { ctx._storedResponse = makeDspResponse(); return ctx; }, 'stored');
  registry.register('postbid-dsp', null, ctx => { stages.push('postbid-dsp'); return ctx; }, 'spy-postbid-dsp');
  registry.register('postbid-ssp', null, ctx => { stages.push('postbid-ssp'); return ctx; }, 'spy-postbid-ssp');
  const client = makeClient({ status: 'ok', body: makeDspResponse() });
  await pipeline(makeReq(), makeBidRequest(), registry, client);
  assert.ok(stages.includes('postbid-dsp'));
  assert.ok(stages.includes('postbid-ssp'));
});

test('storedResponse: postbid hook can block stored response', async () => {
  const registry = createRegistry();
  registry.register('prebid-dsp', null, ctx => { ctx._storedResponse = makeDspResponse(); return ctx; }, 'stored');
  registry.register('postbid-dsp', null, () => null, 'blocker');
  const client = makeClient({ status: 'ok', body: makeDspResponse() });
  const result = await pipeline(makeReq(), makeBidRequest(), registry, client);
  assert.ok(isNoBid(result));
  assert.equal(result.ext.smash.blockedBy, 'postbid-dsp');
});

test('core metrics carry the client the caller named', async () => {
  // One install serves several seats, so every core metric has to say whose
  // request it was. The caller states it in ext.smash.ext, which is the only
  // place that is about the caller rather than about a seat.
  const { registry: metrics } = await import('../core/metrics.js');

  const body = makeBidRequest();
  body.imp[0].ext.smash.ext = { client: 'acme' };
  await pipeline(makeReq(), body, createRegistry(), makeClient({ status: 'ok', body: makeDspResponse() }));

  const requests = await metrics.getSingleMetricAsString('smash_requests_total');
  assert.match(requests, /client="acme"/);

  const duration = await metrics.getSingleMetricAsString('smash_request_duration_milliseconds');
  assert.match(duration, /client="acme"/);
});

test('a caller that names no client is counted, not dropped', async () => {
  const { registry: metrics } = await import('../core/metrics.js');

  await pipeline(makeReq(), makeBidRequest(), createRegistry(), makeClient({ status: 'ok', body: makeDspResponse() }));

  const requests = await metrics.getSingleMetricAsString('smash_requests_total');
  assert.match(requests, /client="unknown"/, 'an older caller still shows up, under a name that says so');
});

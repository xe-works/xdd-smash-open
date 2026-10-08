import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSignal, SignalError } from '../core/signal.js';

test('reads from imp[0].ext.smash', () => {
  const body = {
    imp: [{ ext: { smash: {
      dsp: { id: 333, knownBidder: 'triplelift', destination: { url: 'https://tlx.3lift.com' } },
    }}}],
  };
  const signal = readSignal(body);
  assert.equal(signal.dsp.id, '333');
  assert.equal(signal.dsp.knownBidder, 'triplelift');
});

test('falls back to body.ext.smash', () => {
  const body = {
    ext: { smash: {
      dsp: { id: 555, destination: { url: 'https://example.com' } },
    }},
  };
  const signal = readSignal(body);
  assert.equal(signal.dsp.id, '555');
});

test('destination.url comes from dsp.destination.url', () => {
  const body = { ext: { smash: {
    dsp: { id: 1, destination: { url: 'https://tlx.3lift.com' } },
  }}};
  const signal = readSignal(body);
  assert.equal(signal.destination.url, 'https://tlx.3lift.com');
});

test('throws SignalError if no ext.smash', () => {
  assert.throws(() => readSignal({}), SignalError);
});

test('throws SignalError if missing dsp.id', () => {
  const body = { ext: { smash: { dsp: { destination: { url: 'x' } } } } };
  assert.throws(() => readSignal(body), /dsp.id required/);
});

test('throws SignalError if missing dsp.destination.url', () => {
  const body = { ext: { smash: { dsp: { id: 1 } } } };
  assert.throws(() => readSignal(body), /dsp.destination.url required/);
});

test('throws SignalError if dsp.destination.url is empty', () => {
  const body = { ext: { smash: { dsp: { id: 1, destination: {} } } } };
  assert.throws(() => readSignal(body), /dsp.destination.url required/);
});

test('dsp.params from ext.smash.dsp.params', () => {
  const body = { ext: { smash: {
    dsp: { id: 1, params: { accountId: 'abc' }, destination: { url: 'https://x.com' } },
  }}};
  const signal = readSignal(body);
  assert.equal(signal.dsp.params.accountId, 'abc');
});

test('ssp is null if not provided', () => {
  const body = { ext: { smash: {
    dsp: { id: 1, destination: { url: 'https://x.com' } },
  }}};
  const signal = readSignal(body);
  assert.equal(signal.ssp, null);
});

test('passes signal ssp and dsp to ctx', () => {
  const body = { ext: { smash: {
    dsp: { id: 1, destination: { url: 'https://x.com' } },
    ssp: { id: 100, knownBidder: 'pubmatic' },
  }}};
  const signal = readSignal(body);
  assert.equal(signal.ssp.id, '100');
  assert.equal(signal.ssp.knownBidder, 'pubmatic');
});

test('carries ext.smash.ext through as caller data', () => {
  const body = {
    ext: { smash: {
      dsp: { id: 1, destination: { url: 'https://d.example' } },
      ext: { client: 'adoptlabs', endpoint: 'http://smash.adoptlabs.live/' },
    }},
  };
  assert.deepEqual(readSignal(body).ext, {
    client: 'adoptlabs',
    endpoint: 'http://smash.adoptlabs.live/',
  });
});

test('ext defaults to an empty object, so a feature can read it unguarded', () => {
  const body = { ext: { smash: { dsp: { id: 1, destination: { url: 'https://d.example' } } } } };
  assert.deepEqual(readSignal(body).ext, {});
});

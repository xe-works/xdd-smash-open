export class SignalError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'SignalError';
    this.status = 400;
  }
}

export class Seat {
  constructor({ type, id, knownBidder, endpointId, params }) {
    this.type = type;
    this.id = id != null ? String(id) : id;
    this.knownBidder = knownBidder ?? null;
    this.endpointId = endpointId ?? null;
    this.params = params ?? {};
  }
}

export function readSignal(body) {
  const smash = body?.imp?.[0]?.ext?.smash ?? body?.ext?.smash;

  if (!smash) throw new SignalError('Missing ext.smash in request');
  if (!smash.dsp?.id) throw new SignalError('ext.smash.dsp.id required');
  if (!smash.dsp?.destination?.url) throw new SignalError('ext.smash.dsp.destination.url required');

  return {
    ssp: smash.ssp ? new Seat({ type: 'ssp', ...smash.ssp, params: smash.ssp.params ?? {} }) : null,
    dsp: new Seat({ type: 'dsp', ...smash.dsp, params: smash.dsp.params ?? {} }),
    destination: { url: smash.dsp.destination.url },
    // Free-form data from whoever built the request. Anything outside dsp/ssp
    // used to be dropped here, so a caller had no way to say something that was
    // not about one seat — its own identity, for one.
    ext: smash.ext ?? {},
  };
}

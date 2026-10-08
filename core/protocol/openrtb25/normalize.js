import { performance } from 'node:perf_hooks';
import { BidResponse } from '../../BidResponse.js';
import { setPath } from '../../utils.js';

// DSP OpenRTB 2.5 response → BidResponse[]
export function parseResponse(body) {
  if (!body) return null;

  const seatbid = body.seatbid;
  if (!Array.isArray(seatbid) || seatbid.length === 0) return null;

  const bids = [];

  for (let si = 0; si < seatbid.length; si++) {
    const seat = seatbid[si];
    if (!Array.isArray(seat.bid)) continue;

    for (let bi = 0; bi < seat.bid.length; bi++) {
      const bid = seat.bid[bi];
      if (!bid || bid.price === undefined) continue;
      bids.push(new BidResponse(bid, seat.seat ?? null, si, bi));
    }
  }

  return bids.length > 0 ? bids : null;
}

function buildSmashMeta(ctx) {
  return {
    requestId: ctx.meta.requestId,
    elapsed: ctx.meta.startTime != null ? performance.now() - ctx.meta.startTime : undefined,
    tmax: ctx.meta.tmax,
    blockedBy: ctx.meta.blockedBy ?? undefined,
    blockReason: ctx.meta.blockReason ?? undefined,
    dsp: ctx.meta.dsp?.status != null ? ctx.meta.dsp : undefined,
    pipeline: ctx.meta.pipeline?.length ? ctx.meta.pipeline : undefined,
    warnings: ctx.meta.warnings?.length ? ctx.meta.warnings : undefined,
    errors: ctx.meta.errors?.length ? ctx.meta.errors : undefined,
    ext: ctx._reportExt ?? undefined,
  };
}

// No-bid response — always returned instead of 204.
// XE determines no-bid by seatbid: [].
export function buildNoResponse(ctx) {
  return {
    seatbid: [],
    ext: { smash: buildSmashMeta(ctx) },
  };
}

// BidContext → OpenRTB 2.5 response body (proxy: clone + patches).
export function buildResponse(ctx) {
  if (!ctx.responses.length) return null;
  if (!ctx._rawDspResponse) return null;

  const body = structuredClone(ctx._rawDspResponse);

  const included = new Set(ctx.responses.map(r => `${r._seatIndex}:${r._bidIndex}`));

  for (const res of ctx.responses) {
    const bid = body.seatbid?.[res._seatIndex]?.bid?.[res._bidIndex];
    if (!bid) continue;

    for (const { path, value } of res._patches) {
      setPath(bid, path, value);
    }

    if (res.creative?._dirty) {
      bid.adm = res.creative.serialize();
    }
  }

  for (let si = 0; si < (body.seatbid ?? []).length; si++) {
    const seat = body.seatbid[si];
    if (!Array.isArray(seat.bid)) continue;
    seat.bid = seat.bid.filter((_, bi) => included.has(`${si}:${bi}`));
  }

  body.seatbid = (body.seatbid ?? []).filter(s => s.bid?.length > 0);

  if (!body.seatbid.length) return null;

  body.ext = body.ext ?? {};
  body.ext.smash = buildSmashMeta(ctx);

  return body;
}

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveConfig, variantFor } from '../../core/config.js';
import { mergeConfig } from '../../core/utils.js';
import { matchesTarget } from '../../core/registry.js';
import { defineCounter, defineHistogram } from '../../core/metrics.js';
import { getRedis } from './redis.js';
import { resolveRegion } from './regions.js';
import { cacheKeyFor, identityFor } from './identity.js';
import { entryFor, abTestUuidFor, ttlFor, read, write } from './cache.js';
import { fetchEids } from './client.js';
import { createThrottle } from './throttle.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, '../..');

const _cfg = loadConfig(resolve(__dir, 'config.json'), resolve(ROOT, 'config.json'), 'intentIq');

const total = defineCounter(
  'smash_intent_iq_total',
  'IntentIQ decisions by result',
  ['endpoint_id', 'ssp_id', 'result', 'tier', 'variant'],
);

const eidsPerBid = defineHistogram(
  'smash_intent_iq_eids',
  'eids attached per enriched request',
  ['tier'],
  [1, 2, 3, 5, 8, 13, 21],
);

const fetchMs = defineHistogram(
  'smash_intent_iq_fetch_milliseconds',
  'IntentIQ S2S call duration by outcome',
  ['outcome'],
  [5, 10, 25, 50, 100, 250, 500, 1000],
);

export const throttle = createThrottle({ redis: () => getRedis(_cfg.redisUrl) });

function record(ctx, result, tier = 'none') {
  total.inc({
    endpoint_id: ctx.dsp?.endpointId ?? ctx.dsp?.id ?? 'unknown',
    ssp_id: ctx.ssp?.endpointId ?? ctx.ssp?.id ?? 'unknown',
    result,
    tier,
    variant: variantFor(ctx, 'intentIq'),
  });
}

// Never replace what the SSP sent: their eids are the input we read iiquid from,
// and dropping them would lose data we do not own.
function mergeEids(incoming, fresh) {
  const seen = new Set((incoming ?? []).map(e => e.source));
  const merged = [...(incoming ?? [])];
  for (const eid of fresh) if (!seen.has(eid.source)) merged.push(eid);
  return merged;
}

function apply(ctx, eids, tier) {
  if (!eids?.length) return false;
  const merged = mergeEids(ctx.user?.eids, eids);
  ctx.set('user.eids', merged);
  ctx.set('user.ext.eids', merged);
  eidsPerBid.observe({ tier }, eids.length);
  return true;
}

function trackForReporting(ctx, dpi, abTestUuid) {
  ctx.track('iiq', {
    dpi,
    abTestUuid,
    bidder: ctx.dsp?.knownBidder ?? null,
    placementId: ctx.impression?.inventoryCode ?? '',
    vrref: ctx.publisher?.bundle ?? ctx.publisher?.domain ?? '',
    ip: ctx.device?.ip ?? null,
    ua: ctx.device?.ua ?? null,
  });
}

async function fetchAndStore(ctx, cfg, redis, region, keyed, deps) {
  const started = Date.now();
  const res = await deps.fetch({
    host: region.host,
    dpi: region.dpi,
    identity: identityFor(ctx),
    gdpr: ctx.privacy?.gdpr,
    consent: ctx.privacy?.consent,
    timeoutMs: cfg.timeoutMs,
  });
  fetchMs.observe({ outcome: res.outcome }, Date.now() - started);

  deps.gate.record(region.dpi, res.outcome === 'ok' ? 'ok' : res.outcome === 'qps' ? 'qps' : 'error');
  if (res.outcome !== 'ok') return res;

  try {
    const entry = entryFor(res.eids, res.abTestUuid, region.dpi);
    await write(redis, keyed.key, entry, ttlFor(res.cttl, keyed.tier, cfg));
  } catch { /* the eids are still usable */ }

  return res;
}

export async function _run(ctx, cfg, redis, deps = {}) {
  const d = { fetch: fetchEids, gate: throttle, ...deps };

  if (!(cfg.targets ?? [{}]).some(t => matchesTarget(t, ctx))) {
    record(ctx, 'skip_no_target');
    return ctx;
  }

  const keyed = cacheKeyFor(ctx);
  if (!keyed) { record(ctx, 'skip_no_key'); return ctx; }

  // Without a cache every request becomes a fetch, which burns the account
  // instead of degrading.
  if (!redis) { record(ctx, 'skip_redis', keyed.tier); return ctx; }

  const region = resolveRegion(ctx.device?.country, cfg.regions);

  try {
    const hit = await read(redis, keyed.key);
    if (hit) {
      if (region.dpi) trackForReporting(ctx, region.dpi, abTestUuidFor(hit, region.dpi));
      record(ctx, apply(ctx, hit.eids, keyed.tier) ? 'cache_hit' : 'cache_hit_empty', keyed.tier);
      return ctx;
    }
  } catch {
    record(ctx, 'redis_error', keyed.tier);
    return ctx;
  }

  if (region.reason) { record(ctx, region.reason, keyed.tier); return ctx; }
  if (!d.gate.admit(region.dpi)) { record(ctx, 'throttled', keyed.tier); return ctx; }

  if (!cfg.awaitFetch) {
    void fetchAndStore(ctx, cfg, redis, region, keyed, d).catch(() => {});
    record(ctx, 'deferred', keyed.tier);
    return ctx;
  }

  const res = await fetchAndStore(ctx, cfg, redis, region, keyed, d);
  if (res.outcome !== 'ok') {
    record(ctx, res.outcome === 'timeout' ? 'fetch_timeout' : 'fetch_error', keyed.tier);
    return ctx;
  }

  trackForReporting(ctx, region.dpi, res.abTestUuid);
  record(ctx, apply(ctx, res.eids, keyed.tier) ? 'enriched' : 'fetched_empty', keyed.tier);
  return ctx;
}

export default async function intentIqHook(ctx) {
  const cfg = mergeConfig(resolveConfig(ctx, _cfg, 'intentIq'), ctx.dsp?.params?.intentIq);
  if (!cfg.enabled) return ctx;

  const redis = cfg.redisUrl ? await getRedis(cfg.redisUrl) : null;
  return _run(ctx, cfg, redis);
}

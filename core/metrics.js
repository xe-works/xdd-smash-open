import { Registry, Counter, Histogram } from 'prom-client';

export const registry = new Registry();

const requestsTotal = new Counter({
  name: 'smash_requests_total',
  help: 'Total bid requests processed',
  labelNames: ['client', 'endpoint_id', 'outcome'],
  registers: [registry],
});

const requestDuration = new Histogram({
  name: 'smash_request_duration_milliseconds',
  help: 'Total pipeline duration in ms',
  labelNames: ['client', 'endpoint_id'],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [registry],
});

const dspLatency = new Histogram({
  name: 'smash_dsp_latency_milliseconds',
  help: 'DSP HTTP call duration in ms',
  labelNames: ['client', 'endpoint_id', 'dsp_status'],
  buckets: [10, 25, 50, 100, 200, 300, 500, 1000, 2500, 5000],
  registers: [registry],
});

const dspOverhead = new Histogram({
  name: 'smash_overhead_milliseconds',
  help: 'Smash processing overhead for requests that reached DSP (total elapsed - DSP latency)',
  labelNames: ['client', 'endpoint_id'],
  buckets: [0.1, 0.2, 0.5, 1, 2, 5, 10, 25, 50, 100],
  registers: [registry],
});

const blocksTotal = new Counter({
  name: 'smash_blocks_total',
  help: 'Requests blocked by pipeline',
  labelNames: ['client', 'endpoint_id', 'blocked_by', 'reason'],
  registers: [registry],
});

// Called by pipeline after every request — features do not call this directly.
export function recordRequest(ctx, durationMs, hasBid = false) {
  const endpointId = ctx.dsp.endpointId ?? ctx.dsp.id ?? 'unknown';

  // Who the request came from, as the caller stated it in ext.smash.ext. One
  // install serving several seats is otherwise one undifferentiated pile of
  // numbers: no way to tell whose spend, whose overhead or whose blocks. Costs
  // nothing in cardinality, since an endpoint belongs to one caller.
  const client = ctx.ext?.client ?? 'unknown';

  let outcome = 'nobid';
  if (ctx.meta.errors?.length) outcome = 'error';
  else if (ctx.meta.blockedBy) outcome = 'blocked';
  else if (hasBid) outcome = 'bid';

  requestsTotal.inc({ client, endpoint_id: endpointId, outcome });
  requestDuration.observe({ client, endpoint_id: endpointId }, durationMs);

  if (ctx.meta.blockedBy) {
    blocksTotal.inc({
      client,
      endpoint_id: endpointId,
      blocked_by: ctx.meta.blockedBy,
      reason: ctx.meta.blockLabel ?? 'unknown',
    });
  }

  if (ctx.meta.dsp.latency != null) {
    dspLatency.observe(
      { client, endpoint_id: endpointId, dsp_status: ctx.meta.dsp.status ?? 'unknown' },
      ctx.meta.dsp.latency,
    );
    dspOverhead.observe({ client, endpoint_id: endpointId }, Math.max(0, durationMs - ctx.meta.dsp.latency));
  }
}

// Extension API — use in features or fork-specific code to add custom metrics
// into the same Prometheus registry as the built-in metrics.
//
// Define at module level (not inside functions) to avoid duplicate registration errors.
//
// Example:
//   const dedupHits = defineCounter('smash_myfeature_events_total', 'My events', ['endpoint_id']);
//   dedupHits.inc({ endpoint_id: ctx.dsp.endpointId ?? 'unknown' });

export function defineCounter(name, help, labelNames = []) {
  return new Counter({ name, help, labelNames, registers: [registry] });
}

export function defineHistogram(name, help, labelNames = [], buckets) {
  return new Histogram({ name, help, labelNames, ...(buckets && { buckets }), registers: [registry] });
}

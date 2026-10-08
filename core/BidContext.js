import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const CONTEXT_FIELDS = {
  req: (ctx) => ctx.meta.requestId,
  ts: () => Date.now(),
  dsp: (ctx) => ctx.dsp?.id ?? null,
  ssp: (ctx) => ctx.ssp?.id ?? null,
  dspEndpoint: (ctx) => ctx.dsp?.endpointId ?? null,
  sspEndpoint: (ctx) => ctx.ssp?.endpointId ?? null,
  country: (ctx) => ctx.device?.country ?? null,
  os: (ctx) => ctx.device?.os ?? null,
  ifa: (ctx) => ctx.device?.ifa ?? null,
  domain: (ctx) => ctx.publisher?.domain ?? null,
  bundle: (ctx) => ctx.publisher?.bundle ?? null,
  bidId: (_ctx, res) => res?.id ?? null,
  impid: (_ctx, res) => res?.impid ?? null,
  price: (_ctx, res) => res?.price ?? null,
  crid: (_ctx, res) => res?.crid ?? null,
  w: (_ctx, res) => res?.w ?? null,
  h: (_ctx, res) => res?.h ?? null,
  experiment: (ctx) => ctx.experiment,
  pipeline: (ctx) => ctx.meta.pipeline,
};

export const DEFAULT_CONTEXT_FIELDS = ['req', 'ts', 'dsp', 'ssp', 'price', 'crid', 'experiment', 'pipeline'];

// imp.native.request arrives as a JSON string. Parsing it costs real work on
// every request while most adapters never look at it, so the parsed view is
// attached as memoised accessors instead. Non-enumerable so a later spread or
// structuredClone of the impression can't quietly force the parse.
function withNativeRequest(imp) {
  let parsed;
  const request = () => {
    if (parsed === undefined) {
      try {
        const doc = imp.nativeRequestRaw ? JSON.parse(imp.nativeRequestRaw) : null;
        parsed = doc && typeof doc === 'object' ? (doc.native ?? doc) : null;
      } catch {
        parsed = null;
      }
    }
    return parsed;
  };

  return Object.defineProperties(imp, {
    nativeRequest: { get: request },
    nativeAssets: { get: () => request()?.assets ?? null },
    nativePlcmttype: { get: () => request()?.plcmttype ?? null },
    nativeContext: { get: () => request()?.context ?? null },
  });
}

export class BidContext {
  constructor({ ssp, dsp, destination, ext, inventory, impressions, device, user, publisher, privacy, content, signals, tmax, raw }) {
    this.ssp = ssp;
    this.dsp = dsp;
    this.destination = destination;

    // Whatever the caller put in ext.smash.ext. Read-only as far as the
    // pipeline is concerned; the outbound counterpart is report().
    this.ext = ext ?? {};

    // 'app' | 'site' | 'dooh' | null — which inventory object the request carried
    this.inventory = inventory ?? null;

    // Array of impressions — pipeline works with [0], but patches broadcast to all
    this.impressions = (impressions ?? []).map(imp => withNativeRequest({
      id: null,
      floor: 0,
      floorCur: 'USD',
      isBanner: false,
      isVideo: false,
      isNative: false,
      isRewarded: false,
      instl: false,
      api: null,
      width: null,
      height: null,
      format: null,
      nativeVer: null,
      nativeRequestRaw: null,
      gpid: null,
      pbadslot: null,
      displaymanager: null,
      displaymanagerver: null,
      ...imp,
    }));

    // Multi-bid responses from DSP
    this.responses = [];

    this.device = {
      country: null,
      os: null,
      osv: null,
      browsers: null,
      type: null,
      make: null,
      model: null,
      ua: null,
      ip: null,
      ifa: null,
      lang: null,
      dnt: 0,
      lmt: 0,
      ...device,
    };

    this.user = {
      id: null,
      buyeruid: null,
      consent: null,
      eids: [],
      ids: {},
      ...user,
    };

    this.publisher = {
      id: null,
      domain: null,
      bundle: null,
      name: null,
      inventoryCode: null,
      ...publisher,
    };

    this.privacy = {
      gdpr: null,
      consent: null,
      usPrivacy: null,
      ...privacy,
    };

    this.content = {
      cats: [],
      pageCats: [],
      sectionCats: [],
      page: null,
      ref: null,
      ...content,
    };

    this.signals = { ...signals };

    // A/B: variant assignments { expId: variant }, per-namespace config patches,
    // and per-namespace variant attribution { namespace: variant } for metrics.
    this.experiment = {};
    this.configOverrides = {};
    this.experimentByNs = {};

    this.meta = {
      requestId: randomUUID(),
      tmax: tmax ?? 0,
      startTime: performance.now(),
      dsp: {
        latency: null,
        status: null,
        code: null,
      },
      errors: [],
      warnings: [],
      blockedBy: null,
      blockReason: null,
      pipeline: [],
    };

    this._raw = raw;
    this._patches = []; // { path, value } — imp.X patches broadcast to ALL imps
    this._headers = {};
    this._endpoint = null;
    this._trackExt = null; // lazy — most requests never track
    this._reportExt = null; // lazy — most requests never report
  }

  // Feature data for the tracking token, read back via tracking.addConsumer.
  // Nested on purpose: A/B labels resolve by flat lookup, so nesting keeps
  // high-cardinality feature data out of Prometheus labels.
  track(namespace, data) {
    this._trackExt ??= {};
    this._trackExt[namespace] = { ...this._trackExt[namespace], ...data };
    return this;
  }

  // Feature data for the platform, returned under ext.smash.ext of the
  // response. Namespaced so two features cannot collide and the reader always
  // knows the owner. Carried on a no-bid too.
  report(namespace, data) {
    this._reportExt ??= {};
    this._reportExt[namespace] = { ...this._reportExt[namespace], ...data };
    return this;
  }

  // Shortcut: first impression (adapters use this in single-imp flow)
  get impression() { return this.impressions[0] ?? null; }

  // Shortcut: first response
  get response() { return this.responses[0] ?? null; }
  set response(v) {
    if (v === null) { this.responses = []; return; }
    this.responses[0] = v;
  }

  // body patch — imp.X paths broadcast to ALL imps in builder
  set(path, value) {
    this._patches.push({ path, value });
    return this;
  }

  header(name, value) {
    this._headers[name] = value;
    return this;
  }

  endpoint(url) {
    this._endpoint = url;
    return this;
  }

  timeLeft(overhead = 10) {
    const elapsed = performance.now() - this.meta.startTime;
    return Math.max(0, this.meta.tmax - elapsed - overhead);
  }

  // Snapshot of this context (+ a bid response) for the tracking token, limited
  // to `fields` (see CONTEXT_FIELDS).
  serialize(res, fields = DEFAULT_CONTEXT_FIELDS) {
    const out = {};
    for (const f of fields) {
      const fn = CONTEXT_FIELDS[f];
      if (fn) out[f] = fn(this, res);
    }
    // Independent of `fields` — a feature must not be silently broken by an
    // operator leaving it out of contextFields.
    if (this._trackExt) out.ext = this._trackExt;
    return out;
  }
}

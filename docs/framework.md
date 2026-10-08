# Framework

xdd-smash is built around one idea: everything is a feature, and a feature is built from hooks.

A hook is a function that receives the request context, does something with it, and returns it. That is the entire model. Whether you are writing a DSP adapter, an SSP filter, a dedup system, or a creative wrapper — it is all hooks. The framework takes care of when to call them and in what order.

The pipeline runs on every bid request. It has four stages. At each stage the framework calls all hooks that match the current request. A hook can pass the request forward, modify it, or stop it entirely by returning `null`.

Features are the unit of packaging. A feature is a directory in `features/` with one or more hooks and a `register(registry)` function. Features are either stateless (no external dependencies, always continue) or stateful (depend on Redis or similar, must be fail-open).

The injector is a built-in feature. It simplifies the daily work of writing DSP and SSP adapters when integrating with [Xeworks](https://xe.works). Instead of registering hooks manually, you drop a file in the right directory and the injector loads it at startup.

Not everything is a per-request hook. HTTP endpoints, callbacks, and shared long-lived clients are services. A service lives in a registry by name and binds to HTTP routes. Features and services are both auto-loaded from their directories at startup, so adding either is dropping a folder.

---

## Contents

1. [Pipeline](#pipeline)
2. [Hook contract](#hook-contract)
3. [Context API](#context-api)
   - [Reading context](#reading)
   - [Modifying the outbound request](#modifying-the-outbound-request-prebid-dsp)
   - [Modifying the bid response](#modifying-the-bid-response-postbid-dsp--postbid-ssp)
   - [Signals](#signals)
   - [Tracking feature data](#tracking-feature-data)
   - [Reporting back to the caller](#reporting-back-to-the-caller)
4. [Injector](#injector)
   - [Directory structure](#directory-structure)
   - [File naming](#file-naming)
   - [Execution order](#execution-order)
   - [Adapter config](#adapter-config)
5. [Features](#features)
   - [Stateless](#stateless)
   - [Stateful](#stateful)
6. [Services and HTTP routing](#services-and-http-routing)
   - [Declaring routes](#declaring-routes)
   - [Using a service from a feature](#using-a-service-from-a-feature)
   - [Auto-loading](#auto-loading)
   - [Reference: tracking + impression-feedback](#reference-tracking--impression-feedback)
7. [A/B testing](#ab-testing)
8. [Examples](#examples)
9. [Glossary](#glossary)

---

## Pipeline

```
Xeworks  -->  xdd-smash
                   |
              prebid-ssp      validate/block before doing anything
                   |
              prebid-dsp      shape the outbound request, set auth headers
                   |
              --- DSP ---     HTTP call to the DSP
                   |
              postbid-dsp     validate/transform the DSP response
                   |
              postbid-ssp     final processing before returning to Xeworks
                   |
Xeworks  <--  response
```

| Stage | When | Typical use |
|---|---|---|
| `prebid-ssp` | Before DSP request is built | Validate SSP context, block bad traffic |
| `prebid-dsp` | Before DSP request is sent | Add DSP fields, set auth headers |
| `postbid-dsp` | After DSP responds | Validate bid, filter |
| `postbid-ssp` | Before returning to Xeworks | Final filtering, creative wrapping |

---

## Hook contract

A hook is an exported default function. It receives `ctx`, modifies it, and returns it. Returning `null` stops the pipeline. Throwing is treated as a no-bid and logged to `ctx.meta.errors`.

```js
export default function(ctx) {
  return ctx;   // continue
  return null;  // no-bid
}

// async is fine
export default async function(ctx) { ... }
```

---

## Context API

### Reading

```js
// DSP — populated from ext.smash.dsp sent by Xeworks
ctx.dsp.id              // DSP seat id (buyer account identifier at the DSP)
ctx.dsp.endpointId      // DSP endpoint id on the Xeworks platform
ctx.dsp.knownBidder     // matched dsp/ directory name, null if not recognized
ctx.dsp.params          // per-request DSP params from ext.smash.dsp.params

// SSP — populated from ext.smash.ssp sent by Xeworks
ctx.ssp.id              // SSP id on the Xeworks platform
ctx.ssp.endpointId      // SSP endpoint id on the Xeworks platform
ctx.ssp.knownBidder     // matched ssp/ directory name, null if not recognized
ctx.ssp.params          // per-request SSP params from ext.smash.ssp.params

// Inventory — which of the mutually exclusive objects the request carried.
// 'app' | 'site' | 'dooh' | null. Read this rather than guessing from
// publisher.bundle or content.page, which are both optional.
ctx.inventory

// Impression (single-imp shortcut — adapters work with impressions[0])
ctx.impression.isBanner
ctx.impression.isVideo
ctx.impression.isNative
ctx.impression.isRewarded     // true when imp.ext.rewarded / ext.prebid.is_rewarded_inventory / imp.rwdd
ctx.impression.instl          // true when imp.instl === 1 (interstitial)
ctx.impression.width
ctx.impression.height
ctx.impression.floor
ctx.impression.inventoryCode  // imp.tagid
ctx.impression.pbadslot
ctx.impression.api            // list of supported API frameworks

// Native detail. imp.native.request is a JSON string; it is parsed on first
// access and memoised, so reading these costs nothing on requests that ignore
// them. Both the bare and the {"native":{...}} wrapped request shape work.
ctx.impression.nativeVer        // imp.native.ver
ctx.impression.nativeRequest    // parsed Native Request object, null if absent/invalid
ctx.impression.nativeAssets     // request.assets
ctx.impression.nativePlcmttype  // request.plcmttype
ctx.impression.nativeContext    // request.context

// Device / user. Structured user agent (device.sua, OpenRTB 2.6) is folded into
// the flat fields it mirrors, so a hook never handles two shapes for one fact.
// A plain field always wins over the sua value it duplicates.
ctx.device.country
ctx.device.os
ctx.device.osv          // device.osv, else sua.platform.version as major.minor
ctx.device.type         // device.devicetype enum, else derived from sua.mobile
ctx.device.browsers     // every sua brand in order, null if absent
ctx.device.ifa
ctx.device.ua
ctx.device.ip
ctx.user.eids
ctx.user.ids

// Privacy
ctx.privacy.gdpr        // 0 | 1 | null
ctx.privacy.consent
ctx.privacy.usPrivacy

// Publisher / content
ctx.publisher.domain
ctx.publisher.bundle
ctx.content.page
ctx.content.cats
```

### Modifying the outbound request (prebid-dsp)

Do not mutate the raw request body directly. Use `ctx.set()` to apply patches:

```js
ctx.set('imp.ext.bidder', { inventoryCode: 'slot' });  // applied to all imps
ctx.set('ext.appnexus', { hb_source: 5 });
ctx.set('site.ext.rp', { site_id: 123 });

ctx.header('Authorization', `Basic ${creds}`);
ctx.endpoint('https://override.dsp.com/bid');
```

### Modifying the bid response (postbid-dsp / postbid-ssp)

```js
const res = ctx.response;  // shortcut for ctx.responses[0]

res.set('price', 1.23);
res.set('adomain', ['foo.com']);

res.creative?.inject(adm => adm.replace('CLICK_URL', trackerUrl));
```

To remove specific bids without returning a full no-bid:

```js
ctx.responses = ctx.responses.filter(r => r.price > 0.5);
return ctx;
```

### Signals

`ctx.signals` is a plain object for passing state between stages of the same request. Only hooks write to it.

```js
// prebid-ssp — write
ctx.signals.blockAdult = ctx.ssp.params.safeMode ?? false;

// postbid-dsp — read
if (ctx.signals.blockAdult) {
  ctx.responses = ctx.responses.filter(r => !ADULT_DOMAINS.has(r.adomain?.[0]));
}
```

### Tracking feature data

`ctx.track(namespace, data)` attaches feature data to the tracking token, to be read back by a tracking consumer when the impression fires. Repeated calls on one namespace merge.

```js
ctx.track('userDedup', { seen: true, source: 'redis' });
```

It is serialized under `ext.<namespace>` regardless of the `contextFields` config, so an operator leaving a field out of that list cannot silently break a feature. The namespace nesting is deliberate: A/B metric labels resolve by flat lookup, so nesting keeps high-cardinality feature data out of Prometheus labels.

### Reporting back to the caller

Four channels reach the caller, all inside `ext.smash` of the response, and all present on a no-bid as well as on a normal one.

```js
ctx.report('creativeGuard', { rejected: [{ crid: 'cr1', reason: 'no adm' }] });
ctx.meta.warnings.push({ feature: 'creative-guard', reason: 'no adm' });
ctx.meta.blockReason = 'creative-guard: all bids rejected';
```

- **`ctx.report(namespace, data)`** — structured, feature-owned data, landing under `ext.smash.ext.<namespace>`. Repeated calls on one namespace merge. Use it for anything the caller is meant to parse. The namespace is the feature name, or the bidder name when the hook is an adapter.
- **`ctx.meta.warnings`** — `{ feature, reason }`, for someone reading a log rather than for a parser.
- **`ctx.meta.blockReason`** — a string, set alongside returning `null`. The pipeline fills in `blockedBy` with the stage by itself.
- **`ctx.meta.errors`** — `{ stage, handler, error }`, pushed by the pipeline when a hook throws. Features do not write to it.

Adapters use the same channels. An adapter is an ordinary hook and the injector only saves it the registration, so an adapter that blocks sets `blockReason` and returns `null` exactly as a feature does.

`report` is the response counterpart of `track` above: same namespacing, but tracked data rides in the tracking token to the impression callback, while reported data goes back to the caller in the bid response.

---

## Injector

Injector is a built-in feature that simplifies writing DSP and SSP adapters when integrating with Xeworks. It discovers and loads hooks from the filesystem automatically at startup. Drop a file in the right directory and it registers itself with no manual wiring.

### Directory structure

```
features/injector/
  dsp/<bidder>/   hooks that run only when ctx.dsp.knownBidder matches
  dsp/_/          hooks that run for any DSP
  ssp/<bidder>/   hooks that run only when ctx.ssp.knownBidder matches
  ssp/_/          hooks that run for any SSP
```

### File naming

The filename encodes which stage to run on and optional targeting filters:

```
{scope.}stage.js
```

| File | Directory | Runs when |
|---|---|---|
| `prebid-dsp.js` | `appnexus` | Any request to Appnexus |
| `seat-333.prebid-dsp.js` | `appnexus` | Appnexus + seat 333 |
| `seat-333.prebid-dsp.js` | `_` | Any DSP, seat 333 |
| `ep-456.postbid-ssp.js` | `_` | Any SSP, endpoint 456 |
| `seat-333.ep-456.prebid-dsp.js` | `appnexus` | Appnexus + seat 333 + endpoint 456 |

Unrecognised filenames (`config.json`, `helpers.js`, etc.) are silently skipped.

### Execution order

Within a stage, hooks run least specific first:

```
dsp/_/seat-123.prebid-dsp.js        score 1  (seat only)
dsp/appnexus/prebid-dsp.js          score 1  (bidder only)
dsp/appnexus/seat-123.prebid-dsp.js score 2  (bidder + seat)
```

### Adapter config

Each adapter directory can have a `config.json` with built-in defaults. The root `config.json` merges over them field by field, so a deployment can override one value inside a nested section without restating the rest of it. Arrays and `null` replace rather than merge. Per-request params from `ext.smash.dsp.params` win last.

```
dsp/magnite/config.json             built-in defaults
config.json["adapters"]["magnite"]  deployment values
ctx.dsp.params                      per-request (wins)
```

```js
import { loadConfig } from '../../../core/config.js';

const cfg = loadConfig(
  resolve(__dir, 'config.json'),
  resolve(ROOT, 'config.json'),
  'adapters.magnite',
);

export default function(ctx) {
  const p = { ...cfg.params, ...ctx.dsp.params };
}
```

---

## Features

Features live in `features/<name>/` and self-register into the pipeline via a `register` function. They are [auto-loaded](#auto-loading) at startup — no wiring in `index.js`. `register` is called positionally as `register(registry, services, cfg)`; take what you need. A feature that only needs the registry keeps the classic `register(registry)` signature.

### Stateless

A stateless feature enriches or filters requests with no external dependencies. Use this pattern for anything that should never block a bid — which makes failure handling the feature's own job. The framework does not swallow exceptions: a hook that throws is recorded in `ctx.meta.errors` and the request ends as a no-bid, exactly as if it had returned `null`. A feature that must not block a bid therefore wraps whatever can fail in `try`/`catch` and returns `ctx`.

`features/geoedge-postbid/` is a reference implementation. It wraps banner creatives with an ad quality script in `postbid-ssp`. It is included as an example and starting point.

```json
{ "geoedge": { "enabled": true, "key": "your-key" } }
```

### Stateful

A stateful feature depends on external state such as Redis or a database. It must be fail-open: if the external service is unreachable, the hook adds a warning to `ctx.meta.warnings` and returns `ctx`. A bid is never blocked because of infrastructure.

`features/user-dedup/` is a reference implementation. It does Redis-backed IFA dedup in `prebid-dsp` and fails open if Redis is not configured or unreachable.

---

## Services and HTTP routing

Hooks run per bid request. Some things do not fit that model: an HTTP endpoint that receives a callback, a shared client, background work. Those are services.

A service is a directory in `services/` with an `index.js` that exports `register(services, cfg)`. It registers an instance into the service registry by name and exposes plain methods. It knows nothing about HTTP.

```js
// services/tracking/index.js
export function register(services, cfg) {
  return services.register('tracking', createTrackingService(cfg.tracking ?? {}));
}
```

### Declaring routes

A service does not touch the router. It declares routes as data via `routes()`; the path comes from its own config, the handler is one of its methods `(req, res) => void`. The framework binds them at startup.

```js
routes() {
  return [
    { method: 'GET',  path: cfg.route, handler: handleCallback },
    { method: 'POST', path: cfg.route, handler: handleCallback },
  ];
}
```

The router matches the exact path, with `*` as a per-method catch-all. The bid endpoint is `POST *`; an exact service route like `POST /t` always beats the catch-all. `GET /metrics` and the bid endpoint are themselves ordinary routes.

### Using a service from a feature

A feature receives the service registry and pulls services by name:

```js
// features/impression-feedback/index.js
export function register(registry, services, cfg) {
  const tracking = services.get('tracking');
  if (cfg.impFeedback?.enabled && tracking?.enabled) {
    registry.register('postbid-ssp', null, hook(cfg.impFeedback, tracking), LABEL);
  }
}
```

### Auto-loading

`services/*` and `features/*` are discovered and loaded at startup — dropping a directory with an `index.js` is enough, the root `index.js` is not touched. Services load before features (features depend on them). `register` is called positionally:

- services: `register(services, cfg)`
- features: `register(registry, services, cfg)`

Extra arguments are ignored, so an existing feature with `register(registry)` keeps working unchanged when this repo is merged into a child fork.

### Reference: tracking + impression-feedback

`services/tracking/` is a reusable service. It packs an arbitrary context object into an opaque token (`pack`), injects a tracker into a creative (`inject`), receives the callback and fans the decoded context out to consumers. `features/impression-feedback/` is a thin `postbid-ssp` feature that decides which creatives to tag and calls `tracking.inject`.

The token is AES-256-GCM ciphertext (base64url transport). Only the fleet holds the key, so only the callback endpoint can decode it — the browser carries ciphertext only. Injection is creative-type aware:

- **display** — a `<script>` appended to the adm (context in a `data-` attribute, beacon via `POST`).
- **video** — a VAST `<Impression>` pixel before every `</InLine>`/`</Wrapper>` (context in `?c=`).
- **native** — an impression tracker added to the parsed Native Ad Response (context in `?c=`). Native 1.2 responses get an `eventtrackers` entry (`event: 1`, `method: 1`); 1.1 responses get an `imptrackers` URL. Exactly one of the two is written, never both — a 1.2 renderer that also honours the legacy field would otherwise count one render twice. `jstracker` is left alone for the same reason. A response counts as 1.2 when it already carries an `eventtrackers` array or declares `ver >= 1.2`.

Native creatives are mutated through `NativeCreative.mutate(fn)`, which hands `fn` the parsed response object (unwrapped from `{"native":{...}}` if wrapped) and shares one parse/stringify round-trip across every queued mutation. A non-JSON adm is returned untouched rather than corrupted.

Consumers are the seam for collection; there are none by default. Enable via the `tracking` and `impFeedback` config namespaces (both ship `enabled: false`).

---

## A/B testing

Experiments split traffic into variants and change behaviour per request via **config overrides**; the assignment rides into the tracking token for attribution.

```json
"abTesting": { "enabled": true, "experiments": [
  { "id": "dedup-ttl",
    "metrics": [
      { "on": "postbid-dsp", "labels": ["experiment", "variant", "dsp"], "observe": [{ "field": "price", "as": "sum" }] },
      { "on": "impression",  "labels": ["experiment", "variant", "dsp"], "observe": [{ "field": "price", "as": "sum" }] } ],
    "variants": [
      { "name": "control",   "weight": 50, "config": { "userDedup": { "ttlMs": 60000 } } },
      { "name": "treatment", "weight": 50, "config": { "userDedup": { "ttlMs": 10000 } } } ] } ] }
```

- **Config** (`abTesting`): a list of experiments. Each variant has a `weight` and an optional `config` patch keyed by namespace. Optional per experiment: `salt` (re-randomisation seed; defaults to `id`), `target` (`matchesTarget` shape to scope eligibility), `bucketBy` (what to bucket on; default `meta.requestId` = per-request).

  `bucketBy` takes either one dot-path into ctx or a list of them:

  ```json
  "bucketBy": "device.ifa"                    // sticky per device
  "bucketBy": ["device.ifa", "device.ua"]     // sticky per that combination
  ```

  A list is resolved in order and joined with a separator that cannot occur in the values, so `("ab", "c")` and `("a", "bc")` can never share a bucket.

  A part that does not resolve contributes an empty string, so the remaining parts still decide: with `["device.ifa", "device.ua"]` a request carrying no `ifa` stays sticky per `ua`. The case to watch is a request where *no* part resolves — all of those share one seed and therefore land in a single variant. Pick paths so at least one is near-universal for the traffic in question.

  A zero-filled `ifa` from an opted-out device is a real value here, not a missing one, so every such device buckets together on that part; in a composite the other parts still separate them.
- **Selector** (`features/ab-testing/`, a `prebid-ssp` hook that runs first): for each eligible experiment it deterministically buckets `hash(bucketBy value + salt)` by weight, writes `ctx.experiment[expId] = variant`, and merges `variant.config` into `ctx.configOverrides` by namespace.
- **Applying a variant**: a feature reads its effective config through `resolveConfig(ctx, cfg, namespace)` (`core/config.js`) instead of its static `_cfg` — it overlays `ctx.configOverrides[namespace]`. So a variant changes any migrated feature's config without touching its logic. `user-dedup` is the first migrated feature.
- **Attribution**: the tracking token carries a snapshot of the context via `ctx.serialize(res, fields)` (a method on core `BidContext`). The wire fields are chosen in config (`impFeedback.contextFields`) from the `CONTEXT_FIELDS` schema — a single, stable, documented map of wire key → value from ctx, decoupled from ctx's internals. Include `experiment` (variant assignments) and `pipeline` (executed hook trace) to split outcomes by variant; a tracking consumer or event sink then slices by any field it carries (dsp, ssp, country, …) with no code change. A feature can also label its own in-auction metrics per group with `variantFor(ctx, namespace)` — e.g. `user-dedup` adds a `variant` label, giving block-rate per group.
- **Result metrics (config-driven, per experiment)**: each experiment declares a `metrics` list; each entry picks a **measurement point** via `on` — a pipeline stage (`prebid-ssp`/`prebid-dsp`/`postbid-dsp`/`postbid-ssp`) or the detached `impression` event. A pipeline-stage entry makes the feature register a hook at that stage that records one point **per bid** (`ctx.responses`), serialized through `ctx.serialize`; an `impression` entry attaches a tracking consumer that records **per rendered impression** (the decoded token). So bid volume/price is measured at `postbid-dsp`, impression volume/price at `impression`, from one config shape. Each entry has `labels` (breakdown axes, e.g. `["experiment","variant","dsp"]`) and `observe` — a list of `{ field, as: "sum" | "histogram", buckets? }` with the aggregation type declared explicitly (never inferred). Metrics are named by stage: `smash_ab_<stage>_total` (count), `smash_ab_<stage>_<field>_total` (sum), `smash_ab_<stage>_<field>` (histogram) — e.g. `smash_ab_postbid_dsp_total`, `smash_ab_postbid_dsp_price_total`, `smash_ab_impression_price_total`. Names are shared across experiments (labelNames are the union; each experiment fills only its own labels, `none` otherwise), so adding a `dsp` breakdown or a `price` sum is a per-experiment config edit, not code. `impression` label/observe fields must also be in `impFeedback.contextFields` (they ride the token); pipeline-stage fields are serialized on demand and have no such constraint. Keep labels to bounded axes; high-cardinality slicing belongs in an event sink.

---

## Examples

### Minimal DSP adapter

```js
// features/injector/dsp/appnexus/prebid-dsp.js
export default function(ctx) {
  const placementId = ctx.dsp.params.placementId ?? null;
  if (!placementId) return null;

  ctx.set('imp.ext.bidder', { placementId });
  ctx.set('imp.secure', 1);
  ctx.header('Accept', 'application/json');
  return ctx;
}
```

### Seat filter (any DSP)

```js
// features/injector/dsp/_/seat-123.prebid-dsp.js
export default function(ctx) {
  if (!ctx.impression.api?.includes(7)) return null;
  return ctx;
}
```

### SSP endpoint filter

```js
// features/injector/ssp/_/ep-2788.postbid-ssp.js
const BLOCKED_CRIDS = new Set(['democrid1234qwerty:16']);

export default function(ctx) {
  ctx.responses = ctx.responses.filter(r => !BLOCKED_CRIDS.has(r.crid));
  return ctx;
}
```

---

## Glossary

**Bid.** A response from a DSP that includes a price and a creative. The DSP sends a bid when it wants to buy an impression. No response or an empty response is a no-bid.

**SSP (Supply-Side Platform).** The ad exchange or publisher platform that sends bid requests. In xdd-smash, SSP refers to the source of traffic coming through Xeworks.

**DSP (Demand-Side Platform).** The buyer. An external ad platform that responds to bid requests with a price and a creative. xdd-smash calls the DSP over HTTP on every request.

**Pre-bid stage.** Everything that happens before the DSP responds. Includes `prebid-ssp` (processing the incoming Xeworks request) and `prebid-dsp` (shaping it for the DSP).

**Postbid.** Everything that happens after the DSP responds. Includes `postbid-dsp` (processing the DSP response) and `postbid-ssp` (finalizing before returning to Xeworks).

**Seat.** A buyer account identifier used by DSPs. `ctx.dsp.id` is the seat id. Used in injector file naming as `seat-N`.

**Endpoint.** An integration point identified by the Xeworks platform. `ctx.dsp.endpointId` is the ID of the DSP endpoint configured in Xeworks. `ctx.ssp.endpointId` is the ID of the SSP endpoint in Xeworks. Used in injector file naming as `ep-N`.

**knownBidder.** The name of a recognized DSP or SSP. Maps to a directory under `features/injector/dsp/` or `features/injector/ssp/`. If Xeworks does not pass a recognized name, it is `null` and only `_/` hooks run.

**IFA (Identifier for Advertising).** A device-level identifier used for targeting and frequency capping. Available as `ctx.device.ifa`.

**tmax.** Maximum time in milliseconds allowed for the full round-trip. Comes from the original bid request. xdd-smash uses it to set the DSP HTTP timeout.

**No-bid.** A response with no bids. Always a 200 with an empty `seatbid` array. Returning `null` from a hook produces a no-bid.

**Hook.** A JS file that exports a default function `(ctx) => ctx | null`. The core building block of everything in xdd-smash.

**Feature.** A directory in `features/` with one or more hooks and a `register(registry)` function. The unit of functionality in xdd-smash.

**Injector.** A built-in feature that loads hooks from the filesystem by convention. The primary tool for writing DSP and SSP adapters when working with Xeworks.

**ctx (BidContext).** The internal request model passed through the entire pipeline. Hooks never work with raw OpenRTB — only with `ctx`.

**Signals.** A plain object on `ctx.signals` for passing state between pipeline stages within a single request. Set by one hook, read by another downstream.

**Service.** A directory in `services/` that registers a long-lived instance by name and exposes methods. For work that is not a per-request hook: HTTP endpoints, callbacks, shared clients. Auto-loaded before features.

**Router.** The HTTP route table `core/server.js` dispatches on. Matches an exact path, with `*` as a per-method catch-all. Core endpoints (bid `POST *`, `GET /metrics`) and service routes are all entries in it.

**Consumer.** A callback registered on a service that receives decoded events — the seam where collection is plugged in. The tracking service has none by default.

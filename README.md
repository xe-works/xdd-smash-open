# xdd-smash

Own your RTB stack.

White-label vendors put your logo on their black box. You do not have access to the code, 
so you cannot verify what happens to your requests, and when something goes wrong, 
it goes wrong under your name, with your partners. Anything you need changed goes 
into someone else's roadmap, behind someone else's customers.

xdd-smash is another way: an open framework you run yourself.

RTB has parts that are genuinely hard, and the framework absorbs them, so 
that building on it stays cheap: a feature is a function that takes a bid request 
and returns it. Two runtime dependencies, no build step, plain ES modules on Node 22. 
Small enough for one developer to own. 

---

## What it is

A proxy RTB bidder. It sits between your ad management platform and your demand, runs a
pipeline on every bid request, and returns the result.

```
SSP / SDK / etc -> ad management platform (e.g. Xeworks) -> xdd-smash -> DSP / demand
```

It comes integrated with [Xeworks](https://xe.works), an ad management platform.
Nothing in `core/` is tied to Xeworks, so it can sit behind something else, but
the general guide for doing that is not written yet:
[#25](https://github.com/xe-works/xdd-smash-open/issues/25).

`core/` is the framework and stays deliberately small. The features here are the
ones a working bidder needs, plus reference implementations to copy from when
writing your own, and we keep adding to that free set.

### Audiences

The xdd-smash framework is the same wherever it sits in a request. What changes 
is what you would use it for. 

* [Ad Network](docs/audiences/ad-network.md) 
* [Curator](docs/audiences/curator.md) 
* [Performance Network](docs/audiences/performance-network.md) 
* [Publisher](docs/audiences/publisher.md) 
* [SSP](docs/audiences/ssp.md) 

### Latency

Pipeline overhead depends on the deployment. On the deployments we run it is
about 0.5 ms, measured from Xeworks. For an independent deployment it depends on
your topology and where the boxes sit, so ask us and we will work it out with you.

---

## Getting started

Not written yet. Getting from a clone to a bid response should take minutes, and
today it does not, see [#6](https://github.com/xe-works/xdd-smash-open/issues/6).
Help is welcome there; it is the first thing anyone tries.

Node 22 or newer, and the reference for the request shape is
[docs/framework.md](docs/framework.md).

Setup touches your supply, your demand and your infrastructure. 
If something does not line up, open an issue for your case.

---

## For developers

Every bid request runs through four stages. A hook is a function bound to one of
them: it receives the request context, changes it, and returns it.

```
supply source  -->  prebid-ssp  -->  prebid-dsp  -->  DSP
                                                       |
supply source  <--  postbid-ssp <--  postbid-dsp  <----+
```

| Stage | When it runs | Typical use |
|---|---|---|
| `prebid-ssp` | request arrived, before the DSP request is built | validate supply, block bad traffic |
| `prebid-dsp` | before the DSP request goes out | enrich, add DSP fields and auth |
| `postbid-dsp` | the DSP responded | validate and filter bids |
| `postbid-ssp` | before the response goes back | final filtering, creative wrapping |

The context is the bid request already normalised into one shape, whatever the
caller sent:

```js
// features/my-feature/prebid-dsp.js
export default function(ctx) {
  if (ctx.impression.isVideo && ctx.privacy.gdpr === 1 && !ctx.privacy.consent) {
    return null;                              // no-bid, the request stops here
  }

  ctx.set('imp.ext.bidder', { placement: ctx.dsp.params.placementId });
  ctx.header('Authorization', `Bearer ${token}`);

  return ctx;                                 // continue to the DSP
}
```

`ctx.set()` queues a patch on the outbound body rather than mutating the request
you were handed, and `imp.*` paths broadcast to every impression. A no-bid is a
real response body with an empty `seatbid`, never a null body and never a 204.

A **feature** is a directory under `features/`. Its `index.js` declares the
stages it binds to, and every such directory is loaded at startup, so adding a
feature is adding a directory with no wiring anywhere else:

```js
// features/my-feature/index.js
import hook from './prebid-dsp.js';

export function register(registry) {
  registry.register('prebid-dsp', null, hook, 'my-feature/prebid-dsp');
  return { side: 'feature', bidder: 'my-feature', stage: 'prebid-dsp' };
}
```

The `null` is the target: pass one to scope the hook to a bidder or a seat, and
targets order execution from least to most specific. The returned descriptor is
what the startup banner prints. DSP and SSP adapters usually skip all of this:
drop `dsp/<bidder>/prebid-dsp.js` into `features/injector/` and the filename is
the registration.

Features come in two kinds, and the difference is what can fail:

- **Stateless** — no external dependencies, so anything that throws
  is a bug in your own code.
- **Stateful** — depends on Redis, a database, something over the network.
  Must be fail-open: if the dependency is unreachable, return `ctx`.
  Done right, no bid is ever lost to infrastructure.

Failing open is on you, not on the framework — nothing is caught silently 
on your behalf. If a hook throws, the error is recorded in `ctx.meta.errors` 
and the request ends as a no-bid. So catch what you expect to fail, 
leave a note in `ctx.meta.warnings` and return `ctx`. 

---

## Your features stay yours

Apache 2.0 does not require you to publish anything you build on it. 
You work in a private fork of this repository: the features that are your 
competitive edge live there, closed and owned by you, and they come back 
here only if you decide to contribute them.

The framework runs without us. You can bring us into that fork under contract 
for code review, custom feature development, deployment, hosting, 
or a second opinion on an integration. Write to dima@xe.works.

### Docs

- [docs/framework.md](docs/framework.md) — hooks, the injector, building features
- [docs/metrics.md](docs/metrics.md) — Prometheus, Grafana
- [docs/deployment.md](docs/deployment.md) — deploying to production
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to contribute, and how review works

Questions and bug reports: [open an issue](https://github.com/xe-works/xdd-smash-open/issues).

## License

Copyright 2026 xDD Group, UAB.

This project is licensed under the [Apache License, Version 2.0](LICENSE).

Unless otherwise explicitly stated, the license applies to all source code,
feature modules, services, tests, documentation, and other material contained
in this repository.

Additional modules, integrations, managed hosting, implementation services,
code review, and support not contained in this repository may be offered
separately under commercial terms.

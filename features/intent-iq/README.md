# intent-iq

IntentIQ S2S Bid Enhancement: resolves external ids for the user, merges them
into `user.ext.eids` before the DSP call, and reports the rendered impression
back so IntentIQ can measure lift.

- Stage: `prebid-dsp`, plus a tracking consumer for the impression report
- Namespace: `intentIq`
- Ships `enabled: false`

A region is a `(host, dpi)` pair, not just a host: the GDPR endpoint is a
separate IntentIQ account. Only the countries IntentIQ documents are served.

The cache key carries no `dpi` on purpose, so a deployment without an account
still reads the cache that deployments with one populate. Without a `dpi` we
never call out and never report impressions.

Rate is discovered rather than configured: a local bucket admits requests, and
workers agree on a fleet-wide limit per `dpi` through Redis at most once a
second, sharing it in proportion to demand.

Fail-open on every branch — no eids simply means the request passes through.

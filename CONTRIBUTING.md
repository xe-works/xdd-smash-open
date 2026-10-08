# Contributing

Everything goes through a pull request, and every pull request needs at least
one review before it merges. That applies to us as much as to you.

## Getting set up

Not written yet — see [#6](https://github.com/xe-works/xdd-smash-open/issues/6).
Getting from a clone to a running bidder should take minutes, and setting that
out properly is its own piece of work. Help is welcome there.

## Where code goes

| | |
|--|--|
| `features/` | per-request hooks — the pipeline |
| `services/` | HTTP endpoints, callbacks, long-lived clients |
| `core/` | maintained by xdd, see below |

Read [docs/framework.md](docs/framework.md) first. It explains hooks, the
injector and how a feature registers itself. Adding a feature is dropping a
directory with an `index.js` that exports `register`; nothing central needs
editing, which is the point.

`core/` is maintained by xdd and pull requests from forks that touch it are
rejected automatically. If you need something from core, open an issue
describing the use case and we will either integrate it or point you at the
seam that already does the job. This is not gatekeeping for its own sake: every
client fork inherits core, so a change there lands on all of them.

## Pull requests

- One branch per change, never push to `main` directly.
- Tests and lint run on every PR and must pass.
- Cover behaviour you add, and behaviour you fix. If a bug reached `main` once,
  a test is the only thing stopping it reaching `main` twice. Coverage has a
  floor and CI enforces it; the floor exists to stop erosion, not as a target.
- Say what changed and why in the description. The diff shows what; only you
  know why.
- At least one review before merge.

## Licensing of contributions

The project is licensed under the [Apache License, Version 2.0](LICENSE).

Unless explicitly stated otherwise, any contribution intentionally submitted
for inclusion in this project is provided to xDD Group, UAB under the Apache
License, Version 2.0, without additional terms or conditions, as described in
Section 5 of the license.

By submitting a contribution, you represent that you have the right to submit
it under those terms. Do not submit material owned by an employer, client, or
other third party unless you have the necessary permission.

---

## For clients running xdd-smash

The sections above apply to you too. What follows is specific to a contract
with xdd.

Core updates reach your fork through upstream sync, so your `main` stays
current without touching your feature work.

There are two hosting arrangements. If **xdd hosts**, we manage the
infrastructure and own uptime; deployment follows review, and a PR is not
deployed until it is approved. If **you host**, infrastructure and deployments
are yours. Which one applies is agreed at contract time.

| | |
|--|--|
| [docs/framework.md](docs/framework.md) | Hooks, injector, features |
| [docs/metrics.md](docs/metrics.md) | Prometheus, Grafana |
| [docs/deployment.md](docs/deployment.md) | Deploy to production |

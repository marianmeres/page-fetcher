<!--
GENERATED ANALYSIS — @marianmeres/page-fetcher implementation plan
Produced 2026-08-23 by multi-agent research -> adversarial verify -> synthesize.
Claims verified against the design doc (tmp/page-fetcher-DESIGN.md), local ecosystem
sources, and platform checks. Repo is a pre-first-commit scaffold; no code was changed.
-->

# Implementation Plan — `@marianmeres/page-fetcher`

This directory holds the **verified implementation plan** for building
`@marianmeres/page-fetcher` v1 from its design sketch (`tmp/page-fetcher-DESIGN.md`),
produced on **2026-08-23** against the pre-first-commit scaffold. It is a **planning
artifact** — no source code was changed. Every platform-behavior claim was verified by
live, network-free checks (Deno 2.9.5, Node v26.7.0) and every ecosystem citation was
opened at file:line; recommendations that duplicated existing functionality or fell
below the value bar were deliberately cut (marked "Cut from the draft" in place).

**Start here:** [`00-overview-and-roadmap.md`](./00-overview-and-roadmap.md) — the
ranked master table, the recommended first sprint, cross-cutting themes, a sequencing
graph, and the cross-doc contradiction resolutions. Execution status lives in
[`PROGRESS.md`](./PROGRESS.md).

## Documents

| #  | Doc                                                              | Scope                                            | Headline finding                                                                                                                                                                                                                     |
| -- | ---------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 00 | [overview-and-roadmap](./00-overview-and-roadmap.md)             | Synthesis + ranked roadmap                       | Strong design skeleton, five precision gaps; three structural decisions to make before any code                                                                                                                                      |
| 01 | [public-contracts](./01-public-contracts.md)                     | Types, options, errors, events, Logger           | §9's observability contract is unimplementable as written — `requestId` becomes a first-class field, granularity is defined per event; §11.1 resolved as eager bytes + lazy decode everywhere                                        |
| 02 | [http-adapter-and-guards](./02-http-adapter-and-guards.md)       | `createHttpAdapter`, §7 correctness guards       | Stream guards cannot be `(next) => FetchFn` wrappers — they move inside the adapter as helper modules; `redirect: "manual"` verified viable on both runtimes; `maxBytes` counts decoded bytes                                        |
| 03 | [resilience-and-composition](./03-resilience-and-composition.md) | Retry, circuit breaker, `createFetcher`          | The §3 stack read as composition order is wrong for the cache — wired order must be cache → breaker → retry → guards → routing; retry needs `error`/`result` either/or signatures; breaker gets its own `circuit-open` kind          |
| 04 | [browser-adapter](./04-browser-adapter.md)                       | Driver interface, pool, lifecycle                | Lazy driver import has no working spelling under JSR+npm dual publish — v1 is injection-required behind a ~10-method structural interface, making the pool fully testable with a fake driver and zero browsers                       |
| 05 | [cache-layer](./05-cache-layer.md)                               | `CacheStore`, memory cache, conditional requests | `CachedEntry` is named but never defined, and the naive shape is broken twice (`Headers` → `{}`, `Uint8Array` → junk under JSON) — specced serialization-first, with all policy in a `createCacheLayer` wrapper over a dumb KV store |
| 06 | [testing-docs-tooling](./06-testing-docs-tooling.md)             | Tests, packaging, docs plan                      | The layering makes retry/breaker/guards/pool unit-testable with zero sockets, browsers, or sleeps (FakeTime verifiably drives `setTimeout` AND `AbortSignal.timeout`); the fixture server's gzip route must be hand-encoded          |

## How it was produced

A multi-agent workflow: one deep-research agent per dimension → an adversarial verifier
per dimension that re-ran every platform check and re-opened every file:line citation
(deleting or correcting what did not survive) → a synthesis agent for this overview,
README, and PROGRESS. Editorial traces such as "_Cut from the draft:_" inside the docs
record what verification removed and why.

> Nothing here is decided. Each doc ends with an **"Open questions / decisions
> needed"** section — those are the points that need the owner's call before any
> implementation begins; they are deduplicated in the overview and gate the tasks in
> [`PROGRESS.md`](./PROGRESS.md).

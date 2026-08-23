# Architecture

## Overview

One composable primitive: `FetchFn = (req: FetchRequest) => Promise<FetchResult>`.
A layer is `FetchLayer = (next: FetchFn) => FetchFn`. An adapter is the `FetchFn` at the
bottom that performs actual I/O. `compose(layers, terminal)` folds them; `createFetcher`
is nothing but that call plus option plumbing — hand-roll the stack whenever the defaults
do not suit.

## The default stack

Outermost first, as wired by `createFetcher`:

```
┌──────────────────────────────────────────────────────────────────┐
│ cache            optional. A hit must cost nothing and depend on │
│                  nothing — not an open circuit, not the deadline │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ circuit breaker  optional. Refuses before any I/O. Above     │ │
│ │                  retry, so one logical request counts once   │ │
│ │ ┌──────────────────────────────────────────────────────────┐ │ │
│ │ │ events           the terminal onResponse/onError pair,   │ │ │
│ │ │                  exactly once per logical request        │ │ │
│ │ │ ┌──────────────────────────────────────────────────────┐ │ │ │
│ │ │ │ http error guard  optional (throwOnHttpError). Above │ │ │ │
│ │ │ │                   retry, so retry still sees the raw │ │ │ │
│ │ │ │                   result and its Retry-After header  │ │ │ │
│ │ │ │ ┌──────────────────────────────────────────────────┐ │ │ │ │
│ │ │ │ │ deadline guard   spans every attempt AND every   │ │ │ │ │
│ │ │ │ │                  retry sleep: therefore above    │ │ │ │ │
│ │ │ │ │ ┌──────────────────────────────────────────────┐ │ │ │ │ │
│ │ │ │ │ │ retry   owns the attempt loop, the sleeps,   │ │ │ │ │ │
│ │ │ │ │ │         `attempts`, and the per-attempt      │ │ │ │ │ │
│ │ │ │ │ │         onRequest / onRetry events           │ │ │ │ │ │
│ │ │ │ │ │ ┌──────────────────────────────────────────┐ │ │ │ │ │ │
│ │ │ │ │ │ │ timeout guard  below retry, so the       │ │ │ │ │ │ │
│ │ │ │ │ │ │                per-attempt budget re-arms│ │ │ │ │ │ │
│ │ │ │ │ │ │ ┌──────────────────────────────────────┐ │ │ │ │ │ │ │
│ │ │ │ │ │ │ │ routing → adapter.fetch (the I/O)   │ │ │ │ │ │ │ │
│ │ │ │ │ │ │ └──────────────────────────────────────┘ │ │ │ │ │ │ │
│ │ │ │ │ │ └──────────────────────────────────────────┘ │ │ │ │ │ │
│ │ │ │ │ └──────────────────────────────────────────────┘ │ │ │ │ │
│ │ │ │ └──────────────────────────────────────────────────┘ │ │ │ │
│ │ │ └──────────────────────────────────────────────────────┘ │ │ │
│ │ └──────────────────────────────────────────────────────────┘ │ │
│ └──────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

Placement is a contract, not a preference. Each layer's module JSDoc states why it sits
where it does; `docs/plan/PROGRESS.md` decision 24 records the ordering call in full.

## Component map

| Component       | File                                | Owns                                                     |
| --------------- | ----------------------------------- | -------------------------------------------------------- |
| Types           | `src/types.ts`                      | The whole shared type surface. Runtime-free.             |
| Errors          | `src/errors.ts`                     | `PageFetchError` + the `kind` → retryable table.         |
| Internals       | `src/internal.ts`                   | `ensureRequestId`, `createBodyResult`, abort mapping.    |
| Compose         | `src/compose.ts`                    | Folding layers over a terminal `FetchFn`.                |
| Guards          | `src/guards.ts`                     | Timeout, deadline, `composeSignal`, HTTP-error throw.    |
| Retry           | `src/retry.ts`                      | Attempt loop, backoff, `Retry-After`, classification.    |
| Circuit breaker | `src/circuit-breaker.ts`            | Per-host state, half-open probe, local refusal.          |
| Events          | `src/events.ts`                     | `safeEmit` + the terminal event pair.                    |
| Fetcher         | `src/fetcher.ts`                    | Wiring, adapter routing, disposal, header merging.       |
| HTTP adapter    | `src/adapters/http.ts`              | `fetch`, redirects, byte cap, content-type policy.       |
| Charset / mime  | `src/charset.ts`, `content-type.ts` | BOM → header → `<meta>` precedence; allow-lists.         |
| Browser adapter | `src/adapters/browser/`             | Navigation, waits, resource blocking, DOM serialization. |
| Context pool    | `src/adapters/browser/pool.ts`      | Contexts, epochs, recycling, the "never wedge" rule.     |
| Cache           | `src/cache/`                        | Keys, the dev/conditional state machine, the store.      |

## Data flow of one request

```
fetcher.fetch(url)
  → merge headers (fetcher defaults under per-request), anchor the deadline ONCE,
    ensureRequestId
  → cache: key? bypass or lookup → pure hit returns here (attempts: 0, fromCache)
  → breaker: host open? refuse locally (kind "circuit-open", attempts: 0)
  → events: try { ... } → exactly one onResponse or onError
  → retry: for each attempt → emit onRequest → timeout guard arms
      min(timeout, deadline remaining) → routing picks the adapter → I/O
      → classify the outcome → sleep + onRetry, or return/throw
  → adapter builds the FetchResult: bytes read eagerly and bounded, decode lazy and
    memoized, requestId stamped, attempts: 1
  → cache stores it if cacheable and it has a body
```

**Event granularity** (a contract, see `src/events.ts`): for N attempts the caller sees
N × `onRequest`, (N−1) × `onRetry`, and exactly one of `onResponse` / `onError`.
`onCircuitOpen` fires on breaker transitions only, never per refusal.

## External dependencies

**Zero runtime dependencies.** The only import outside the package is
`import type { Logger } from "@marianmeres/clog"` — type-only, erased at compile time.
It is nonetheless a regular `dependencies` entry in the npm artifact, because the emitted
`.d.ts` references `Logger` and a consumer's `tsc` must resolve it (an accepted deviation,
recorded in [design.md](./design.md)).

Playwright and Puppeteer are **never** imported, statically or dynamically. The caller
injects a driver built by `playwrightDriver(playwright)` / `puppeteerDriver(puppeteer)`;
`BrowserDriver` is a structural interface and the bridges type their argument as `unknown`
members, validating the shape at call time.

## Testability properties worth preserving

- **Unit suites never open a socket.** `retry`, `guards`, `errors`, `internal`, `mod`,
  `circuit-breaker` and the cache unit sections run against stub `FetchFn`s.
- **The browser subsystem is fully testable without a browser** via
  `tests/fixtures/fake-driver.ts` — a scriptable in-memory driver whose every delay is a
  `setTimeout`, so the pool and adapter suites run under `FakeTime`.
- **Real browsers are behind a double gate**: `tests/browser/` is `--ignore`d by
  `deno task test` and each case also checks the `BROWSER_TESTS` permission before
  reading it, so a permissionless run degrades to "skipped".

## Key files

| Question                        | File                                      |
| ------------------------------- | ----------------------------------------- |
| What does a result look like?   | `src/types.ts` (`FetchResult`)            |
| What can go wrong?              | `src/errors.ts` (`PageFetchErrorKind`)    |
| How is the default stack wired? | `src/fetcher.ts`                          |
| What is the driver contract?    | `src/adapters/browser/driver.ts`          |
| What is stored in the cache?    | `src/cache/types.ts` (`CachedEntry`)      |
| Why is it like this?            | `docs/design.md`, `docs/plan/PROGRESS.md` |
| What does it look like in use?  | `example/` (`deno task example`)          |

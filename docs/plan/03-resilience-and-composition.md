<!--
GENERATED ANALYSIS — @marianmeres/page-fetcher implementation plan
Produced 2026-08-23 by multi-agent research -> adversarial verify -> synthesize.
Claims verified against the design doc (tmp/page-fetcher-DESIGN.md), local ecosystem
sources, and platform checks. Repo is a pre-first-commit scaffold; no code was changed.
-->

# Retry, circuit breaker, layer composition & createFetcher

> This doc pins down the resilience half of the pipeline: the retry layer (DESIGN §6),
> the per-host circuit breaker, the `(next: FetchFn) => FetchFn` composition rule
> (DESIGN §3), and `createFetcher` itself — adapter routing, event emission (DESIGN §9),
> disposal, and how the `@marianmeres/clog` `Logger` threads through every layer.

> The single most important finding: **the DESIGN §3 stack diagram, read top-down as
> composition order, is wrong for the cache.** It draws retry/breaker outermost with
> cache below, which means a cache _hit_ would still consult the circuit breaker — an
> open circuit would refuse to serve content we already have on disk/memory. The correct
> order is `cache → circuit-breaker → retry → events → guards → adapter-routing`: a
> cache hit must short-circuit everything (no breaker consult, `attempts: 0`), the
> breaker must count _logical_ outcomes (not inflate its failure count 3× because one
> request retried 3 times), and deadline state must anchor _above_ retry because it
> spans attempts while per-attempt timeout lives below it.

> Second headline: the DESIGN's own signatures cannot express its own semantics. Non-2xx
> resolves as `ok: false` data (DESIGN §4), yet the §6 table says 429/5xx are retryable —
> so the retry layer must retry on _results_, not only thrown errors. But
> `isRetryable?(err: PageFetchError, res?)` (§6) and `onRetry({ ..., err })` (§6, §9)
> make the error mandatory. Both signatures need `error`/`result` as an either/or pair
> (**Design deviation**, detailed below). Likewise the breaker's "reject with
> `kind: "network"`" (§6) should be a dedicated `"circuit-open"` kind so the crawler can
> distinguish "host unreachable" from "we refused locally" (type itself owned by doc 01).

## Summary of recommendations

| #  | Recommendation                                                                                                                   | Value | Effort | Risk |
| -- | -------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | ---- |
| 1  | Fix composition order: `cache → breaker → retry → events → guards → routing`; export `compose()`                                 | high  | S      | low  |
| 2  | **Design deviation:** breaker rejects with dedicated `kind: "circuit-open"`, not `"network"`                                     | high  | S      | low  |
| 3  | **Design deviation:** `isRetryable`/`onRetry`/`FetcherEvents.onRetry` take `{error?, result?}` (either/or)                       | high  | S      | low  |
| 4  | Retry layer spec: full jitter, `Retry-After` (secs + HTTP-date), result-based retry, deadline-aware fail-fast, abort-aware sleep | high  | M      | med  |
| 5  | Circuit breaker spec: per-instance `Map`, consecutive-failure trip, half-open single probe, map hygiene                          | high  | M      | low  |
| 6  | `createFetcher` options + `Fetcher` interface + idempotent `dispose()` + `Symbol.asyncDispose`                                   | high  | M      | low  |
| 7  | Events: attempt-level events layer, `safeEmit` (handlers never throw into pipeline), `requestId` threading                       | high  | M      | low  |
| 8  | Logger threading: `logger?: Logger` on every factory, silent default, level conventions per layer                                | med   | S      | low  |
| 9  | Deadline anchoring convention: `resolveDeadline()` util, "first touch converts relative→absolute" rule                           | med   | S      | low  |
| 10 | Adapter routing rules: first-is-default, `req.adapter` > `selectAdapter(req)`, loud error on unknown name                        | med   | S      | low  |

## Findings & recommendations (detailed)

### 1. Composition order — cache outermost; export a tiny `compose()`

- **Problem / observation.** DESIGN §3 lists, top-down: retry/backoff/circuit-breaker →
  cache → guards → Adapter. If that is composition order (outermost first), then a cache
  hit still flows through retry and the breaker. Concretely: host `example.com` had 5
  network failures, circuit opens, and now `fetcher.fetch(url)` for a URL sitting warm
  in the dev cache gets rejected with a circuit-open error. Also, if breaker sits at/
  below retry granularity, one flaky logical request with 3 attempts pumps the
  consecutive-failure counter 3×. The diagram is a sketch ("not an implementation plan
  for internals", DESIGN header), but the order is a contract-level decision because
  every layer is also public standalone — so pin it.

- **Evidence** — DESIGN §3 (diagram + "Composition is a plain `reduce`"; "Every layer
  must also be usable standalone"); DESIGN §8 (dev cache purpose: "avoid re-hitting the
  network" — which must include not consulting network-health state); DESIGN §6
  ("Retries must respect the total deadline").

- **Proposed change.** **Design deviation** (from the literal diagram): fix the wired
  order in `createFetcher` as, outermost → innermost:

  ```
  cache            (optional; hit ⇒ short-circuit, fromCache: true, attempts: 0)
  circuit-breaker  (optional; counts logical outcomes; rejects before any I/O)
  retry            (loops the layers below it; owns sleeps + attempts counter)
  events           (attempt-level onRequest/onResponse/onError — DESIGN §9 "per attempt")
  guards           (per-attempt timeout = min(timeout, deadline remaining); doc 02)
  adapter routing  (terminal FetchFn; picks adapter, calls adapter.fetch)
  ```

  Rationale, layer by layer: cache hits must cost nothing and depend on nothing
  (outermost). Breaker above retry so (a) one logical request = at most one failure
  count, (b) a breaker rejection is never slept on or retried, (c) a request that
  succeeds on attempt 3 counts as success (host is flaky-but-up). Retry above events so
  events fire per attempt (§9 granularity rule). Guards below retry so each attempt gets
  a fresh per-attempt timeout, recomputed against the shrinking deadline. Routing is the
  terminal function, not a layer.

  Export the composition primitive (new file `src/compose.ts`):

  ```ts
  export type FetchLayer = (next: FetchFn) => FetchFn;

  /** Layers listed OUTERMOST-FIRST. `compose([a, b], t)` returns a(b(t)). */
  export function compose(layers: FetchLayer[], terminal: FetchFn): FetchFn {
  	return layers.reduceRight((next, layer) => layer(next), terminal);
  }
  ```

  This is DESIGN §3's "plain `reduce`" made concrete; exporting it stops the crawler
  (and users) from getting the reduce direction backwards when building custom stacks.

- **Affected files.** `src/compose.ts` (new), `src/fetcher.ts` (uses it), `src/mod.ts`
  (re-export `FetchLayer`, `compose`).

- **Effort / Value / Risk.** S / high / low.

- **Implementation notes.** `createFetcher` builds the array by conditionally pushing
  optional layers (cache when configured, breaker when configured, retry unless
  `retry: false`), always pushing events (cheap no-op when `events` empty) and guards,
  then `compose(layers, routeFetch)`. Document in `compose()`'s JSDoc that the first
  array element is outermost. README recipe: hand-rolled stack for the crawler
  (`compose([createRetry(...), createGuards(...)], adapter.fetch)`).

### 2. Circuit breaker must reject with a dedicated `kind: "circuit-open"` — not `"network"`

- **Problem / observation.** DESIGN §6 says the open breaker fails requests "immediately
  with `kind: "network", retryable: false`". That overloads one discriminant with two
  opposite meanings: "the host actually failed at the network level" vs "we refused
  locally without touching the network". The crawler (the package's primary consumer)
  needs the distinction: circuit-open URLs should be _rescheduled_ after cooldown; real
  network failures feed error budgets and may mark URLs dead. With `"network"` reused,
  callers are forced back to message string matching — exactly what the `kind`
  discriminant exists to prevent (DESIGN §4 Errors: "so callers ... can branch without
  string matching").

- **Evidence** — DESIGN §6 (Circuit breaker paragraph), DESIGN §4 (`PageFetchError.kind`
  union and its rationale).

- **Proposed change.** **Design deviation:** add `"circuit-open"` to the
  `PageFetchError.kind` union (the union itself is owned by doc 01 — coordinate; this
  doc owns the throwing site). Breaker rejects with:
  `new PageFetchError({ kind: "circuit-open", url: req.url, attempts: 0, retryable: false, message: 'circuit open for "<host>" until <iso>' })`.
  `retryable: false` is kept as designed (retrying a local refusal is pointless — the
  retry layer sits _below_ the breaker anyway, so this matters only for standalone
  stacks that put retry above it). The `until` epoch is exposed structurally via
  `events.onCircuitOpen(host, until)` at trip time, not via new error fields.

- **Affected files.** `src/circuit-breaker.ts`; `src/errors.ts` or wherever doc 01
  places `PageFetchError` (one-line union addition — pointer to doc 01).

- **Effort / Value / Risk.** S / high / low (greenfield; no compat concern).

- **Implementation notes.** Default `isRetryable` table (finding 4) lists
  `circuit-open → no`. README: note the deviation from the sketch explicitly.

### 3. Retry/event signatures must express result-based retries (`error`/`result` either/or)

- **Problem / observation.** DESIGN §4 makes non-2xx a _resolution_ (`ok: false`), not a
  throw, by default. DESIGN §6's table makes 408/425/429/5xx retryable. Therefore the
  retry layer's dominant retry trigger is a **result**, not an error — yet
  `isRetryable?(err: PageFetchError, res?: FetchResult)` (§6) requires an error, and
  both `RetryOptions.onRetry` (§6) and `FetcherEvents.onRetry` (§9) carry a mandatory
  `err`. There is no `PageFetchError` in hand when attempt 1 resolved with a 503. A
  fabricated synthetic error just to satisfy the signature would leak into user-facing
  callbacks and confuse "did it throw?" semantics.

- **Evidence** — DESIGN §4 ("a non-2xx response is **not** an error by default"),
  DESIGN §6 (`RetryOptions` sketch + retryable table), DESIGN §9 (`onRetry` signature).

- **Proposed change.** **Design deviation** — make the outcome an either/or pair in all
  three places (exactly one of `error`/`result` is set):

  ```ts
  // src/retry.ts
  export interface RetryOutcome {
  	error?: PageFetchError;
  	result?: FetchResult; // ok: false result that classified as retryable
  }
  export interface RetryOptions {
  	attempts?: number; // total attempts incl. the first, default 3
  	backoff?: "exponential" | "linear" | "fixed" | ((attempt: number) => number);
  	baseDelay?: number; // default 500
  	maxDelay?: number; // default 30_000
  	jitter?: boolean; // default true — full jitter (ignored for fn backoff)
  	respectRetryAfter?: boolean; // default true, capped by maxDelay
  	isRetryable?(outcome: RetryOutcome, attempt: number, req: FetchRequest): boolean;
  	onRetry?(info: { attempt: number; delay: number; url: string } & RetryOutcome): void;
  	logger?: Logger;
  }

  // src/events.ts — FetcherEvents.onRetry aligned the same way:
  onRetry?(info: {
  	requestId: string; url: string; attempt: number; delay: number;
  } & RetryOutcome): void;
  ```

- **Affected files.** `src/retry.ts`, `src/events.ts`; README (§6/§9 sketches shown
  corrected).

- **Effort / Value / Risk.** S / high / low.

- **Implementation notes.** `attempt` in both callbacks = the 1-based attempt that just
  failed; `delay` = the sleep before the next one. Custom `isRetryable` fully replaces
  the default table (export the default as `defaultIsRetryable` so users can wrap it).
  `RetryOutcome` is also consumed by the breaker's `isFailure` (finding 5) — house it
  in the shared types module (doc 01) so `circuit-breaker.ts` does not have to import
  from `retry.ts`; keep the name.

### 4. Retry layer spec (`src/retry.ts`)

- **Problem / observation.** DESIGN §6 gives options and a classification table but
  leaves the hard edges open: how result-based retry actually works, what happens when a
  sleep would cross the deadline, how `Retry-After` is parsed, how sleeps react to
  abort, and who owns the `attempts` field. These edges are where retry layers rot.

- **Evidence** — DESIGN §6 (options, table, "never sleep past it, fail fast"), DESIGN §7
  (cancellation must propagate "to retry sleeps"), DESIGN §4 (`FetchResult.attempts`,
  `PageFetchError.attempts`). Platform: `AbortSignal`-cancellable `setTimeout` sleep and
  `Date.parse("Wed, 21 Oct 2026 07:28:00 GMT") → 1792567680000` verified on Deno 2.9.5
  (network-free `deno eval`).

- **Proposed change.** `export function createRetry(options?: RetryOptions): FetchLayer`
  with this exact behavior:

  **Loop.** For `attempt = 1 .. attempts` (default 3, total incl. first):
  1. Pre-attempt: if `req.signal?.aborted` → throw `kind: "aborted"`; if deadline
     already expired → throw `kind: "deadline"` (both with `attempts` = completed
     attempts so far).
  2. Call `next(req)`. Catch throws; capture resolutions.
  3. Classify via `isRetryable ?? defaultIsRetryable`. Default table (DESIGN §6,
     confirmed, with two additions marked ✱):

     | Outcome                                                                                             | Retry |
     | --------------------------------------------------------------------------------------------------- | ----- |
     | error kind `network` / `timeout` / `browser`                                                        | yes   |
     | result (or `http` error) status 408, 425, 429, 5xx                                                  | yes   |
     | 3xx — handled by adapter, never reaches retry                                                       | n/a   |
     | other 4xx                                                                                           | no    |
     | `too-large`, `unsupported-type`, `decode`                                                           | no    |
     | `aborted`, `deadline`                                                                               | no    |
     | `too-many-redirects` ✱ (missing from §6 — **Design gap**: deterministic, retrying won't fix a loop) | no    |
     | `circuit-open` ✱ (finding 2)                                                                        | no    |

  4. Non-retryable, out of attempts, or classification says stop → **surface the
     outcome as-is**: rethrow the error (with `err.attempts` overwritten to the total)
     or resolve with the last `ok: false` result (`res.attempts` overwritten). Retry
     never converts a result into a throw or vice versa — preserving DESIGN §4's
     "non-2xx is data" contract end to end.
  5. Retryable and attempts remain → compute `delay`:
     - Backoff: `exponential` (default): `raw = min(maxDelay, baseDelay * 2 ** (attempt - 1))`;
       `linear`: `min(maxDelay, baseDelay * attempt)`; `fixed`: `min(maxDelay, baseDelay)`;
       fn: `min(maxDelay, fn(attempt))`.
     - Jitter (default true): full jitter — `delay = Math.random() * raw` (AWS
       full-jitter; near-0 delays are by design). Skipped when `backoff` is a function
       (custom fn = full control).
     - `respectRetryAfter` (default true): if the retryable outcome is a **result**
       carrying `Retry-After`, use `min(maxDelay, parseRetryAfter(value))` **instead
       of** the computed backoff, no jitter (server-directed). Note: per DESIGN §4,
       `PageFetchError` carries no `headers` field, so when `throwOnHttpError` turned a
       429/503 into an `http` error, plain backoff applies — unless doc 01 adds headers
       (or the result) to the error, in which case honor `Retry-After` there too
       (pointer to doc 01). `parseRetryAfter(value, now?)`: `/^\d+$/` → seconds ×
       1000; else `Date.parse` (HTTP-date) → `max(0, t - now)`; unparseable →
       `undefined` (fall back to backoff).
  6. Deadline check before sleeping: if `now + delay > deadline` → **fail fast**: if the
     outcome in hand is an `ok: false` result, resolve with it (it is real data — see
     nuance below); if it is an error, throw
     `PageFetchError { kind: "deadline", retryable: false, cause: lastError, attempts }`.
  7. Fire `onRetry` (and the fetcher-bridged `events.onRetry` / `logger.warn`) — before
     the sleep, so observers see the scheduled retry in real time and `delay` is
     forward-looking — then `await sleep(delay, req.signal)` and loop. The sleep is
     abort-aware: it registers an abort listener that clears the timer and rejects;
     retry maps that rejection to `kind: "aborted"`.

  **Deadline fail-fast nuance** (**Design deviation**, slight): the sketch says "fail
  fast" without specifying the shape. When the last attempt _completed_ with an
  `ok: false` HTTP result, throwing `"deadline"` would destroy real data (a crawler
  wants that 429/503 recorded); so: result-in-hand → return it, error-in-hand → throw
  `"deadline"` with `cause`. `kind: "deadline"` is otherwise reserved for the deadline
  expiring before/during an attempt (guards layer, doc 02).

  **`attempts` ownership.** The retry layer owns the final `attempts` number on both
  paths (result field and error field). Adapters always report `attempts: 1`; without a
  retry layer that stands. Cache hits report `attempts: 0` (cache layer, doc 05).

  **Discarded results.** When retrying past an `ok: false` result, its body resources
  must be released (the HTTP adapter may hold a lazy stream — DESIGN §11 Q1). This layer
  requires an internal release hook on `FetchResult` (or the guarantee that bodies are
  fully buffered) — constraint owned by doc 01's body/laziness decision, one-line
  pointer only. Same for request bodies: a `ReadableStream` body is one-shot; the retry
  layer must classify any second attempt with a stream body as non-retryable (doc 01
  owns the `body` typing constraint).

- **Affected files.** `src/retry.ts` (new), `src/utils.ts` (`sleep(ms, signal?)`,
  shared), `src/mod.ts` (export `createRetry`, `RetryOptions`, `defaultIsRetryable`,
  `parseRetryAfter`).

- **Effort / Value / Risk.** M / high / med (densest logic in the package; fake-timer
  tests per DESIGN §10 are mandatory).

- **Implementation notes.**
  ```ts
  // src/utils.ts
  export function sleep(ms: number, signal?: AbortSignal): Promise<void>;
  // resolves after ms; rejects with signal.reason immediately on abort;
  // removes its abort listener on normal resolution (no leak).
  ```
  Verified pattern (setTimeout + `abort` listener + `clearTimeout`, rejecting with
  `signal.reason`) works on Deno 2.9.5.
  Tests: 429 + `Retry-After: 2` honored and capped; `Retry-After` as HTTP-date; delay
  crossing deadline returns last result; network error crossing deadline throws
  `deadline` with `cause`; abort mid-sleep throws `aborted`; full-jitter bounds
  (`0 ≤ d ≤ raw`); attempts stamped on success-after-retry (`attempts: 2`).

### 5. Circuit breaker spec (`src/circuit-breaker.ts`)

- **Problem / observation.** DESIGN §6 sketches the breaker in four sentences: per-host,
  N consecutive failures, cooldown, half-open probe, plain `Map`. Unspecified: what
  counts as a failure (with non-throwing 5xx results in play), probe concurrency, map
  growth on a crawl touching 100k hosts, and instance scoping.

- **Evidence** — DESIGN §6 (Circuit breaker paragraph: "Keyed by host, state in a plain
  `Map`"), DESIGN §1 non-goals ("Any global singleton state"), DESIGN §9
  (`onCircuitOpen?(host, until)`).

- **Proposed change.**

  ```ts
  // src/circuit-breaker.ts
  export interface CircuitBreakerOptions {
  	/** Consecutive failures per host before opening. Default 5. */
  	threshold?: number;
  	/** Open duration in ms before a half-open probe. Default 30_000. */
  	cooldown?: number;
  	/** What counts as a failure. Default: error kind network|timeout|browser, or result status >= 500. */
  	isFailure?(outcome: RetryOutcome): boolean;
  	onStateChange?(info: {
  		host: string;
  		state: "closed" | "open" | "half-open";
  		until?: number; // epoch ms, set when state === "open"
  		failures: number;
  	}): void;
  	logger?: Logger;
  }
  export function createCircuitBreaker(options?: CircuitBreakerOptions): FetchLayer;
  ```

  Behavior:
  - **Keying**: `new URL(req.url).host` (includes port — distinct ports are distinct
    servers; verified `new URL("http://x.com:8080/a").host === "x.com:8080"` on Deno
    2.9.5). URL parse failure → pass through untouched (the adapter will produce the
    real error).
  - **Failure default**: error kinds `network`/`timeout`/`browser`, or `ok: false`
    result with `status >= 500`. **Design gap resolved**: 4xx — including 429 — does
    _not_ count (the host is up; 429 is rate-limiting and belongs to retry/backoff, not
    to "site just went down" detection, which is the breaker's stated purpose in §6).
    `aborted`/`deadline`/`too-large`/`unsupported-type`/`decode`: caller-side or
    content-side, never breaker failures. Any success (`ok: true`, or any non-failure
    outcome that reached the network — e.g. a 404) resets the count.
  - **States** per host: `closed` (count consecutive failures; at `threshold` → `open`,
    `until = now + cooldown`, fire `onStateChange`/`onCircuitOpen`/`logger.warn`);
    `open` (reject immediately with `kind: "circuit-open"`, finding 2 — no I/O, no
    event spam per rejection); after `until` passes, first arriving request becomes the
    **single half-open probe** (state `half-open`; concurrent requests keep rejecting
    while the probe is in flight); probe success → `closed` + entry **deleted from the
    map**; probe failure → `open` again with a fresh cooldown.
  - **Map hygiene**: entries exist only for hosts with a nonzero failure count or
    open/half-open state; on reset-to-closed the entry is deleted. This bounds memory to
    "currently unhealthy hosts", not "all hosts ever seen" — important for the crawler.
  - **Scoping**: the `Map` lives in the `createCircuitBreaker` closure — per layer
    instance, hence per fetcher instance. No module-level state (DESIGN §1 non-goal).
    Two fetchers never share breaker state; the crawler shares by sharing the fetcher.

- **Affected files.** `src/circuit-breaker.ts` (new), `src/mod.ts` (export
  `createCircuitBreaker`, `CircuitBreakerOptions`).

- **Effort / Value / Risk.** M / high / low.

- **Implementation notes.** `HostState = { state; failures; until?; probing? }`.
  Concurrency note for tests: failures are counted as requests _complete_, so N
  in-flight requests to a dying host may all fail after the circuit opens — each still
  increments/no-ops safely; only the closed→open transition fires events. Position in
  the stack: above retry (finding 1), so one logical request contributes at most one
  count regardless of its internal attempts. `RetryOutcome` comes from the shared types
  module (finding 3 note), not from `retry.ts`.

### 6. `createFetcher` wiring, `Fetcher` interface, disposal (`src/fetcher.ts`)

- **Problem / observation.** DESIGN §3 calls `createFetcher` "only a convenience that
  wires the default stack" and §5.3 sketches multi-adapter routing, but neither the
  options bag, the returned interface, default on/off state of each layer, nor disposal
  semantics are specified.

- **Evidence** — DESIGN §3, §5 (`Adapter.dispose` "must be idempotent"), §5.3, §8
  ("off by default" cache), §6 (breaker: "Separate, optional layer"). Platform:
  `Symbol.asyncDispose` is a real symbol on Deno 2.9.5 (verified `deno eval`); Node ≥
  20.4 assumed — verify at implementation time; code must guard
  (`if (Symbol.asyncDispose) ...`) so older runtimes still get plain `dispose()`.

- **Proposed change.**

  ```ts
  // src/fetcher.ts
  export interface CreateFetcherOptions {
  	/** Default: [createHttpAdapter()]. First adapter is the default route. */
  	adapters?: Adapter | Adapter[];
  	/** Consulted when req.adapter is absent. Return undefined → default adapter. */
  	selectAdapter?(req: FetchRequest): string | undefined;

  	/** Default: enabled with RetryOptions defaults. `false` disables. */
  	retry?: RetryOptions | false;
  	/** Default: DISABLED (per DESIGN "optional layer"). `true` = defaults. */
  	circuitBreaker?: CircuitBreakerOptions | boolean;
  	/** Default: disabled (DESIGN §8). Shape owned by doc 05 (bare store ⇒ defaults). */
  	cache?: CacheLayerOptions | CacheStore | false;
  	/** Timeout/deadline/maxBytes/content-type/redirect policy. Shape owned by doc 02. */
  	guards?: GuardsOptions;

  	events?: FetcherEvents;
  	logger?: Logger; // threaded into every layer + adapters that accept one

  	/** Per-request defaults, applied when the request omits them. */
  	userAgent?: string; // merged as User-Agent header unless set
  	headers?: Record<string, string>;
  	timeout?: number;
  	deadline?: number;
  	throwOnHttpError?: boolean; // routed into guards (doc 02)
  }

  export interface Fetcher {
  	fetch(url: string, init?: Omit<FetchRequest, "url">): Promise<FetchResult>;
  	fetch(req: FetchRequest): Promise<FetchResult>;
  	/** Idempotent. Disposes all adapters (allSettled; failures logged, never thrown). */
  	dispose(): Promise<void>;
  	[Symbol.asyncDispose](): Promise<void>; // alias for dispose(); enables `await using`
  }

  export function createFetcher(options?: CreateFetcherOptions): Fetcher;
  ```

  Behavior:
  - **Outer wrapper** (runs once per logical request, before the composed stack):
    normalize `fetch("https://…", init)` → `FetchRequest`; merge defaults
    (headers case-insensitively, `userAgent` → `User-Agent` only if absent); stamp
    `requestId` (finding 7); anchor `deadline` (finding 9); then call the composed
    pipeline (finding 1).
  - **Layer defaults**: retry ON (it is "the default stack", §3), breaker OFF (§6 says
    optional — but see open question 1), cache OFF (§8), guards always ON, events layer
    always ON (no-op cost when `events` is empty is one function frame).
  - **dispose()**: guarded by a `disposed` flag → idempotent; `Promise.allSettled` over
    `adapter.dispose?.()` for every configured adapter; rejections go to
    `logger?.warn("[fetcher] adapter dispose failed", err)` and are swallowed —
    disposal in a `finally` must never mask the original error. After disposal,
    `fetch()` rejects with a plain `Error("Fetcher is disposed")` (usage error, not a
    `PageFetchError` — it is not a fetch outcome).
  - `Symbol.asyncDispose` added conditionally at object construction so `await using
    fetcher = createFetcher(...)` works on Deno/modern Node without breaking older
    runtimes.

- **Affected files.** `src/fetcher.ts` (new), `src/mod.ts` (export `createFetcher`,
  `Fetcher`, `CreateFetcherOptions`).

- **Effort / Value / Risk.** M / high / low.

- **Implementation notes.** `createFetcher` bridges layer callbacks to
  events + logger (the layers never import `FetcherEvents` — they stay standalone):
  retry `onRetry` → user `retry.onRetry` (if any) then `events.onRetry` then
  `logger.warn`; breaker `onStateChange(state === "open")` → `events.onCircuitOpen` +
  `logger.warn`. Adapters that accept `logger` in their factory options get the same
  instance passed by the user directly (adapter construction is the user's job;
  document the pattern). Subpath-export layout (`./adapters`, `./cache` per DESIGN §2)
  vs the current single `exports: "./src/mod.ts"` (deno.json:4) is a packaging concern
  — pointer to the packaging dimension doc.

### 7. Events: attempt-level layer, `safeEmit`, `requestId` threading (`src/events.ts`)

- **Problem / observation.** DESIGN §9 defines `FetcherEvents` and two rules — emit
  **per attempt**, and thread a per-logical-request `requestId` through every event —
  but not _where_ events fire, what happens when a handler throws, or where `requestId`
  physically lives (the `FetchFn` signature has nowhere else to carry it than the
  request object).

- **Evidence** — DESIGN §9 (interface, granularity rule, requestId rule); DESIGN §4
  (`FetchRequest`/`FetchResult` have no `requestId` field — **Design gap**). Platform:
  `crypto.randomUUID` verified on Deno 2.9.5.

- **Proposed change.**
  - **Placement**: a dedicated events layer sits directly _below_ retry (finding 1), so
    `onRequest` / `onResponse` / `onError` fire once per attempt, per §9:

    ```ts
    // src/events.ts
    export interface FetcherEvents {/* per DESIGN §9, onRetry per finding 3 */}
    export function createEventsLayer(events: FetcherEvents, logger?: Logger): FetchLayer;
    ```

    Exact firing points:

    | Event           | Fired by                | When                                                                   |
    | --------------- | ----------------------- | ---------------------------------------------------------------------- |
    | `onRequest`     | events layer            | start of every attempt (sees normalized req incl. requestId)           |
    | `onResponse`    | events layer            | every attempt resolving with a result, incl. `ok: false`               |
    | `onResponse`    | cache layer (bridged)   | cache hit (`fromCache: true`) — doc 05 owns internals, pointer         |
    | `onError`       | events layer            | every attempt throwing a `PageFetchError` (emit, then rethrow)         |
    | `onRetry`       | retry layer (bridged)   | once per scheduled retry, before the sleep (finding 4 step 7)          |
    | `onCircuitOpen` | breaker layer (bridged) | on closed→open and half-open→open transitions only (not per rejection) |

    Deliberate non-emissions, documented: breaker rejections do not fire `onError`
    (no I/O happened; an open circuit would otherwise emit thousands of events/sec —
    the caller already receives the rejection, and `onCircuitOpen` marks the
    transition). See open question 4.
  - **Handlers must never throw into the pipeline** (design doc is silent — required
    here): every invocation goes through

    ```ts
    export function safeEmit<A extends unknown[]>(
    	logger: Logger | undefined,
    	handler: ((...args: A) => void) | undefined,
    	...args: A
    ): void; // try/catch; on throw: logger?.warn("[events] handler threw", err); never rethrows
    ```

    A buggy `onResponse` must not convert a successful fetch into a failure.
  - **requestId**: **Design deviation** (field addition; the types are owned by doc 01
    — coordinate): add `requestId?: string` to `FetchRequest` (caller-suppliable for
    cross-system correlation; `createFetcher` stamps `crypto.randomUUID()` when absent)
    and `requestId: string` to `FetchResult` (echoed). Events receive it via the
    req/res they already carry; `onRetry`/bridged payloads include it explicitly
    (finding 3). This is strictly better than smuggling it through `meta` (which is
    documented as caller-owned, §4).

- **Affected files.** `src/events.ts` (new), `src/fetcher.ts` (stamping + bridging),
  doc-01's types file (`requestId` fields — pointer).

- **Effort / Value / Risk.** M / high / low.

- **Implementation notes.** The events layer is ~20 lines: wrap `next`, safeEmit
  onRequest, `try { res = await next(req); safeEmit(onResponse); return res } catch (e)
  { if PageFetchError safeEmit(onError, e, req); throw e; }`. Test: a throwing handler
  on every hook; pipeline result unchanged, one `logger.warn` per throw.

### 8. Logger threading (`@marianmeres/clog` `Logger` as a first-class citizen)

- **Problem / observation.** DESIGN §9 says "the package emits, it does not log" — the
  user requirement overrides this partially: every factory accepts an optional
  `Logger`, silent by default. Logging _complements_ events (human-readable dev/ops
  output vs structured hooks); it must not replace or duplicate the events contract.

- **Evidence** — user requirement (task brief);
  `/Users/mm/projects/@marianmeres/clog/src/clog.ts:186-218` (`Logger` interface:
  `debug`/`log`/`warn`/`error`, variadic `any`, structurally satisfied by `console` and
  `createClog(ns)` — verified by reading the file).

- **Proposed change.**
  - `import type { Logger } from "@marianmeres/clog";` in one place (the shared types
    module, doc 01) and re-export it from `src/mod.ts`. Type-only import → erased at
    runtime → the zero-runtime-dep promise (DESIGN §2) holds; `@marianmeres/clog` is
    added to `deno.json` imports as a compile-time dep (accepted per brief).
  - Every factory in this doc's scope gets `logger?: Logger`: `createRetry`,
    `createCircuitBreaker`, `createEventsLayer`, `createFetcher` (which passes its
    logger down into layers it constructs, without overriding a logger explicitly
    given in a layer's own options bag). Adapters/guards/cache: same convention —
    pointer to docs 01/02/05.
  - **Silent default via optional chaining** — `logger?.warn(...)` everywhere; no
    no-op logger object, no conditionals.
  - Level conventions (this doc's layers):

    | Layer    | Level   | What                                                                 |
    | -------- | ------- | -------------------------------------------------------------------- |
    | retry    | `warn`  | per retry: `"[retry] 2/3 in 823ms <url> (network: ECONNRESET)"`      |
    | retry    | `debug` | giving up (attempts exhausted / deadline fail-fast)                  |
    | breaker  | `warn`  | circuit opens: `"[breaker] open <host> until <iso> (5 failures)"`    |
    | breaker  | `debug` | half-open probe start; close-after-probe                             |
    | fetcher  | `debug` | dispose start/done; adapter routing decision (name) per request      |
    | fetcher  | `warn`  | adapter dispose failure; event handler threw (via `safeEmit`)        |
    | adapters | `debug` | request start/finish (url, status, ms) — details owned by docs 01/02 |

    No `error`-level calls in this scope: errors are _thrown_ (and emitted via
    `onError`); logging them too would double-report. Message prefix `[retry]`/
    `[breaker]`/`[fetcher]` so a single `createClog("page-fetcher")` instance still
    yields attributable lines.

- **Affected files.** every factory file in scope; `deno.json` (compile-time import);
  `src/mod.ts` (re-export `Logger` type).

- **Effort / Value / Risk.** S / med / low.

- **Implementation notes.** Do not pass `logger` into user-supplied callbacks; it is an
  input, not part of event payloads. Tests: a recording fake `Logger`; assert silence
  by default and exact warn count on a retried request.

### 9. Deadline anchoring convention (`resolveDeadline`, "first touch converts")

- **Problem / observation.** `FetchRequest.deadline?: number | Date` (§4) — a number is
  relative ms, a `Date` is absolute. The deadline spans attempts, so it must be
  anchored (converted to absolute) exactly once per logical request; if both the retry
  layer and the guards layer independently interpreted a relative number against their
  own `Date.now()`, the deadline would silently slide later on every attempt —
  a correctness bug that no test hits unless designed for.

- **Evidence** — DESIGN §4 (`deadline?: number | Date`, "Hard deadline across all
  attempts"), §6 ("Retries must respect the total deadline"), §7 (timeout vs deadline
  "are separate concepts and both must be enforced").

- **Proposed change.** One shared util plus one composition rule:

  ```ts
  // src/utils.ts
  /** number → now + n (relative ms); Date → getTime(); undefined passes through.
   *  Returns absolute epoch ms — the internal arithmetic representation. */
  export function resolveDeadline(
  	deadline: number | Date | undefined,
  	now?: number,
  ): number | undefined;
  ```

  Rule: the **outermost layer that reads `deadline` anchors it** — it replaces a
  relative `number` on the request it passes down with the absolute form
  (`new Date(resolveDeadline(d))`, since within the `number | Date` request type only
  `Date` unambiguously means "absolute"); every layer below treats `Date` as absolute
  and uses `resolveDeadline` to get epoch ms for comparisons. In the wired stack,
  `createFetcher`'s outer wrapper anchors (so cache/breaker/retry/guards all see the
  absolute value); a standalone `createRetry` anchors itself (idempotent — a `Date`
  passes through unchanged). Guards (doc 02) then compute per-attempt effective
  timeout as `min(req.timeout, deadlineRemaining)` — pointer.

- **Affected files.** `src/utils.ts`, `src/fetcher.ts`, `src/retry.ts`; doc 02's guards
  consume the convention.

- **Effort / Value / Risk.** S / med / low.

- **Implementation notes.** Test: `deadline: 1000` with 3 slow attempts — assert the
  total wall clock honors ~1000ms, not 3 × 1000ms.

### 10. Adapter routing rules (terminal `FetchFn` in `src/fetcher.ts`)

- **Problem / observation.** DESIGN §5.3 says `createFetcher` accepts multiple adapters
  plus optional `selectAdapter(req) => name`, but not the precedence, the default when
  several are given, or the failure mode for an unknown name.

- **Evidence** — DESIGN §5.3; §4 (`FetchRequest.adapter?: string`), §4
  (`FetchResult.adapter: string`).

- **Proposed change.** Terminal function `routeFetch(req)` with this precedence:
  1. `req.adapter` (explicit name) — highest priority;
  2. `selectAdapter(req)` when provided and returning a string;
  3. the **first adapter in the `adapters` array** (or the single adapter given).

  Unknown name (from either source) → throw
  `TypeError('Unknown adapter "<name>". Available: http, browser')` — a programmer/
  config error, deliberately _not_ a `PageFetchError` (it is not a fetch outcome, must
  never be retried, and should fail loudly in development). Note the breaker/retry
  layers pass `TypeError` through untouched (they only classify `PageFetchError`s and
  results — spec this explicitly in both). Routing logs the decision at `debug`.
  `FetchResult.adapter` is set by the adapter itself (contract, §5).

  > **Cut from the draft:** a dev-time assertion that `FetchResult.adapter` matches the
  > routed name (`logger?.warn` on mismatch) — over-engineering: §5 already makes the
  > field the adapter's contract; cross-checking every response adds noise for a
  > condition only a broken custom adapter can produce.

- **Affected files.** `src/fetcher.ts`.

- **Effort / Value / Risk.** S / med / low.

- **Implementation notes.** Adapters are stored in a `Map<string, Adapter>` built once
  in `createFetcher`; duplicate names → throw `TypeError` at construction time.
  Document the §5.3 recipe (HEAD-cheap-first, escalate to browser) in the README —
  content owned by the adapter dimension doc, pointer.

## Open questions / decisions needed

- **Circuit breaker default in `createFetcher`: off (as DESIGN §6's "optional layer"
  implies) or on-with-defaults?** The crawler — the package's primary consumer — is the
  stated reason the breaker exists; defaulting it off means the common consumer must
  remember to enable it. This doc specs OFF to honor the design; flipping to ON is a
  one-line change but should be the owner's call before v1 (it changes observable
  behavior for plain users whose flaky host suddenly starts getting `circuit-open`
  rejections).
- **Serve-stale-on-circuit-open?** With cache outermost, a cache _miss_ on an open
  circuit fails even when a stale entry exists (dev-cache mode would have served it;
  conditional-mode entries are "stale but real"). A `staleIfError`-style escape hatch
  would be genuinely useful for the crawler but grows the cache/breaker contract —
  in or out of v1? (Overlaps doc 05.)
- **`requestId` as public fields on `FetchRequest`/`FetchResult`** (finding 7's
  recommendation) vs keeping it internal to event payloads only — it is a public-type
  addition beyond the DESIGN §4 sketch, so doc 01 and the owner should ratify.
- **Observability of non-I/O outcomes**: this doc specs cache hits emitting
  `onResponse` (bridged) but breaker rejections NOT emitting `onError`
  (transition-only `onCircuitOpen`, to avoid event storms while open). If the
  crawler's accounting needs every rejection as an event, this needs an
  `onCircuitReject` hook instead — confirm the intended crawler contract.
- **`Retry-After` on the `throwOnHttpError` path** (finding 4 step 5): honoring it
  requires headers (or the result) reachable from the `http`-kind `PageFetchError` —
  doc 01 owns whether the error carries them; until then, backoff applies there.

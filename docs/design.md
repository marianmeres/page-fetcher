<!--
Promoted from `tmp/page-fetcher-DESIGN.md` on 2026-08-23 (tmp/ is gitignored, so the
founding document would otherwise never enter the repo's history).

The sketch below is preserved verbatim as a record of *intent*. It is NOT a description
of what was built — see `docs/architecture.md` for that, and `docs/plan/` for the
implementation analysis. Where the implementation knowingly departs from the sketch, the
deviation is listed under "Accepted deviations" immediately below; the list grows as the
plan's remaining decisions are recorded in `docs/plan/PROGRESS.md`.
-->

# Accepted deviations from this sketch

| §     | Sketch says                                                        | Implementation does                                                                                                                                    | Why                                                                                                                                                                                                                                                                  |
| ----- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §2    | "Zero required runtime dependencies"                               | npm artifact declares one dependency: `@marianmeres/clog`                                                                                              | Used for its `Logger` type only; the import is type-only and erased at runtime, but the emitted `.d.ts` references it, so consumers' `tsc` must resolve it. Ecosystem precedent (fts, connection-monitor). No clog code runs unless the caller passes a clog logger. |
| §3    | All guards are `(next: FetchFn) => FetchFn` wrappers               | Stream guards (`maxBytes`, content-type policy, charset) are in-adapter helper modules; only timeout / deadline / abort composition are wrapper layers | A wrapper sees a finished `FetchResult` — too late to abort an oversized download or skip a body. See [plan 02](./plan/02-http-adapter-and-guards.md) #3.                                                                                                            |
| §3    | Stack diagram order (retry/breaker → cache → guards → adapter)     | Wired order is `outer instrumentation (requestId + deadline anchor) → cache → circuit-breaker → retry → per-attempt timeout → adapter routing`         | A cache hit must not consult an open breaker; the breaker must count logical outcomes, not attempts; the deadline spans attempts so it anchors above retry. See [plan 03](./plan/03-resilience-and-composition.md) #1/#9.                                            |
| §4    | `body?: BodyInit`                                                  | `body?: ReplayableBody \| (() => ReplayableBody \| ReadableStream<Uint8Array>)`                                                                        | `ReadableStream` is one-shot; a retried request with a stream body corrupts silently. The factory form is the streaming escape hatch — one fresh body per attempt. See [plan 01](./plan/01-public-contracts.md) #7.                                                  |
| §4    | `PageFetchError.kind` union                                        | Adds `circuit-open` and `no-body`                                                                                                                      | The breaker's rejection must be distinguishable from a real network failure; reading an intentionally absent body needs its own kind. See [plan 01](./plan/01-public-contracts.md) #4/#6.                                                                            |
| §4/§9 | `requestId` "threaded through every event", but no type carries it | `requestId` is a first-class field on `FetchRequest` (optional in), `FetchResult` (always), `PageFetchError` and every event payload                   | The sketch's own correlation requirement is otherwise unimplementable. See [plan 01](./plan/01-public-contracts.md) #1.                                                                                                                                              |
| §6/§9 | `isRetryable(err, res?)`, `onRetry({ err })`                       | Both take a `RetryOutcome` either/or pair (`{ error?, result? }`)                                                                                      | Non-2xx resolves as data (§4), so the dominant retry trigger is a _result_, not an error — the sketch's own signatures cannot express its own 429/5xx table. See [plan 03](./plan/03-resilience-and-composition.md) #3.                                              |
| §6    | Breaker rejects with `kind: "network", retryable: false`           | Breaker rejects with `kind: "circuit-open", retryable: false, details: { host, until }`                                                                | "We refused locally" is not "the host is unreachable"; the crawler branches on it. See [plan 03](./plan/03-resilience-and-composition.md) #2.                                                                                                                        |
| §7    | Charset order: header → BOM → meta → fallback                      | BOM → header → meta → fallback                                                                                                                         | WHATWG/browser order. A BOM is ground truth written by the encoder; `charset=` params are routinely stale server config. See [plan 02](./plan/02-http-adapter-and-guards.md) #2.                                                                                     |
| §7    | Default allow-list contains `+json`                                | Also contains `application/json` and `+xml`                                                                                                            | Read literally as a suffix rule, `+json` does not match `application/json` — the most common JSON mime would be rejected by the defaults. See [plan 02](./plan/02-http-adapter-and-guards.md) #6.                                                                    |
| §7    | "Do not forward `Authorization` across origins"                    | `Authorization` **and** `Cookie` are dropped on cross-origin redirect hops                                                                             | A caller-set `Cookie` header carries the same session-leak risk. See [plan 02](./plan/02-http-adapter-and-guards.md) #4.                                                                                                                                             |
| §9    | "Emit per attempt, not per logical request"                        | `onRequest`/`onRetry` are per attempt; `onResponse`/`onError` are terminal, exactly once per logical request                                           | A failed attempt throws and has no `FetchResult` to emit, and `onResponse` takes the aggregate result — the literal rule is unimplementable. See [plan 01](./plan/01-public-contracts.md) #3.                                                                        |
| §9    | `onCircuitOpen(host, until)`                                       | `onCircuitOpen({ host, until, requestId? })`                                                                                                           | Consistency with the other payloads + correlation.                                                                                                                                                                                                                   |
| §11.1 | "Eager for the browser adapter, lazy for HTTP"                     | Eager bytes + lazy memoized decode, identical across all adapters                                                                                      | The HTTP adapter must stream the body anyway to enforce `maxBytes`; two behaviors behind one method would create adapter-dependent semantics. See [plan 01](./plan/01-public-contracts.md) #2.                                                                       |
| §12   | Fixture server last (step 10)                                      | Fixture server lands before the HTTP adapter                                                                                                           | Every I/O test from the adapter onward consumes it.                                                                                                                                                                                                                  |

---

# `@marianmeres/page-fetcher` — Design Sketch

> High-level design document for a coding agent. Describes intent, boundaries and the
> public surface. It is **not** an implementation plan for internals — the agent decides
> those, but must not violate the contracts below.

---

## 1. Purpose

Fetch **one** web page (or resource) by URL and return a normalized result, regardless of
whether the bytes came from a headless browser or a plain `fetch`.

This package knows nothing about links, recursion, sites, or crawling. It is the
transport layer. `@marianmeres/crawler` sits on top of it.

### In scope

- Adapter-based fetching (browser / raw HTTP / custom)
- Retries with a sane policy
- Timeouts, cancellation, redirects
- Response guards (content-type, size)
- Correct text decoding
- Optional response caching (incl. conditional requests)
- Browser lifecycle and pooling

### Explicitly out of scope (non-goals)

- Link extraction, URL normalization, frontier, robots.txt → `crawler`
- HTML parsing beyond charset sniffing
- Data extraction / scraping DSL
- Any global singleton state or process-wide config

---

## 2. Package shape

- TypeScript, ESM only. Published to JSR + npm.
- Runtime target: Deno first, Node compatible. No Deno-only APIs in the core.
- **Zero required runtime dependencies.** The browser driver (Playwright or Puppeteer) is
  an _optional peer dependency_, loaded lazily and only when the browser adapter is used.
  Installing this package must never pull down a browser binary.

Suggested exports:

```
@marianmeres/page-fetcher            → createFetcher, types
@marianmeres/page-fetcher/adapters   → createHttpAdapter, createBrowserAdapter
@marianmeres/page-fetcher/cache      → createMemoryCache, cache store interface
```

---

## 3. Core concepts

```
createFetcher(options) → Fetcher
                          │
                          ├─ retry / backoff / circuit breaker   (wrapper)
                          ├─ cache + conditional requests        (wrapper, optional)
                          ├─ guards: content-type, size, timeout (wrapper)
                          └─ Adapter                             (does the actual I/O)
```

Each layer is an independent, composable function. `createFetcher` is only a convenience
that wires the default stack. Every layer must also be usable standalone — the crawler
package (and the user) may compose its own stack.

**Design rule:** layers are `(next: FetchFn) => FetchFn`. No class hierarchies, no
inheritance, no plugin registry. Composition is a plain `reduce`.

---

## 4. Public types (sketch)

```ts
type FetchFn = (req: FetchRequest) => Promise<FetchResult>;

interface FetchRequest {
	url: string;
	method?: "GET" | "HEAD" | "POST";
	headers?: Record<string, string>;
	body?: BodyInit;
	signal?: AbortSignal;

	/** Per-attempt timeout (ms). */
	timeout?: number;
	/** Hard deadline across all attempts (ms or absolute Date). */
	deadline?: number | Date;

	/** Adapter selection / per-request adapter overrides. */
	adapter?: string; // e.g. "browser" | "http"
	adapterOptions?: Record<string, unknown>;

	/** Arbitrary caller payload, echoed back on the result. Crawler uses it for depth/referrer. */
	meta?: Record<string, unknown>;
}

interface FetchResult {
	ok: boolean;
	url: string; // requested URL (normalized only in the trivial sense)
	finalUrl: string; // after redirects — CRITICAL, callers resolve relative refs against this
	status: number;
	statusText?: string;
	headers: Headers;
	redirects: string[]; // chain, excluding finalUrl

	/** Decoded text. Lazily materialized where the adapter allows it. */
	text(): Promise<string>;
	/** Raw bytes, if retained (see `retainBody`). */
	bytes(): Promise<Uint8Array>;

	contentType?: string; // parsed mime, lowercased, no params
	charset?: string; // as detected/decided
	size?: number; // bytes actually read

	fromCache: boolean;
	notModified: boolean; // 304 path taken

	timing: FetchTiming;
	attempts: number;
	adapter: string;

	meta?: Record<string, unknown>;
	/** Adapter-specific extras (browser: title, screenshot handle, console errors...). */
	extra?: Record<string, unknown>;
}

interface FetchTiming {
	startedAt: number;
	endedAt: number;
	total: number;
	dns?: number;
	connect?: number;
	ttfb?: number;
	download?: number;
	render?: number; // browser adapter only
}
```

### Errors

A single error class with a discriminating `kind`, so callers (and the retry policy) can
branch without string matching:

```ts
class PageFetchError extends Error {
	kind:
		| "network" // DNS, ECONNRESET, TLS
		| "timeout" // per-attempt timeout
		| "deadline" // total deadline exceeded
		| "aborted" // AbortSignal
		| "http" // non-2xx, when treated as error
		| "too-large" // exceeded maxBytes
		| "unsupported-type"
		| "too-many-redirects"
		| "browser" // launch/crash/navigation failure
		| "decode";
	status?: number;
	url: string;
	finalUrl?: string;
	attempts: number;
	retryable: boolean;
	cause?: unknown;
}
```

**Decision to make explicit in the README:** a non-2xx response is **not** an error by
default — it resolves with `ok: false`. Crawlers need 404s and 500s as data. Throwing is
opt-in via `throwOnHttpError`.

---

## 5. Adapter contract

```ts
interface Adapter {
	name: string;
	fetch: FetchFn;
	/** Called once on fetcher teardown. Must be idempotent. */
	dispose?(): Promise<void>;
	/** Optional readiness/health probe (browser launch check). */
	health?(): Promise<boolean>;
}
```

### 5.1 HTTP adapter (`createHttpAdapter`)

Thin wrapper over the platform `fetch`.

- Manual redirect handling (`redirect: "manual"`) so the chain is observable and cappable.
- Streams the body and aborts as soon as `maxBytes` is exceeded — never buffer first.
- Sends `Accept-Encoding` and lets the platform decompress.
- Cookie jar: optional, injected, off by default.

### 5.2 Browser adapter (`createBrowserAdapter`)

Default adapter for the crawler's HTML pages. Driver (Playwright/Puppeteer) is injected or
lazily imported — **the adapter must work with either**, behind a tiny internal driver
interface (`launch`, `newContext`, `newPage`, `goto`, `content`, `close`).

Required capabilities:

- **Wait strategy**: `"load" | "domcontentloaded" | "networkidle" | { selector } | { fn }`.
  Per-request overridable. `networkidle` needs its own timeout separate from navigation.
- **Resource blocking**: block `image`, `media`, `font`, `stylesheet` by default (config).
  This is typically a 3–5× throughput win on real sites and must be on by default with a
  loud note in the docs.
- **Context strategy**: `"shared" | "per-request" | "pooled"`. Default `pooled`.
- **Pool**: N contexts/pages, acquire/release with a queue, per-page max reuse count
  (recycle after k pages to bound leaks).
- **Crash recovery**: if the browser or a context dies, mark the attempt retryable, tear
  down and relaunch on next acquire. A crashed browser must never wedge the pool.
- **Zombie cleanup**: `dispose()` kills the browser; also register a
  process-exit/SIGINT hook (opt-out) — orphaned Chromium processes are the #1 complaint
  about tools like this.
- **`evaluate` hook**: `onPage(page, req) => extra` so callers can grab
  post-render data, screenshots or PDFs without this package knowing about them.
- Optional: viewport/device, locale/timezone, `javaScriptEnabled: false` mode, UA override,
  block/allow URL patterns, capture console errors + failed requests into `extra`.

### 5.3 Adapter routing

`createFetcher` accepts multiple adapters and an optional `selectAdapter(req) => name`.
Common recipe to document: HEAD/cheap `fetch` first, escalate to browser only when the
content-type is HTML and the response looks JS-rendered — or simply route by URL pattern.

---

## 6. Retry layer

```ts
interface RetryOptions {
	attempts?: number; // total attempts, default 3
	backoff?: "exponential" | "linear" | "fixed" | ((attempt: number) => number);
	baseDelay?: number; // default 500ms
	maxDelay?: number; // default 30s
	jitter?: boolean; // default true — full jitter
	respectRetryAfter?: boolean; // default true, capped by maxDelay
	isRetryable?(err: PageFetchError, res?: FetchResult): boolean;
	onRetry?(info: { attempt: number; delay: number; err: PageFetchError }): void;
}
```

Default retryable classification:

| Condition                               | Retry |
| --------------------------------------- | ----- |
| network / timeout / browser crash       | yes   |
| 408, 425, 429, 5xx                      | yes   |
| 3xx (handled, not retried)              | n/a   |
| 4xx other than above                    | no    |
| `too-large`, `unsupported-type`, decode | no    |
| `aborted`, `deadline`                   | no    |

Retries must respect the **total deadline** — never sleep past it, fail fast instead.

### Circuit breaker (per host)

Separate, optional layer. After N consecutive failures for a host, open the circuit for a
cooldown window and fail subsequent requests to that host immediately with
`kind: "network", retryable: false`. Half-open probe on expiry. Keyed by host, state in a
plain `Map`. The crawler relies on this to avoid hammering a site that just went down.

---

## 7. Guards & correctness details

These are the things that quietly break in production; treat them as requirements.

- **Redirects**: cap (`maxRedirects`, default 5), record the chain, detect loops, carry
  `finalUrl`. Do not forward `Authorization` across origins.
- **`maxBytes`**: enforced while streaming, default ~10 MB. Exceeding it aborts the read
  and returns `too-large`.
- **Content-type policy**: `allowContentTypes` (default: `text/html`, `application/xhtml+xml`,
  `text/plain`, `application/xml`, `text/xml`, `+json`) and `onUnsupportedType:
  "error" | "skip-body"`. `skip-body` returns headers only — useful for link checking.
- **Charset**: decide by, in order — HTTP `Content-Type; charset`, BOM, `<meta charset>` /
  `<meta http-equiv>` in the first ~2 KB, then fallback (`utf-8`, configurable). Decode via
  `TextDecoder` with the resolved label; fall back to utf-8 on unknown labels rather than
  throwing. **Legacy central-European sites still serve `windows-1250`** — there must be a
  test fixture for this.
- **Timeouts**: per-attempt `timeout` _and_ overall `deadline` are separate concepts and
  both must be enforced.
- **Cancellation**: a caller `AbortSignal` must propagate to the platform fetch, to
  browser navigation, and to retry sleeps. Combine caller signal + internal timeout signal
  (`AbortSignal.any`).
- **Defaults**: a descriptive default User-Agent that identifies the tool and can be
  overridden. Document that users should set a contact URL in it.

---

## 8. Cache layer (optional)

Pluggable, off by default. Two distinct purposes — support both via one interface:

1. **Dev cache**: avoid re-hitting the network while iterating on downstream extraction
   logic. Ignores freshness, keyed by method+URL+adapter.
2. **Conditional revalidation**: store `ETag` / `Last-Modified`, send
   `If-None-Match` / `If-Modified-Since`, resolve 304 into a full result from the store with
   `notModified: true`.

```ts
interface CacheStore {
	get(key: string): Promise<CachedEntry | undefined>;
	set(key: string, entry: CachedEntry): Promise<void>;
	delete(key: string): Promise<void>;
}
```

Ship `createMemoryCache()` only. Document how to back it with SQLite or the filesystem;
do not depend on either.

---

## 9. Observability

The package emits, it does not log. All reporting goes through an injected object so it can
be bound to the job library at the edges without this package knowing about it.

```ts
interface FetcherEvents {
	onRequest?(req: FetchRequest): void;
	onResponse?(res: FetchResult): void;
	onRetry?(
		info: { url: string; attempt: number; delay: number; err: PageFetchError },
	): void;
	onError?(err: PageFetchError, req: FetchRequest): void;
	onCircuitOpen?(host: string, until: number): void;
}
```

Granularity rule: emit **per attempt**, not per logical request. `FetchResult.attempts` and
`timing` carry the aggregate. A `requestId` (uuid) should be generated per logical request
and threaded through every event so log lines correlate.

---

## 10. Testing requirements

- A local fixture HTTP server (redirect chains, slow responses, `windows-1250` page,
  gzip, oversized body, 429 with `Retry-After`, 304 flow).
- Zero network access in the default test run. Browser adapter tests behind a flag/tag.
- Fake timers for the retry/backoff tests.
- An explicit leak test: launch, fetch N pages, dispose, assert no child processes remain.

---

## 11. Open questions to resolve before v1

1. Is `text()` lazy or eager? Lazy is better for memory but complicates caching and the
   browser adapter (page already closed). Suggestion: **eager for the browser adapter,
   lazy for HTTP**, hidden behind the same method.
2. Should the HTTP adapter support HTTP/2 & keep-alive tuning, or defer to the platform?
   (Deno/Node differ.) Suggestion: defer, document.
3. Cookie jar: bundle a minimal one or leave entirely to the caller? Suggestion: leave out
   of v1, accept a `cookies` header/callback.
4. Do we expose a `HEAD`-then-`GET` helper here, or is that a crawler concern?

---

## 12. Implementation order

1. Types, `PageFetchError`, timing.
2. HTTP adapter (redirects, streaming, `maxBytes`, charset decode).
3. Guards layer (timeout, deadline, content-type, abort composition).
4. Retry layer + classification + backoff.
5. Circuit breaker.
6. `createFetcher` composition + events.
7. Browser adapter: driver interface, single-context version.
8. Browser pool, recycling, crash recovery, dispose/exit hooks.
9. Cache layer + conditional requests.
10. Fixture server, tests, README with the recipes from §5.3 and §8.

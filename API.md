# API

Complete reference for `@marianmeres/page-fetcher`. The [README](README.md) is the
overview and the recipes; this is every export, grouped by entry point.

| Import specifier                     | Contains                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| `@marianmeres/page-fetcher`          | `createFetcher`, the layers, `compose`, `PageFetchError`, the shared types      |
| `@marianmeres/page-fetcher/adapters` | `createHttpAdapter`, `createBrowserAdapter`, the drivers, the pool, the helpers |
| `@marianmeres/page-fetcher/cache`    | `createCacheLayer`, `createMemoryCache`, the store contract, serialization      |

The root module also re-exports the four cache **types** (`CacheStore`, `CachedEntry`,
`CacheMode`, `CacheLayerOptions`), so `createFetcher({ cache })` is spellable without a
second import.

## Table of contents

- [Core](#core) — [Functions](#functions) · [PageFetchError](#pagefetcherror) ·
  [Types](#types) · [Constants](#constants)
- [Adapters](#adapters) — [HTTP](#http-adapter) · [Browser](#browser-adapter) ·
  [Drivers](#browser-drivers) · [Context pool](#context-pool) ·
  [Resource blocking](#resource-blocking) · [Waiting](#waiting) ·
  [Content type, charset, body](#content-type-charset-and-body-helpers) ·
  [Exit hooks](#exit-hooks)
- [Cache](#cache)
- [Defaults at a glance](#defaults-at-a-glance)

---

# Core

`import { … } from "@marianmeres/page-fetcher";`

## Functions

### `createFetcher()`

Wire the default layer stack over one or more adapters and return a
[`Fetcher`](#fetcher).

**Parameters:** `options` ([`CreateFetcherOptions`](#createfetcheroptions), optional)

**Returns:** [`Fetcher`](#fetcher)

**Throws:** `TypeError` for an empty `adapters` array or duplicate adapter names.

```ts
import { createFetcher } from "@marianmeres/page-fetcher";

await using fetcher = createFetcher({
	timeout: 10_000,
	retry: { attempts: 4 },
	circuitBreaker: true,
	userAgent: "acme-crawler (+https://acme.test/bot)",
});

const res = await fetcher.fetch("https://example.com/");
```

The wired order, outermost first: `cache` → `circuit breaker` → `events` →
`http error guard` → `deadline guard` → `retry` → `timeout guard` → routing. Placement
is a contract — see [docs/architecture.md](docs/architecture.md).

### `compose()`

Fold layers over a terminal `FetchFn`. Layers are listed **outermost first**:
`compose([a, b], t)` builds `a(b(t))`.

**Parameters:**

- `layers` ([`FetchLayer[]`](#fetchlayer)) — outermost first
- `terminal` ([`FetchFn`](#fetchfn)) — usually an adapter's `fetch`

**Returns:** [`FetchFn`](#fetchfn)

```ts
import { compose, createRetry, timeoutGuard } from "@marianmeres/page-fetcher";
import { createHttpAdapter } from "@marianmeres/page-fetcher/adapters";

const fetchFn = compose([createRetry(), timeoutGuard()], createHttpAdapter().fetch);
```

### `createRetry()`

The retry layer: owns the attempt loop, the backoff sleeps, the `attempts` counter and
the per-attempt `onRequest` / `onRetry` events.

**Parameters:** `options` ([`RetryOptions`](#retryoptions), optional)

**Returns:** [`FetchLayer`](#fetchlayer)

```ts
import { createRetry } from "@marianmeres/page-fetcher";
import { createHttpAdapter } from "@marianmeres/page-fetcher/adapters";

const fetchFn = createRetry({ attempts: 4, baseDelay: 250 })(createHttpAdapter().fetch);
```

Retrying never converts a result into a throw or vice versa; whatever the last attempt
produced is what the caller sees. A relative `deadline` is anchored here too, and the
layer never sleeps past it.

### `createCircuitBreaker()`

Per-host circuit breaker. After `threshold` consecutive failures for a host, requests to
it are refused locally with `kind: "circuit-open"` until `cooldown` elapses; then exactly
one probe is allowed through.

**Parameters:** `options` ([`CircuitBreakerOptions`](#circuitbreakeroptions), optional)

**Returns:** [`FetchLayer`](#fetchlayer)

```ts
import { createCircuitBreaker, createRetry } from "@marianmeres/page-fetcher";
import { createHttpAdapter } from "@marianmeres/page-fetcher/adapters";

const fetchFn = createCircuitBreaker({ threshold: 3, cooldown: 10_000 })(
	createRetry()(createHttpAdapter().fetch),
);
```

State lives in a `Map` in the factory closure — per layer instance, hence per fetcher.
Place it **above** retry (one logical request counts once) and **below** the cache.
Outcomes that prove nothing about the host (`aborted`, `deadline`, a nested
`circuit-open`) neither count as failures nor reset the counter.

### `createEventsLayer()`

Emits the terminal pair — `onResponse` on success, `onError` on failure — exactly once
per logical request.

**Parameters:** `options` ([`ObservabilityOptions`](#observabilityoptions), optional)

**Returns:** [`FetchLayer`](#fetchlayer)

```ts
import { compose, createEventsLayer, createRetry } from "@marianmeres/page-fetcher";
import { createHttpAdapter } from "@marianmeres/page-fetcher/adapters";

const fetchFn = compose([
	createEventsLayer({ events: { onResponse: (r) => console.log(r.status) } }),
	createRetry(),
], createHttpAdapter().fetch);
```

A non-`PageFetchError` throw passes through unannounced — `onError` promises callers a
`PageFetchError`.

### `safeEmit()`

Call a user-supplied callback without ever letting it affect the fetch: a returned
promise is not awaited, and a throw is reported via `logger.warn` and swallowed. Use it
for every callback in a custom layer.

**Parameters:**

- `handler` (`((...args: A) => void) | undefined`) — no-op when `undefined`
- `logger` ([`Logger`](#logger) `| undefined`)
- `...args` (`A`) — passed through to the handler

**Returns:** `void`

```ts
import { safeEmit } from "@marianmeres/page-fetcher";
import type { FetchResult, Logger } from "@marianmeres/page-fetcher";

declare const onDone: ((res: FetchResult) => void) | undefined;
declare const logger: Logger | undefined;
declare const res: FetchResult;

safeEmit(onDone, logger, res);
```

### `timeoutGuard()`

Per-attempt timeout. The effective budget is `min(timeout, deadline remaining)`, and
whichever constraint binds names the failure: `kind: "timeout"` (retryable) or
`kind: "deadline"` (not).

**Parameters:** `options` ([`TimeoutGuardOptions`](#timeoutguardoptions), optional)

**Returns:** [`FetchLayer`](#fetchlayer)

Place it **below** retry, so the budget re-arms on every attempt.

### `deadlineGuard()`

Total deadline across all attempts. Fails fast when the deadline has already passed
(`attempts: 0`), anchors a relative deadline into an absolute `Date` for every layer
below, and aborts an attempt already in flight when the deadline arrives.

**Parameters:** `options` ([`DeadlineGuardOptions`](#deadlineguardoptions), optional)

**Returns:** [`FetchLayer`](#fetchlayer)

Place it **above** retry, so it also bounds the sleeps between attempts.

### `httpErrorGuard()`

Turn a non-2xx result into a thrown `PageFetchError` (`kind: "http"`, the whole result on
`details.result`). This is what `createFetcher({ throwOnHttpError: true })` installs.

**Parameters:** `options` ([`HttpErrorGuardOptions`](#httperrorguardoptions), optional)

**Returns:** [`FetchLayer`](#fetchlayer)

```ts
import { compose, createRetry, httpErrorGuard } from "@marianmeres/page-fetcher";
import { createHttpAdapter } from "@marianmeres/page-fetcher/adapters";

const fetchFn = compose([httpErrorGuard(), createRetry()], createHttpAdapter().fetch);
```

Place it **above** retry: there, retry still sees the raw `ok: false` result and can
honor its `Retry-After` header.

### `composeSignal()`

Combine signals, dropping the empty slots.

**Parameters:** `signals` (`(AbortSignal | undefined | null)[]`)

**Returns:** `AbortSignal | undefined` — `undefined` when there is nothing to listen to,
the single signal when only one is real, `AbortSignal.any(...)` otherwise (which adopts
the first-aborted source's `reason` — that adoption is how a timeout stays
distinguishable from a deadline).

### `defaultIsRetryable()`

The built-in retry classification. `POST` is never retried; a thrown error is retried per
its own `retryable` flag; a resolved result is retried for 408, 425, 429 and 5xx.

**Parameters:** `outcome` ([`RetryOutcome`](#retryoutcome)), `attempt` (number, 1-based),
`req` ([`FetchRequest`](#fetchrequest))

**Returns:** `boolean`

Wrap it to extend rather than replace: `isRetryable: (o, a, r) => defaultIsRetryable(o, a, r) || o.result?.status === 403`.

### `defaultIsFailure()`

The built-in breaker classification — "is this host down?", not "did this request go
well?". Transport errors (`network`, `timeout`, `browser`) and 5xx count; every 4xx
(429 included) and every content-side rejection (`too-large`, `unsupported-type`) do not.

**Parameters:** `outcome` ([`RetryOutcome`](#retryoutcome))

**Returns:** `boolean`

### `defaultRetryable()`

The per-kind `retryable` default used by the `PageFetchError` constructor.

**Parameters:** `kind` ([`PageFetchErrorKind`](#pagefetcherrorkind)), `status` (number,
optional — consulted for `kind: "http"`)

**Returns:** `boolean`

### `parseRetryAfter()`

Parse a `Retry-After` header value into milliseconds from `now`. Accepts both forms
(delay-seconds and an HTTP-date) and returns `undefined` for anything unparseable.

**Parameters:** `value` (`string | null | undefined`), `now` (number, default
`Date.now()`)

**Returns:** `number | undefined`

```ts
import { parseRetryAfter } from "@marianmeres/page-fetcher";

parseRetryAfter("120"); // 120000
parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT", Date.parse("2026-10-21T07:27:00Z")); // 60000
parseRetryAfter("soon"); // undefined
```

### `resolveDeadline()`

Convert a deadline into absolute epoch milliseconds. A `number` is relative to `now`, a
`Date` is already absolute.

**Parameters:** `deadline` (`number | Date | undefined`), `now` (number, default
`Date.now()`)

**Returns:** `number | undefined`

### `sleep()`

Sleep, cancellably: resolves after `ms`, or rejects **immediately** with the signal's
reason when it aborts. The abort listener is removed on the normal path.

**Parameters:** `ms` (number), `signal` (`AbortSignal`, optional)

**Returns:** `Promise<void>`

## `PageFetchError`

Every failure this package throws. One class, discriminated by `kind` — never branch on
a message.

```ts
class PageFetchError extends Error {
	readonly name: "PageFetchError";
	readonly kind: PageFetchErrorKind;
	readonly url: string;
	readonly status?: number;
	readonly finalUrl?: string;
	readonly requestId?: string;
	readonly attempts: number;
	readonly retryable: boolean;
	readonly details?: Record<string, unknown>;
	// plus the standard `message` and `cause`

	constructor(init: PageFetchErrorInit);
	static is(e: unknown): e is PageFetchError;
}
```

`PageFetchError.is()` is realm-safe — use it instead of `instanceof`, which breaks when
the same package is present twice in one module graph (JSR + npm side by side, or a
bundler duplicating a module instance).

```ts
import { createFetcher, PageFetchError } from "@marianmeres/page-fetcher";

const fetcher = createFetcher();
try {
	await fetcher.fetch("https://example.com/");
} catch (e) {
	if (!PageFetchError.is(e)) throw e;
	if (e.kind === "circuit-open") console.warn(`fenced off until ${e.details?.until}`);
	else if (e.retryable) console.warn(`retry later: ${e.url}`);
}
```

### `PageFetchErrorKind`

| Kind                 | Meaning                                                           | `retryable` by default |
| -------------------- | ----------------------------------------------------------------- | ---------------------- |
| `network`            | DNS, ECONNRESET, TLS, or a request shape the transport can't send | `true`                 |
| `timeout`            | Per-attempt timeout elapsed                                       | `true`                 |
| `deadline`           | Total deadline exceeded                                           | `false`                |
| `aborted`            | The caller's `AbortSignal` fired                                  | `false`                |
| `http`               | Non-2xx, when `throwOnHttpError` is on                            | 408/425/429/5xx        |
| `too-large`          | Body exceeded `maxBytes`                                          | `false`                |
| `unsupported-type`   | Content type not allowed and the policy is `"error"`              | `false`                |
| `too-many-redirects` | Redirect cap hit, or a loop detected                              | `false`                |
| `browser`            | Browser launch / crash / navigation failure                       | `true`                 |
| `decode`             | Decoding failed (reserved; the HTTP path is lenient)              | `false`                |
| `circuit-open`       | Refused locally by the breaker; the host was never contacted      | `false`                |
| `no-body`            | The body is intentionally absent and was read anyway              | `false`                |

`details` carries the kind-specific extras: `{ host, state, until? }` for
`circuit-open`, `{ maxBytes, read }` for `too-large`, `{ reason }` for `no-body` (one of
the four [`BodyAbsentReason`](#bodyabsentreason) values), `{ result }` for `http`.

### `PageFetchErrorInit`

```ts
interface PageFetchErrorInit {
	kind: PageFetchErrorKind;
	url: string;
	message?: string; // default: derived from kind + url
	status?: number;
	finalUrl?: string;
	requestId?: string;
	attempts?: number; // default 0 — thrown before any attempt ran
	retryable?: boolean; // default: defaultRetryable(kind, status)
	cause?: unknown;
	details?: Record<string, unknown>;
}
```

## Types

### `FetchFn`

```ts
type FetchFn = (req: FetchRequest) => Promise<FetchResult>;
```

One fetch operation. Every layer and every adapter is one of these.

### `FetchLayer`

```ts
type FetchLayer = (next: FetchFn) => FetchFn;
```

A composable layer. There is no class hierarchy and no plugin registry.

### `FetchRequest`

```ts
interface FetchRequest {
	url: string;
	method?: HttpMethod; // default "GET"
	headers?: Record<string, string>;
	body?: ReplayableBody | BodyFactory;
	signal?: AbortSignal;
	timeout?: number; // per attempt, ms
	deadline?: number | Date; // across all attempts, incl. retry sleeps
	retainBody?: boolean; // default true
	adapter?: string; // explicit route; highest priority
	adapterOptions?: Record<string, unknown>;
	requestId?: string; // auto-generated when missing
	meta?: Record<string, unknown>; // echoed back on the result
}
```

- **`deadline`** — a `number` is milliseconds from the start of the logical request, a
  `Date` is absolute. An already-expired deadline fails immediately with
  `kind: "deadline"`, `attempts: 0`. The first layer that sees a relative deadline
  converts it, so inner layers cannot restart the clock.
- **`retainBody: false`** — link-check mode: the adapter aborts the read right after the
  headers, `size` stays `undefined`, and reading the body rejects with `kind: "no-body"`.
  It also bypasses the cache layer entirely.
- **`requestId`** — stable across attempts, present on every result, error and event.
- **`headers`** — merged over the adapter-level (and fetcher-level) defaults,
  case-insensitively.

### `FetchResult`

```ts
interface FetchResult {
	ok: boolean; // 2xx, or revalidated from cache via 304
	url: string; // as requested
	finalUrl: string; // after redirects — resolve relative refs against this
	status: number;
	statusText?: string;
	headers: Headers;
	redirects: string[]; // URLs that answered 3xx, in visit order
	requestId: string;
	hasBody: boolean;
	text(): Promise<string>; // decoded per the resolved charset, memoized
	bytes(): Promise<Uint8Array>; // the retained buffer itself
	contentType?: string; // lowercased mime, no parameters
	charset?: string; // label actually used to decode
	size?: number; // bytes read; undefined when no body was read
	fromCache: boolean;
	notModified: boolean;
	timing: FetchTiming;
	attempts: number;
	adapter: string;
	meta?: Record<string, unknown>;
	extra?: Record<string, unknown>; // adapter-specific
}
```

**Body contract, identical for every adapter:** the bytes are read eagerly, before the
adapter's `FetchFn` resolves, and bounded by `maxBytes`; only the bytes→string _decode_
is lazy and memoized. Both accessors are async purely for API stability. When
`hasBody` is `false` both reject with `PageFetchError` `kind: "no-body"` and a
`details.reason` naming which of the four causes applies.

For `A → B → C(200)`: `url` is `A`, `redirects` is `["A", "B"]`, `finalUrl` is `C`.

### `FetchTiming`

```ts
interface FetchTiming {
	startedAt: number; // epoch ms
	endedAt: number; // epoch ms, when the result was finalized
	total: number; // endedAt - startedAt, spanning every attempt and sleep
	dns?: number; // best effort — typically undefined
	connect?: number; // best effort — typically undefined
	ttfb?: number; // to the final response's headers
	download?: number; // headers received → last body byte
	render?: number; // browser adapter only
}
```

The HTTP adapter fills `startedAt`, `endedAt`, `total`, `ttfb`, `download`; the platform
`fetch` exposes no socket phases portably, so `dns` and `connect` stay `undefined`. For a
browser fetch, `ttfb` includes launch / context / page setup, so a cold first fetch says
so honestly.

### `Adapter`

```ts
interface Adapter {
	name: string; // also reported as FetchResult.adapter
	fetch: FetchFn;
	dispose?(): Promise<void>; // called once on fetcher teardown; must be idempotent
	health?(): Promise<boolean>;
}
```

### `HttpMethod`

```ts
type HttpMethod = "GET" | "HEAD" | "POST";
```

### `ReplayableBody` / `BodyFactory`

```ts
type ReplayableBody =
	| string
	| Uint8Array
	| ArrayBuffer
	| Blob
	| URLSearchParams
	| FormData;

type BodyFactory = () => ReplayableBody | ReadableStream<Uint8Array>;
```

`ReadableStream` is deliberately absent from `ReplayableBody`: it is one-shot by spec, so
a retried (or 307/308-replayed) request carrying one would silently send an empty or
partial body. The factory is the streaming escape hatch — it is invoked once per attempt
and per redirect hop, so every one gets a fresh body.

### `BodyAbsentReason`

```ts
type BodyAbsentReason = "retain-body" | "skip-body" | "head" | "not-modified";
```

Why a result carries no body, reported as `details.reason` on a `no-body` error:
`retainBody: false`, an unsupported type under `onUnsupportedType: "skip-body"`, a HEAD
request, or a 304 the cache layer could not resolve into a stored body.

### `UnsupportedTypePolicy`

```ts
type UnsupportedTypePolicy = "error" | "skip-body";
```

Default `"error"` — loud beats silent for a transport primitive. `"skip-body"` returns
headers only, which is what link checking wants.

### `RetryOutcome`

```ts
interface RetryOutcome {
	error?: PageFetchError; // set when the attempt threw
	result?: FetchResult; // set when the attempt resolved
}
```

Exactly one of the two is set. It is an either/or pair rather than a mandatory error
because a non-2xx resolves as data, so the dominant retry trigger is a _result_.

### `RetryInfo`

```ts
type RetryInfo = {
	requestId?: string;
	url: string;
	attempt: number; // the 1-based attempt that just failed
	delay: number; // ms that will be slept before the next attempt
} & RetryOutcome;
```

### `FetcherEvents`

```ts
interface FetcherEvents {
	onRequest?(req: FetchRequest, info: { requestId: string; attempt: number }): void;
	onResponse?(res: FetchResult): void;
	onRetry?(info: RetryInfo): void;
	onError?(err: PageFetchError, req: FetchRequest): void;
	onCircuitOpen?(info: { host: string; until: number; requestId?: string }): void;
}
```

Granularity is a contract. For one logical request with N attempts:

| Event           | Emitted by    | How often                           |
| --------------- | ------------- | ----------------------------------- |
| `onRequest`     | retry layer   | N — once before every attempt's I/O |
| `onRetry`       | retry layer   | N−1 — once per scheduled retry      |
| `onResponse`    | events layer  | exactly 1, with the final result    |
| `onError`       | events layer  | exactly 1, on final failure         |
| `onCircuitOpen` | breaker layer | only on transitions **into** `open` |

Handlers are synchronous fire-and-forget: returned promises are ignored and a throwing
handler never affects the fetch (it is reported via `logger.warn`). Refusals by an open
circuit emit nothing — an open circuit under load would otherwise be an event storm, and
the caller already has the rejection in hand.

### `ObservabilityOptions`

```ts
interface ObservabilityOptions {
	logger?: Logger; // default: silent
	events?: FetcherEvents; // default: none
}
```

Accepted by every layer factory, every adapter and `createFetcher`. The two channels are
complementary: `events` is the machine channel with defined granularity, `logger` the
human one. Errors are thrown (and reported via `onError`); inner layers never also log
them at `error` level, so nothing double-reports.

### `Logger`

Re-exported from `@marianmeres/clog` — a console-compatible interface
(`debug` / `log` / `warn` / `error`). The import is type-only, so no clog code is pulled
in at runtime and `console` satisfies it structurally.

### `CreateFetcherOptions`

```ts
interface CreateFetcherOptions extends ObservabilityOptions {
	adapters?: Adapter | Adapter[]; // default: one createHttpAdapter()
	selectAdapter?(req: FetchRequest): string | undefined;
	retry?: RetryOptions | false; // default: on
	circuitBreaker?: CircuitBreakerOptions | boolean; // default: OFF
	cache?: CacheStore | CacheLayerOptions; // default: off
	timeout?: number; // default per-attempt timeout
	deadline?: number | Date; // default overall deadline
	headers?: Record<string, string>;
	userAgent?: string;
	throwOnHttpError?: boolean; // default false
}
```

- **`adapters`** — the **first** one is the default route; the rest are reachable by
  name (`req.adapter`, or `selectAdapter`). An unknown name throws a `TypeError`: a
  config error is not a fetch outcome, so neither retry nor the breaker touches it.
- **`retry: false`** means `attempts: 1`, not "no layer" — retry owns the per-attempt
  `onRequest` event, and dropping the layer would silently drop those.
- **`circuitBreaker`** is off by default: it is the one layer that refuses requests you
  asked for. `true` enables it with the defaults.
- **`cache`** — a bare [`CacheStore`](#cachestore) is shorthand for `{ store }`, i.e.
  `"conditional"` mode.
- **`headers` / `userAgent`** — merged case-insensitively _under_ the per-request ones,
  and applied to every adapter (unlike an adapter's own `userAgent` option).

### `Fetcher`

```ts
interface Fetcher {
	fetch(url: string, init?: Omit<FetchRequest, "url">): Promise<FetchResult>;
	fetch(req: FetchRequest): Promise<FetchResult>;
	dispose(): Promise<void>;
	[Symbol.asyncDispose](): Promise<void>;
}
```

`dispose()` disposes every adapter. It is idempotent (the promise is memoized, so a
second caller awaits real completion) and never throws — an adapter that fails to
dispose is logged and skipped, because disposal usually runs in a `finally` and must not
mask the error that got you there. A `fetch()` after disposal rejects with a plain
`Error`.

### `RetryOptions`

```ts
interface RetryOptions extends ObservabilityOptions {
	attempts?: number; // default 3, including the first
	backoff?: BackoffStrategy; // default "exponential"
	baseDelay?: number; // default 500
	maxDelay?: number; // default 30_000; caps Retry-After too
	jitter?: boolean; // default true (full jitter)
	respectRetryAfter?: boolean; // default true
	isRetryable?(outcome: RetryOutcome, attempt: number, req: FetchRequest): boolean;
	onRetry?(info: RetryInfo): void;
}
```

`isRetryable` replaces the built-in classification entirely — wrap
[`defaultIsRetryable`](#defaultisretryable) to extend it. `jitter` is
ignored for a function backoff (a caller who writes their own delay wants full control).
A server-directed `Retry-After` is used verbatim (no jitter), capped by `maxDelay`.

### `BackoffStrategy`

```ts
type BackoffStrategy =
	| "exponential" // baseDelay * 2 ** (attempt - 1)
	| "linear" // baseDelay * attempt
	| "fixed" // baseDelay
	| ((attempt: number) => number); // 1-based attempt that just failed
```

### `CircuitBreakerOptions`

```ts
interface CircuitBreakerOptions extends ObservabilityOptions {
	threshold?: number; // consecutive failures per host; default 5
	cooldown?: number; // ms open before a probe; default 30_000
	isFailure?(outcome: RetryOutcome): boolean;
	onStateChange?(info: CircuitStateChange): void;
}
```

### `CircuitState` / `CircuitStateChange`

```ts
type CircuitState = "closed" | "open" | "half-open";

interface CircuitStateChange {
	host: string; // including port
	state: CircuitState;
	until?: number; // epoch ms; set only for "open"
	failures: number;
	requestId?: string;
}
```

A refusal names the state in `details`: `{ host, state: "open", until }` while the
cooldown runs, `{ host, state: "half-open" }` for requests arriving while the single
probe is in flight.

### `TimeoutGuardOptions`

```ts
interface TimeoutGuardOptions {
	defaultTimeout?: number; // used when the request carries no `timeout`
	logger?: Logger;
}
```

### `DeadlineGuardOptions`

```ts
interface DeadlineGuardOptions {
	defaultDeadline?: number | Date;
	logger?: Logger;
}
```

### `HttpErrorGuardOptions`

```ts
interface HttpErrorGuardOptions {
	logger?: Logger;
}
```

## Constants

| Constant                    | Value    | Meaning                                     |
| --------------------------- | -------- | ------------------------------------------- |
| `DEFAULT_CIRCUIT_THRESHOLD` | `5`      | Consecutive failures before a circuit opens |
| `DEFAULT_CIRCUIT_COOLDOWN`  | `30_000` | How long it stays open, in ms               |

---

# Adapters

`import { … } from "@marianmeres/page-fetcher/adapters";`

## HTTP adapter

### `createHttpAdapter()`

A thin, observable wrapper over the platform `fetch`. Redirects are followed manually
(`redirect: "manual"`) so the chain is recordable and cappable, the body is streamed with
a hard byte budget instead of being buffered blindly, and the charset is decided from
bytes + headers rather than assumed.

**Parameters:** `options` ([`HttpAdapterOptions`](#httpadapteroptions), optional)

**Returns:** [`Adapter`](#adapter)

```ts
import { createHttpAdapter } from "@marianmeres/page-fetcher/adapters";

const http = createHttpAdapter({ maxBytes: 2_000_000 });
const res = await http.fetch({ url: "https://example.com/" });
console.log(res.status, res.finalUrl, (await res.text()).length);
```

A non-2xx response is **not** an error here — it resolves with `ok: false`. Throwing is a
composition-layer opt-in ([`httpErrorGuard`](#httperrorguard)).

**Redirect handling.** The chain is capped by `maxRedirects` and loop-checked on
`method + URL`; both violations throw `kind: "too-many-redirects"`. Method rewriting
mirrors the WHATWG algorithm (303 → GET, 301/302 rewrite POST → GET, 307/308 replay), and
`Authorization` **and** `Cookie` are dropped on a cross-origin hop — compared against the
_original_ origin, and once dropped they stay dropped. A `Location` that fails
`new URL()` is treated as the final response rather than an error, because a crawler is
better served by the data it has.

**Errors.** The adapter never leaks a raw platform error: an abort (from the fetch _or_
from the body reader) becomes `kind: "aborted"` — or the guard's own error when that is
the abort reason — and everything else becomes `kind: "network"`, since Deno and undici
report transport failures as plain `TypeError`s. Adapter-thrown errors are stamped
`attempts: 1`.

**A 304 from the bare adapter** reports `hasBody: false`, `details.reason:
"not-modified"`, `ok: false`, `notModified: false`. Only the cache layer may resolve a
304 into a body and flip those flags. A bodyless 200/204 still reports `hasBody: true`
with `size: 0`.

### `HttpAdapterOptions`

```ts
interface HttpAdapterOptions extends ObservabilityOptions {
	name?: string; // default "http"
	fetch?: typeof globalThis.fetch; // injectable, so unit tests need no sockets
	headers?: Record<string, string>; // request headers win over these
	userAgent?: string | false; // false leaves the platform's own UA alone
	maxRedirects?: number; // default 5
	maxBytes?: number; // default 10 MiB of DECODED bytes
	allowContentTypes?: string[] | null; // null disables the check
	onUnsupportedType?: UnsupportedTypePolicy; // default "error"
	retainBody?: boolean; // default for FetchRequest.retainBody
	charsetFallback?: string; // default "utf-8"
	sniffMeta?: boolean; // scan the first ~2 KB for <meta charset>; default true
}
```

`maxBytes` counts **decoded** bytes, not wire bytes: the platform decompresses
transparently, so a gzipped response yields more bytes than `Content-Length` advertises.
Exceeding it aborts the read and throws `kind: "too-large"`.

### HTTP constants

| Constant                | Value                                                                       |
| ----------------------- | --------------------------------------------------------------------------- |
| `DEFAULT_USER_AGENT`    | `"marianmeres-page-fetcher (+https://github.com/marianmeres/page-fetcher)"` |
| `DEFAULT_MAX_BYTES`     | `10 * 1024 * 1024`                                                          |
| `DEFAULT_MAX_REDIRECTS` | `5`                                                                         |

## Browser adapter

### `createBrowserAdapter()`

Navigate a real page and hand back the serialized DOM as a [`FetchResult`](#fetchresult).
Same contract as the HTTP adapter, with three inherent differences:

1. **`bytes()` is the serialized DOM, not the wire bytes** — the document has been
   parsed, scripted and re-serialized by the time we see it, so `charset` is always
   `"utf-8"`, whatever the server sent.
2. **Redirects are already followed** when the navigation resolves, so `maxRedirects` is
   enforced after the fact rather than aborting mid-chain.
3. **`finalUrl` is the end of the HTTP redirect chain** — the server's truth, which is
   what relative references resolve against. Client-side routing that moved the page
   during the wait phase shows up as `extra.pageUrl`.

**Parameters:** `options` ([`BrowserAdapterOptions`](#browseradapteroptions)) — `driver`
is required.

**Returns:** [`Adapter`](#adapter)

**Throws:** `TypeError` when no usable `driver` was injected.

```ts
import * as playwright from "playwright";
import { createFetcher } from "@marianmeres/page-fetcher";
import {
	createBrowserAdapter,
	playwrightDriver,
} from "@marianmeres/page-fetcher/adapters";

await using fetcher = createFetcher({
	adapters: createBrowserAdapter({ driver: playwrightDriver(playwright) }),
});
const res = await fetcher.fetch("https://example.com/");
console.log(res.extra?.title);
```

Non-GET is refused with `kind: "network"`, `retryable: false` ("route non-GET to the
http adapter") — a navigation is a GET. Cancellation closes the page (which is how a
navigation is cancelled, since neither driver's `goto` takes a signal) _and_ stops
waiting for it; the abandoned navigation's page-close and lease-release are deferred
until it settles, and the lease goes back marked `broken`.

### `BrowserAdapterOptions`

```ts
interface BrowserAdapterOptions extends ObservabilityOptions, BlockingOptions {
	driver: BrowserDriver; // required — this package never imports a browser
	name?: string; // default "browser"
	contextOptions?: DriverContextOptions;
	userAgent?: string; // unset by default, on purpose
	headers?: Record<string, string>;
	wait?: WaitStrategy; // default "networkidle"
	networkidle?: NetworkIdleOptions;
	navigationTimeout?: number; // default 30_000; a request's own timeout wins
	maxRedirects?: number; // default 5, enforced post-hoc
	maxBytes?: number; // default 10 MiB of SERIALIZED DOM
	retainBody?: boolean;
	onPage?: OnPageHook;
	captureConsoleErrors?: boolean; // default true
	captureFailedRequests?: boolean; // default true
	captureLimit?: number; // per captured list; default 50
	contextStrategy?: ContextStrategy; // default "pooled"
	poolSize?: number; // default 3
	maxPagesPerContext?: number; // default 50
	acquireTimeout?: number; // default 30_000
	exitHooks?: boolean; // default true
	contexts?: ContextProvider; // inject your own lifecycle
}
```

**No `User-Agent` by default** — deliberately the opposite of the HTTP adapter.
Replacing a real browser's UA with a bot string is exactly what gets a headless browser
served different HTML or blocked outright, which defeats the reason to run one.

A request that changes context-affecting options (per-request `headers`, a per-request
`user-agent`, `adapterOptions.contextOptions`) gets its own **dedicated** one-off
context, created and closed with that request and accounted outside the pool's size. The
alternative — applying them per page — works on Puppeteer and is a silent no-op on
Playwright, whose contexts take options only at creation.

The adapter warns (via `logger`) at wiring time when a `contextOptions` entry exceeds
what the driver's [`capabilities`](#browserdriver) can honor, instead of dropping it
silently.

### Per-request `adapterOptions`

```ts
{
	wait?: WaitStrategy; // overrides the adapter's
	networkidle?: NetworkIdleOptions;
	contextOptions?: DriverContextOptions; // merged over the adapter's; forces a dedicated context
	onPage?: OnPageHook; // replaces the adapter's for this request
	blockResources?: false | readonly ResourceKind[]; // REPLACES, does not merge
	blockUrls?: readonly UrlPredicate[];
	allowUrls?: readonly UrlPredicate[];
}
```

### `FetchResult.extra` (browser)

| Key                   | Type                 | When                                        |
| --------------------- | -------------------- | ------------------------------------------- |
| `title`               | `string`             | always                                      |
| `consoleErrors`       | `string[]`           | when any were captured (capped)             |
| `failedRequests`      | `{ url, failure }[]` | when any were captured (capped)             |
| `networkidleTimedOut` | `true`               | the idle window never arrived, `strict` off |
| `pageUrl`             | `string`             | client-side routing moved the page          |
| `onPageError`         | `string`             | the `onPage` hook threw                     |

Whatever `onPage` returns is merged in **last**, so it can override these.

### `OnPageHook`

```ts
type OnPageHook = (
	page: unknown, // the driver's own page object (DriverPage.raw) — cast it
	req: FetchRequest,
) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
```

Runs after the wait strategy resolved and before `content()`, so it may scroll, dismiss a
cookie banner, click "load more", take a screenshot. A throwing hook never fails the
fetch — it lands in `extra.onPageError`.

### Browser constants

| Constant                        | Value              |
| ------------------------------- | ------------------ |
| `DEFAULT_MAX_DOM_BYTES`         | `10 * 1024 * 1024` |
| `DEFAULT_BROWSER_MAX_REDIRECTS` | `5`                |
| `DEFAULT_CAPTURE_LIMIT`         | `50`               |

## Browser drivers

### `playwrightDriver()`

Bridge Playwright to [`BrowserDriver`](#browserdriver).

**Parameters:**

- `source` (`PlaywrightSource`) — the `playwright` module, a namespace import carrying it
  as `.default`, or a single browser type such as `playwright.chromium`
- `options` (`PlaywrightDriverOptions`, optional)
  - `browser` (`"chromium" | "firefox" | "webkit"`) — default `"chromium"`
  - `launchOptions` (`Record<string, unknown>`) — passed to `browserType.launch()`
    verbatim (`headless`, `executablePath`, `args`, `proxy`, …)
  - `name` (`string`) — default `"playwright"`

**Returns:** [`BrowserDriver`](#browserdriver)

**Throws:** `TypeError` naming what was expected, at wiring time, when the argument is
not a usable Playwright module.

### `puppeteerDriver()`

Bridge Puppeteer to [`BrowserDriver`](#browserdriver). Falls back from
`createBrowserContext` to `createIncognitoBrowserContext` (renamed in Puppeteer 22).

**Parameters:**

- `source` (`PuppeteerSource`) — Puppeteer's default export, or a namespace import
  carrying it as `.default`
- `options` (`PuppeteerDriverOptions`, optional) — `launchOptions`, `name` (default
  `"puppeteer"`)

**Returns:** [`BrowserDriver`](#browserdriver)

Both source types declare every member as `unknown` and validate the shape at call time:
a structurally precise stand-in for either package's declarations would be a compile-time
dependency in all but name, and would reject perfectly good module shapes over an
irrelevant signature detail.

### `BrowserDriver`

The structural interface the adapter and the pool are written against — nothing here
imports a Playwright or Puppeteer type, which is what makes the whole browser subsystem
testable with no browser and no network.

```ts
interface BrowserDriver {
	readonly name: string;
	launch(): Promise<DriverBrowser>;
	readonly capabilities: {
		locale: boolean; // true locale emulation (Puppeteer only approximates it)
		timezone: boolean;
		contextOptions: boolean; // honored at context creation rather than per page
	};
}

interface DriverBrowser {
	newContext(opts: DriverContextOptions): Promise<DriverContext>;
	onDisconnected(cb: () => void): void; // the pool's crash signal
	close(): Promise<void>; // idempotent-safe after a crash
	readonly pid?: number; // when the driver exposes one (Puppeteer does)
	raw: unknown;
}

interface DriverContext {
	newPage(): Promise<DriverPage>;
	close(): Promise<void>;
	raw: unknown;
}

interface DriverPage {
	goto(
		url: string,
		opts: { waitUntil: "load" | "domcontentloaded"; timeout: number },
	): Promise<DriverNavResult>;
	waitForNetworkIdle(opts: { idleMs: number; timeout: number }): Promise<void>;
	waitForSelector(selector: string, opts: { timeout: number }): Promise<void>;
	waitForFunction(fn: string, opts: { timeout: number }): Promise<void>;
	content(): Promise<string>; // serialized DOM, after scripts have run
	title(): Promise<string>;
	url(): string; // where the page actually is now
	setRequestFilter(filter: RequestFilter): Promise<void>; // before goto, once per page
	onConsoleError(cb: (text: string) => void): void;
	onRequestFailed(cb: (info: { url: string; failure: string }) => void): void;
	onCrash(cb: (err: Error) => void): void;
	applyPageOptions(opts: DriverContextOptions): Promise<void>;
	close(): Promise<void>; // also how an in-flight navigation is cancelled
	raw: unknown; // handed to the onPage hook
}

interface DriverNavResult {
	status: number;
	statusText?: string;
	headers: Record<string, string>; // keys lowercased
	redirects: string[]; // oldest first, excluding finalUrl
	finalUrl: string; // end of the HTTP chain, not necessarily where the page ended up
}

interface DriverContextOptions {
	userAgent?: string;
	viewport?: { width: number; height: number } | null;
	locale?: string; // BCP-47
	timezoneId?: string; // IANA
	javaScriptEnabled?: boolean; // false is the cheap way to fetch server-rendered HTML
	extraHTTPHeaders?: Record<string, string>;
}
```

`waitForFunction` takes an **expression**, not a function source — both drivers evaluate
a string argument as an expression, so `"() => done"` would evaluate to a truthy function
object and resolve immediately. The adapter normalizes a function source into a call
before it gets here (see [`toPageExpression`](#topageexpression)).

### `normalizeHeaders()`

Lowercase every header key. Exported because "header keys are lowercased" is half of
`DriverNavResult`'s contract, and a custom driver author has to satisfy it.

**Parameters:** `headers` (`Record<string, string> | undefined | null`)

**Returns:** `Record<string, string>`

## Context pool

N browsing contexts over **one** browser process, with recycling and crash recovery.
Launching a browser costs 1–3 seconds; creating a context costs milliseconds and still
gives full isolation (its own cookie jar, cache and storage).

The invariant the module is built around, and the one its tests pin: **no waiter promise
stays pending** — not after its timeout, not after its signal, not after `dispose()`, and
not after a failed relaunch.

### `createContextPool()`

**Parameters:** `options` (`PoolOptions`)

```ts
interface PoolOptions {
	driver: BrowserDriver;
	size?: number; // default 3
	maxPagesPerContext?: number; // default 50; Infinity never recycles
	acquireTimeout?: number; // default 30_000
	contextOptions?: DriverContextOptions;
	exitHooks?: boolean; // default true
	logger?: Logger;
}
```

**Returns:** `ContextPool`

**Throws:** `TypeError` when `size < 1`.

```ts
import { createContextPool } from "@marianmeres/page-fetcher/adapters";
import type { BrowserDriver } from "@marianmeres/page-fetcher/adapters";

declare const driver: BrowserDriver;

const pool = createContextPool({ driver, size: 4 });
const lease = await pool.acquire();
try {
	const page = await lease.context.newPage();
	// …
} finally {
	lease.release();
}
await pool.dispose();
```

A dead browser bumps an **epoch**: everything from the old generation becomes inert, so a
context belonging to a dead process can never re-enter the live pool. Waiters are not
rejected by the crash itself — they are woken to re-try, which relaunches the browser;
only if that relaunch fails do they fail, with a retryable error. A failed launch is
never memoized, so the next request tries again.

The pool throws plain errors and the adapter classifies them: an acquire timeout →
`kind: "timeout"`, dispose and aborts (`DOMException(AbortError)`) → `kind: "aborted"`, a
launch failure → `kind: "browser"`.

### `ContextProvider` / `ContextPool` / `ContextLease` / `PoolLease`

```ts
interface ContextProvider {
	acquire(
		signal?: AbortSignal,
		contextOptions?: DriverContextOptions, // asks for a DEDICATED context
	): Promise<ContextLease>;
	dispose(): Promise<void>; // idempotent
}

interface ContextPool extends ContextProvider {
	acquire(
		signal?: AbortSignal,
		contextOptions?: DriverContextOptions,
	): Promise<PoolLease>;
	readonly stats: PoolStats;
}

interface ContextLease {
	context: DriverContext;
	release(opts?: { broken?: boolean }): void; // broken: do not hand it to anyone else
}

interface PoolLease extends ContextLease {
	epoch: number; // a lease from a dead generation releases into nothing
}

interface PoolStats {
	size: number; // contexts that exist right now (idle + busy)
	idle: number;
	busy: number;
	waiting: number; // callers queued
	epoch: number; // increments on every browser crash
	launches: number; // including relaunches
	dedicated: number; // one-off contexts currently out
}
```

`ContextProvider` is the seam: inject your own into `createBrowserAdapter({ contexts })`
to take the lifecycle over entirely.

### `ContextStrategy` / `poolShapeFor()`

```ts
type ContextStrategy = "pooled" | "shared" | "per-request";
```

| Strategy        | Shape                                           | Use when                                         |
| --------------- | ----------------------------------------------- | ------------------------------------------------ |
| `"pooled"`      | `size` contexts, recycled every `maxPages…`     | The default; the right answer for a crawler      |
| `"shared"`      | `size: 1`, `maxPagesPerContext: Infinity`       | Cheapest; the only mode where cookies carry over |
| `"per-request"` | `maxPagesPerContext: 1`, still capped at `size` | Maximum isolation                                |

`poolShapeFor` turns a strategy into those two numbers — one pool implementation covers
all three.

**Parameters:** `strategy` (`ContextStrategy`), `opts` (`{ size?, maxPagesPerContext? }`,
optional)

**Returns:** `{ size: number; maxPagesPerContext: number }`

### Pool constants

| Constant                        | Value    |
| ------------------------------- | -------- |
| `DEFAULT_POOL_SIZE`             | `3`      |
| `DEFAULT_MAX_PAGES_PER_CONTEXT` | `50`     |
| `DEFAULT_ACQUIRE_TIMEOUT`       | `30_000` |

## Resource blocking

On by default: a page fetcher wants the DOM, not the pixels. See the loud note in the
[README](README.md#fetching-with-a-real-browser).

### `compileRequestFilter()`

Compile [`BlockingOptions`](#blockingoptions) into the filter installed on a page.

**Parameters:** `options` ([`BlockingOptions`](#blockingoptions), optional)

**Returns:** `RequestFilter`

```ts
import { compileRequestFilter } from "@marianmeres/page-fetcher/adapters";

const filter = compileRequestFilter({
	blockUrls: [/googletagmanager|doubleclick/, (u) => u.endsWith(".pdf")],
});
filter({ url: "https://x.test/a.png", resourceType: "image" }); // "abort"
```

Evaluation order, first verdict wins:

1. `document` requests always continue — blocking the navigation itself would fail the
   fetch rather than speed it up.
2. `blockResources` — the kind check.
3. `allowUrls` — an allow-list, so anything unmatched is blocked.
4. `blockUrls` — the exceptions to whatever survived.

### `BlockingOptions`

```ts
interface BlockingOptions {
	blockResources?: false | readonly ResourceKind[]; // false disables blocking
	blockUrls?: readonly UrlPredicate[];
	allowUrls?: readonly UrlPredicate[]; // when set, block everything matching NONE
}
```

### `ResourceKind`

```ts
type ResourceKind =
	| "document" // the navigation itself — never blocked
	| "stylesheet"
	| "image"
	| "media"
	| "font"
	| "script"
	| "texttrack"
	| "xhr"
	| "fetch"
	| "eventsource"
	| "websocket"
	| "manifest"
	| "other"; // anything a driver reports outside this list
```

`DEFAULT_BLOCKED_RESOURCES` is `["image", "media", "font", "stylesheet"]`.

### `UrlPredicate` / `RequestFilter`

```ts
type UrlPredicate = RegExp | ((url: string) => boolean);

type RequestFilter = (
	req: { url: string; resourceType: string },
) => "abort" | "continue";
```

No glob syntax — that would need a matcher dependency, and this package has none. A `/g`
or `/y` regex carries state between calls, so `lastIndex` is reset before every test.

## Waiting

### `WaitStrategy`

```ts
type WaitStrategy =
	| "load"
	| "domcontentloaded"
	| "networkidle" // the default: load, then a bounded wait for quiet
	| { selector: string; timeout?: number }
	| { fn: string; timeout?: number };
```

The default is a **soft hybrid**: navigate with `waitUntil: "load"`, wait for a bounded
window of network quiet, and if that window never arrives, proceed anyway and say so
(`extra.networkidleTimedOut`). Plain `"load"` returns the pre-hydration DOM on any
client-rendered site, and a hard-failing networkidle makes the adapter unusable on the
analytics/websocket-carrying pages it exists for.

The explicit conditions fail hard on timeout instead: the caller named a condition, so its
absence means the page is not what they asked for. `{ fn }` accepts both an expression
(`"document.title === 'ready'"`) and a function source (`"() => document.title === 'ready'"`).

### `NetworkIdleOptions`

```ts
interface NetworkIdleOptions {
	idleMs?: number; // default 500; ignored by Playwright, whose window is fixed
	timeout?: number; // cap on the idle wait, SEPARATE from navigation; default 10_000
	strict?: boolean; // default false: proceed and report instead of failing
}
```

### `applyWait()`

Navigate and wait, the strategy deciding how patient to be. This is what the adapter
calls; it is exported for custom drivers and custom adapters.

**Parameters:** `page` (`DriverPage`), `url` (string), `strategy`
([`WaitStrategy`](#waitstrategy)), `options` (`ApplyWaitOptions`)

```ts
interface ApplyWaitOptions {
	navigationTimeout: number;
	networkidle: Required<NetworkIdleOptions>;
	requestId?: string;
	signal?: AbortSignal;
	logger?: Logger;
}
```

**Returns:** `Promise<WaitOutcome>`

```ts
interface WaitOutcome {
	nav: DriverNavResult;
	navigatedAt: number; // epoch ms the navigation resolved — the browser ttfb anchor
	render: number; // ms spent waiting AFTER the navigation resolved
	networkidleTimedOut?: boolean;
}
```

### `normalizeWait()`

Validate a wait strategy at configuration time.

**Parameters:** `strategy` (`unknown`)

**Returns:** [`WaitStrategy`](#waitstrategy)

**Throws:** `TypeError` naming the accepted forms.

### `toPageExpression()`

Wrap a function-looking source in a call, pass anything else through unchanged.

**Parameters:** `fn` (string)

**Returns:** `string`

```ts
import { toPageExpression } from "@marianmeres/page-fetcher/adapters";

toPageExpression("() => window.__ready"); // "(() => window.__ready)()"
toPageExpression("window.__ready"); // "window.__ready"
```

Both drivers evaluate a string `waitForFunction` argument as an **expression**, so a bare
function source evaluates to a truthy function object and the wait resolves immediately
against an un-waited-for page. Custom drivers receive the already-normalized expression.

### `browserErrorFrom()`

Map anything a driver threw onto a [`PageFetchError`](#pagefetcherror).

**Parameters:** `cause` (`unknown`), `ctx` (`BrowserErrorContext`)

```ts
interface BrowserErrorContext {
	url: string;
	requestId?: string;
	signal?: AbortSignal; // an aborted one outranks every other reading
	phase?: string; // e.g. "navigating to https://x/"
	status?: number;
}
```

**Returns:** [`PageFetchError`](#pagefetcherror)

Cancellation is checked **first** and beats every other reading, because cancelling a
browser fetch _is_ closing the page — an abort surfaces as whatever unrelated-looking
failure the in-flight operation happened to produce, and only the signal knows the truth.
A guard's own error rides on the abort reason and is returned unchanged. Everything else
is classified by message (`net::ERR_` / `NS_ERROR_` → `network`, `timeout` → `timeout`,
the rest → `browser`), because neither driver exposes machine-readable navigation error
codes.

### Wait constants

| Constant                     | Value                                             |
| ---------------------------- | ------------------------------------------------- |
| `DEFAULT_WAIT`               | `"networkidle"`                                   |
| `DEFAULT_NETWORK_IDLE`       | `{ idleMs: 500, timeout: 10_000, strict: false }` |
| `DEFAULT_NAVIGATION_TIMEOUT` | `30_000`                                          |

## Content type, charset and body helpers

### `parseContentType()`

**Parameters:** `header` (`string | null | undefined`)

**Returns:** `ParsedContentType` — `{ mime?: string; charset?: string }`, both lowercased,
the charset unquoted

```ts
import { parseContentType } from "@marianmeres/page-fetcher/adapters";

parseContentType("TEXT/HTML; Charset=WINDOWS-1250; foo=bar");
// { mime: "text/html", charset: "windows-1250" }
```

### `isAllowedContentType()`

**Parameters:** `mime` (string), `allow` (string[]) — exact mimes and `"+suffix"` entries

**Returns:** `boolean`

`DEFAULT_ALLOW_CONTENT_TYPES` is `["text/html", "application/xhtml+xml", "text/plain",
"application/xml", "text/xml", "application/json", "+json", "+xml"]`. Both
`application/json` and `+json` are listed on purpose: read literally as a suffix rule,
`+json` does not match plain `application/json`.

### `isMetaSniffable()`

Whether `<meta charset>` scanning applies to this mime (the HTML/XML family).

**Parameters:** `mime` (`string | undefined`) · **Returns:** `boolean`

### `sniffCharset()`

Decide the charset, in order: **BOM → HTTP header → `<meta>` → fallback**. A BOM is
ground truth written by the encoder; `charset=` parameters are routinely stale server
config. Unknown labels are warned about and skipped, never thrown.

**Parameters:** `bytes` (Uint8Array), `opts` (`SniffCharsetOptions`, optional)

```ts
interface SniffCharsetOptions {
	headerCharset?: string;
	mime?: string; // meta sniffing only runs for HTML/XML family documents
	sniffMeta?: boolean; // default true
	fallback?: string; // default "utf-8"
	logger?: Logger;
}
```

**Returns:** `string` — the resolved label

### `detectBom()` / `sniffMetaCharset()` / `isSupportedEncoding()`

- `detectBom(bytes)` → `string | undefined` — the label a UTF-8/16 BOM implies
- `sniffMetaCharset(bytes)` → `string | undefined` — scans the first ~2 KB for
  `<meta charset>` / `<meta http-equiv>`
- `isSupportedEncoding(label)` → `boolean` — whether `TextDecoder` knows the label

### `decodeText()`

Decode with the given label, falling back to utf-8 on an unknown one rather than
throwing.

**Returns:** `{ text: string; charset: string }` — `charset` is the label actually used.

### `readBodyLimited()`

Read a response body into memory, aborting as soon as `maxBytes` is exceeded. A helper,
not a layer: enforcing a byte budget needs the body _stream_, which only exists inside an
adapter.

**Parameters:** `body` (`ReadableStream<Uint8Array> | null`), `opts` (`ReadBodyOptions`)

```ts
interface ReadBodyOptions {
	maxBytes: number; // DECODED bytes
	url: string;
	requestId?: string;
	signal?: AbortSignal; // observed between chunks
	logger?: Logger;
}
```

**Returns:** `Promise<Uint8Array>` — empty when `body` is `null` (HEAD / 204 / 304)

**Throws:** `PageFetchError` `kind: "too-large"`, or `kind: "aborted"` (or the signal's
own reason) when the read was cancelled.

## Exit hooks

Orphaned browser processes are the classic failure of tools like this, so the pool
registers a process-exit hook by default (`exitHooks: false` opts out).

### `registerExitHook()`

Run `fn` when the process is going away. **Returns** the unregister function.

**Parameters:**

- `fn` (`() => void`) — must be **synchronous**: `exit` and `unload` cannot await
  anything. It runs at most once, however many hooked events fire.
- `host` (`ExitHookHost | undefined`) — default `detectExitHookHost()`

On a signal the protocol is: run `fn`, unregister, then **re-raise** the signal. The
re-raise is mandatory, not optional — installing a SIGINT listener suppresses default
termination on both runtimes, so skipping it would break Ctrl-C. It prefers the real
signal (which preserves other handlers) and falls back to exiting with the conventional
`128 + n`, because `Deno.kill` needs `--allow-run` and a transport library has no
business demanding that permission.

### `detectExitHookHost()`

Probe the runtime — Deno (signal listeners + `unload`) or Node (`process`). **Returns**
`ExitHookHost | undefined` (`undefined` where no hook can be installed).

```ts
type ExitEvent = "SIGINT" | "SIGTERM" | "exit" | "unload";

interface ExitHookHost {
	readonly name: string; // "deno", "node", or whatever a test calls itself
	readonly events: readonly ExitEvent[];
	on(event: ExitEvent, handler: () => void): void;
	off(event: ExitEvent, handler: () => void): void;
	reraise(signal: "SIGINT" | "SIGTERM", code: number): void;
}
```

The host is injectable so the register → run → unregister → re-raise protocol can be
unit-tested without ever sending a real signal.

### `killProcess()`

SIGKILL a pid, best effort. **Returns** `boolean` (did we manage to send it).

Only a pid makes a _synchronous_ kill possible at exit time — an async `close()` started
from an `exit` handler may never get a turn. Only Puppeteer exposes the browser's child
process (`DriverBrowser.pid`).

---

# Cache

`import { … } from "@marianmeres/page-fetcher/cache";`

**This is not an RFC 9111 HTTP cache**, and pretending otherwise would be the worst thing
it could do. It parses no `Cache-Control` freshness directives, computes no heuristic
freshness, honors no `Vary`, and does no `stale-while-revalidate` or `stale-if-error`.
`ttl` is _your_ policy, not the origin's. The only header-derived behaviors are the
validators (`ETag` / `Last-Modified`) and one `no-store` courtesy check.

### `createCacheLayer()`

**Parameters:** `options` ([`CacheLayerOptions`](#cachelayeroptions))

**Returns:** [`FetchLayer`](#fetchlayer)

**Throws:** `TypeError` when `store` is missing.

```ts
import { createCacheLayer, createMemoryCache } from "@marianmeres/page-fetcher/cache";
import { createHttpAdapter } from "@marianmeres/page-fetcher/adapters";

const fetchFn = createCacheLayer({
	store: createMemoryCache(),
	mode: "dev", // serve any hit, ignoring freshness...
	ttl: 3_600_000, // ...as long as it is younger than an hour
})(createHttpAdapter().fetch);
```

Compose it **outermost** (which is where `createFetcher({ cache })` puts it): a hit must
cost nothing and depend on nothing — not an open circuit, not the deadline, not the retry
budget. Anything it _does_ forward goes down the ordinary stack, so a revalidation is
retried, timed out and counted exactly like any other request.

What each scenario reports:

| Scenario                                    | `fromCache` | `notModified` | `attempts`     | `timing`       | `adapter`      |
| ------------------------------------------- | ----------- | ------------- | -------------- | -------------- | -------------- |
| Live network fetch                          | `false`     | `false`       | real, ≥1       | real           | resolved       |
| Pure hit (dev, or conditional within `ttl`) | `true`      | `false`       | **0**          | store lookup   | entry's        |
| 304 revalidation                            | `true`      | `true`        | revalidation's | revalidation's | revalidation's |
| Fresh 200 stored this request               | `false`     | `false`       | real           | real           | resolved       |

`attempts: 0` on a pure hit is the honest number — zero network attempts were made. A
304's `attempts` and `timing` are real, because a conditional request genuinely hit the
network; only the content comes from the (freshened) entry, and the status returned is the
**stored** one, never 304. `ok` is computed from that stored status, so a negative-cached
404 replays as `ok: false`.

**The layer steps aside entirely** for: a non-GET request, a `key()` returning
`undefined`, `retainBody: false` (the caller asked for no body — serving one would
contradict them), and a request already carrying `If-None-Match`, `If-Modified-Since` or
`Range` (the caller is running their own conditional dance).

**A result with no readable body is never stored**, whatever `isCacheable` returns: an
entry without bytes cannot be synthesized back into a result. **A throwing store degrades
to a bypass** with a `logger.warn` — a cache is an optimization, and a failing disk must
not stop a crawl. Errors from below propagate unchanged; the layer never serves a hit to
paper over one.

Enabling this layer forces full body retention in memory for every cacheable response,
because storing an entry means reading the bytes. That is inherent to caching, not a
defect.

### `CacheLayerOptions`

```ts
interface CacheLayerOptions {
	store: CacheStore; // required — there is no implicit default store
	mode?: CacheMode; // default "conditional"
	ttl?: number; // freshness window in ms, anchored at entry.storedAt
	key?(req: FetchRequest): string | undefined; // undefined ⇒ bypass; default cacheKey
	isCacheable?(res: FetchResult): boolean; // default defaultIsCacheable
	logger?: Logger;
}
```

`ttl` means different things per mode, both caller-driven: in `"dev"`, entries older than
`ttl` are refetched (no `ttl` ⇒ serve forever); in `"conditional"`, entries _younger_ than
`ttl` are served without revalidation (no `ttl` ⇒ revalidate every time).

### `CacheMode`

```ts
type CacheMode = "dev" | "conditional";
```

- **`"dev"`** — serve any hit, ignore freshness. Crawl once, then run your extraction code
  a hundred times without touching the origin.
- **`"conditional"`** _(default)_ — revalidate with `If-None-Match` / `If-Modified-Since`
  and resolve a 304 into the stored body, freshening the entry's headers (except
  `content-length`). Still a round trip, but a cheap one, and correct against a live
  origin.

### `CacheStore`

```ts
interface CacheStore {
	get(key: string): Promise<CachedEntry | undefined>; // undefined for a miss, never throw
	set(key: string, entry: CachedEntry): Promise<void>;
	delete(key: string): Promise<void>; // no-op for a key that is not there
}
```

A dumb async key-value store. It never inspects entries and knows nothing about freshness,
modes or TTLs — all policy lives in the layer. See the
[filesystem recipe](README.md#backing-the-store-yourself).

### `CachedEntry`

```ts
interface CachedEntry {
	v: 1; // format version; drop the entry on an unknown one
	url: string;
	finalUrl: string;
	redirects: string[];
	status: number; // the default policy stores 200 only; the field is general
	statusText?: string;
	headers: Record<string, string>; // plain, lowercase-keyed; set-cookie stripped
	body: Uint8Array; // NOT JSON-serializable — see serializeCachedEntry
	contentType?: string;
	charset?: string;
	size: number;
	adapter: string; // provenance
	etag?: string; // headers["etag"], lifted out
	lastModified?: string; // headers["last-modified"], lifted out
	storedAt: number; // epoch ms; ttl math anchors here
}
```

The shape is driven by one requirement — a _persistent_ store must be able to implement
it. That rules out stashing a `FetchResult` twice over:
`JSON.stringify(new Headers({...}))` is `"{}"` (every header, validators included,
silently vanishes) and `JSON.stringify(new Uint8Array([1,2,3]))` is `{"0":1,"1":2,"2":3}`.
`set-cookie` is stripped at store time — a shared cache has no business holding someone's
cookies, and iterating `Headers` would keep only the last one anyway. Deliberately absent:
`meta` (echoed from the _live_ request at synthesis time) and `extra` (adapter-specific,
frequently not serializable at all).

`CACHE_ENTRY_VERSION` is `1`.

### `cacheKey()`

The default key: `` `${req.adapter ?? "*"}:GET:${req.url}` ``, or `undefined` for anything
that must not be cached.

**Parameters:** `req` ([`FetchRequest`](#fetchrequest)) · **Returns:**
`string | undefined`

```ts
import { cacheKey } from "@marianmeres/page-fetcher/cache";

cacheKey({ url: "https://example.com/" }); // "*:GET:https://example.com/"
cacheKey({ url: "https://example.com/", adapter: "browser" }); // "browser:GET:https://example.com/"
cacheKey({ url: "https://example.com/", method: "POST" }); // undefined
```

- **GET only.** HEAD is deliberately included in that: a cached HEAD entry would be
  bodyless, which breaks the `CachedEntry` invariant. The method stays in the key string
  anyway, so widening this later needs no migration.
- **The key derives from the request only, never from the response** — adapter routing can
  be dynamic and resolves _below_ this layer, so the adapter that actually produced a
  response is unknowable at lookup time.
- **The URL goes in verbatim.** `?a=1&b=2` and `?b=2&a=1` are two keys; canonicalization is
  the crawler's job.
- **`Vary` is out of scope.** A custom `key` that folds the relevant request headers in is
  the escape hatch.

### `defaultIsCacheable()`

Status 200, and the origin did not say `no-store`.

**Parameters:** `res` ([`FetchResult`](#fetchresult)) · **Returns:** `boolean`

Only 200 — 204/206 are bodyless/partial and 201 & co. are non-GET territory the layer
never reaches. Negative caching is a one-line override:
`isCacheable: (res) => res.status === 200 || res.status === 404`.

### `createMemoryCache()`

An in-process LRU store: a `Map` with insertion-order eviction, no timers, no dependency.

**Parameters:** `options` (`MemoryCacheOptions`, optional)

```ts
interface MemoryCacheOptions {
	maxEntries?: number; // default 1000; least recently used evicted first
	logger?: Logger; // debug-logs evictions
}
```

**Returns:** `MemoryCache` — a `CacheStore` plus `readonly size: number` and `clear()`

**Throws:** `TypeError` when `maxEntries < 1`.

```ts
import { createFetcher } from "@marianmeres/page-fetcher";
import { createMemoryCache } from "@marianmeres/page-fetcher/cache";

const store = createMemoryCache({ maxEntries: 200 });
await using fetcher = createFetcher({ cache: { store, mode: "dev" } });
```

Entries are stored and returned **by reference** — no `structuredClone`, because copying
multi-MB bodies on every operation is exactly the cost a cache exists to avoid. Treat a
retrieved entry (its `body` above all) as read-only shared memory. Do the memory math
honestly: 1000 entries at ~100 KB a page is ~100 MB. There is deliberately no background
TTL sweeper — a library has no business owning a `setInterval`.

### `serializeCachedEntry()` / `deserializeCachedEntry()`

The whole contract for backing the cache with anything persistent. They hash nothing and
encode nothing: bytes are handed back raw, so the store picks its own encoding (a BLOB
column, a sibling file, base64 — its call).

- `serializeCachedEntry(entry)` → `{ meta: string; body: Uint8Array }`
- `deserializeCachedEntry(meta, body)` → `CachedEntry`

`deserializeCachedEntry` throws `PageFetchError` `kind: "decode"` for malformed JSON, a
non-object, or an entry version this build does not know. A store should treat that as a
miss (drop the row and refetch), not as a fatal error.

---

# Defaults at a glance

| Option                           | Default                                   | Where                  |
| -------------------------------- | ----------------------------------------- | ---------------------- |
| `method`                         | `"GET"`                                   | request                |
| `retainBody`                     | `true`                                    | request / adapters     |
| `retry.attempts`                 | `3`                                       | `createRetry`          |
| `retry.backoff` / `baseDelay`    | `"exponential"` / `500` ms                | `createRetry`          |
| `retry.maxDelay` / `jitter`      | `30_000` ms / `true` (full jitter)        | `createRetry`          |
| `retry.respectRetryAfter`        | `true`                                    | `createRetry`          |
| POST retried?                    | **never**, without a custom `isRetryable` | `defaultIsRetryable`   |
| `circuitBreaker`                 | **off**                                   | `createFetcher`        |
| `threshold` / `cooldown`         | `5` / `30_000` ms                         | `createCircuitBreaker` |
| `cache`                          | **off**; a bare store ⇒ `"conditional"`   | `createFetcher`        |
| `cache.maxEntries`               | `1000`                                    | `createMemoryCache`    |
| `throwOnHttpError`               | `false`                                   | `createFetcher`        |
| `logger` / `events`              | silent / none                             | everywhere             |
| HTTP `maxBytes` / `maxRedirects` | 10 MiB decoded / `5`                      | `createHttpAdapter`    |
| HTTP `onUnsupportedType`         | `"error"`                                 | `createHttpAdapter`    |
| HTTP `User-Agent`                | `marianmeres-page-fetcher (+…)`           | `createHttpAdapter`    |
| Charset order                    | BOM → header → `<meta>` → `utf-8`         | `sniffCharset`         |
| Browser `User-Agent`             | **unset** (the browser's own)             | `createBrowserAdapter` |
| Browser `wait`                   | `"networkidle"` (soft hybrid)             | `createBrowserAdapter` |
| Browser blocking                 | image, media, font, stylesheet            | `createBrowserAdapter` |
| Browser `navigationTimeout`      | `30_000` ms                               | `createBrowserAdapter` |
| Browser `maxBytes`               | 10 MiB of serialized DOM                  | `createBrowserAdapter` |
| `contextStrategy` / `poolSize`   | `"pooled"` / `3`                          | pool                   |
| `maxPagesPerContext`             | `50`                                      | pool                   |
| `acquireTimeout`                 | `30_000` ms                               | pool                   |
| `exitHooks`                      | `true`                                    | pool                   |

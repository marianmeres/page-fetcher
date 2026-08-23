<!--
GENERATED ANALYSIS — @marianmeres/page-fetcher implementation plan
Produced 2026-08-23 by multi-agent research -> adversarial verify -> synthesize.
Claims verified against the design doc (tmp/page-fetcher-DESIGN.md), local ecosystem
sources, and platform checks (all file:line citations opened; platform APIs confirmed
via deno eval). Repo is a pre-first-commit scaffold; no code was changed.
-->

# Public contracts: types, options, errors, events, Logger

> This doc pins down the entire public type surface of `@marianmeres/page-fetcher`:
> `FetchFn`, `FetchRequest`, `FetchResult`, `FetchTiming`, `PageFetchError`,
> `FetcherEvents`, the shared option bags, the `@marianmeres/clog` `Logger` integration,
> and the module layout that carries them (`src/types.ts`, `src/errors.ts`,
> `src/mod.ts`). The design sketch (§4, §9) is fundamentally sound — one error class with
> a `kind` discriminant, plain interfaces, `(next: FetchFn) => FetchFn` layers — and this
> doc mostly tightens it into an implementable contract.

> The single most important finding: **the observability contract in DESIGN §9 is
> internally inconsistent and cannot be implemented as written.** It demands a
> `requestId` "threaded through every event", yet no event payload, nor `FetchRequest`,
> nor `FetchResult` carries one; and it demands "emit per attempt" while `onResponse`
> takes an aggregate `FetchResult` that failed attempts — which throw — can never
> produce. Both are resolved below with a precise rule: `requestId` becomes a first-class
> field on request, result, error, and every event payload; per-attempt granularity is
> carried by `onRequest`/`onRetry`, terminal once-per-logical-request granularity by
> `onResponse`/`onError`.

> Second headline: open question §11.1 is resolved firmly as **eager bytes, lazy decode,
> for all adapters** — the HTTP adapter must stream-and-buffer anyway to enforce
> `maxBytes`, so "lazy HTTP text" saves nothing and creates a held-open-connection
> footgun; the cache layer (doc 05) and the browser adapter both need buffered bytes.
> Third: the new user requirement — clog's `Logger` as a first-class citizen — slots in
> cleanly via a type-only import (erased at runtime, zero-runtime-dep promise holds) and
> a `logger?: Logger` field on every layer's options, silent by default.

## Summary of recommendations

| #  | Recommendation                                                                                                  | Value | Effort | Risk |
| -- | --------------------------------------------------------------------------------------------------------------- | ----- | ------ | ---- |
| 1  | Add `requestId` end-to-end: request (optional in), result, error, every event payload                           | high  | S      | low  |
| 2  | Resolve §11.1: eager bytes + lazy memoized decode, identical across adapters                                    | high  | S      | low  |
| 3  | Fix §9 granularity: `onRequest`/`onRetry` per attempt; `onResponse`/`onError` terminal                          | high  | S      | low  |
| 4  | `PageFetchError`: keep class+`kind`; add `circuit-open` and `no-body` kinds, `is()` guard                       | high  | S      | low  |
| 5  | Logger integration: `logger?: Logger` on every options bag, level map, type-only import                         | high  | S      | low  |
| 6  | Unified body-absence model: `retainBody` option, `hasBody` flag, `skip-body` semantics                          | high  | S      | low  |
| 7  | Constrain `body` to replayable types (+ factory form); flag POST-retry default for doc 03                       | med   | S      | low  |
| 8  | `deadline` semantics: number = ms from logical-request start, normalized once                                   | med   | S      | low  |
| 9  | Module layout: `src/types.ts`, `src/errors.ts`, `src/internal.ts`, `src/mod.ts` exports                         | med   | S      | low  |
| 10 | Contract tightenings: `ok` vs 304, `redirects` chain definition, timing realism, event-handler exception policy | med   | S      | low  |

## Findings & recommendations (detailed)

### 1. `requestId` is required by §9 but exists nowhere in the type surface

- **Problem / observation.** DESIGN §9 states: "A `requestId` (uuid) should be generated
  per logical request and threaded through every event so log lines correlate." But the
  `FetchRequest` and `FetchResult` sketches (§4) have no such field, none of the five
  `FetcherEvents` payloads (§9) carry one, and `PageFetchError` (§4) doesn't either.
  As written, an event consumer cannot correlate an `onRetry` with its `onResponse`.
  This is a hard contract gap, and because layers are independently composable
  (§3 "Every layer must also be usable standalone"), the generation point must be
  defined too — there is no single choke point guaranteed to run.

- **Evidence** — DESIGN §9 (requestId sentence) vs §4 (both sketches lack the field);
  §3 (standalone-layer rule). `crypto.randomUUID` availability verified:
  `deno eval "typeof crypto.randomUUID"` → `function`; also `function` on the global in
  Node v26 (checked locally) and in browsers (secure contexts). The exact minimum Node
  version for the unflagged global is a packaging-doc detail — moot in practice, since
  the package already requires a modern fetch-capable runtime.

- **Proposed change.** In `src/types.ts`:

  ```ts
  interface FetchRequest {
  	/** Correlation id for the logical request. Auto-generated (crypto.randomUUID())
  	 * by the first layer that observes it missing; stable across attempts. */
  	requestId?: string;
  	// ...rest as in DESIGN §4
  }

  interface FetchResult {
  	/** Correlation id — always present on results. */
  	requestId: string;
  	// ...
  }
  ```

  `PageFetchError` gains `requestId?: string` (optional — an error thrown by a bare
  adapter used standalone before any id was assigned may not have one). Every
  `FetcherEvents` payload carries it (see finding 3 for exact signatures).

  **Generation rule** (normative, so composed and standalone stacks behave identically):
  every public layer factory and every adapter begins its `FetchFn` with
  `req = req.requestId ? req : { ...req, requestId: crypto.randomUUID() }` — a shared
  internal helper `ensureRequestId(req)` in `src/internal.ts` (finding 9).
  Idempotent, so in the composed stack the outermost layer wins and inner layers
  pass it through. Never mutate the caller's object; shallow-clone.

- **Affected files** — `src/types.ts`, `src/errors.ts`, `src/internal.ts`; consumed by
  every layer (docs 02–05).

- **Effort / Value / Risk** — S / high / low.

- **Implementation notes.** Fixed-cost. `crypto.randomUUID()` requires a secure context
  in browsers, but this package targets Deno/Node servers; document, don't polyfill.
  Log lines (finding 5) prefix a short form, e.g. `requestId.slice(0, 8)`.

### 2. Resolve DESIGN §11.1: eager bytes, lazy decode — for all adapters

- **Problem / observation.** §11.1 asks whether `text()` is lazy or eager and suggests
  "eager for the browser adapter, lazy for HTTP". **Design deviation — recommend eager
  bytes everywhere, firmly.** The lazy-HTTP half of the suggestion buys nothing and
  costs a lot:
  - The HTTP adapter must stream the body _during_ the fetch anyway to enforce
    `maxBytes` (§5.1 "Streams the body and aborts as soon as maxBytes is exceeded").
    Once you've streamed it, you have the bytes; discarding them to re-read lazily
    would mean holding the connection open past the fetch call — a footgun for
    timeouts, retries, connection reuse, and `dispose()`.
  - `size` (§4) — "bytes actually read" — can only be exact if the read completes.
  - The cache layer (doc 05) must store bytes; a lazy body would force it to
    materialize anyway, in the worst place (the cache wrapper).
  - The browser adapter closes/recycles the page after the fetch (§5.2 pooling), so
    lazy is impossible there regardless — which is exactly why hiding two behaviors
    "behind the same method" would create adapter-dependent semantics, the thing the
    package exists to eliminate.

  Memory is bounded by construction: `maxBytes` (default ~10 MB, §7) caps every
  buffered body.

- **Evidence** — DESIGN §11.1, §5.1 (streaming maxBytes), §4 (`size`, lazily-materialized
  comment on `text()`), §8 (cache stores full results), §5.2 (page lifecycle).

- **Proposed change.** Normative result-body contract in `src/types.ts` JSDoc:

  ```ts
  interface FetchResult {
  	/** Raw body bytes, fully read during the fetch (bounded by maxBytes).
  	 * Rejects with PageFetchError kind "no-body" when hasBody === false. */
  	bytes(): Promise<Uint8Array>;
  	/** Body decoded per the charset decision (§7). Decoded lazily on first call,
  	 * memoized. Same rejection rule as bytes(). */
  	text(): Promise<string>;
  	// ...
  }
  ```

  Bytes are read eagerly (before the adapter's `FetchFn` resolves); only the
  bytes→string _decode_ is lazy and memoized (decoding a 10 MB body the caller never
  reads as text is the one real cost worth deferring). Both methods stay async purely
  for API stability — no adapter may resolve a result whose bytes are not already in
  memory (or knowingly absent, finding 6). **This is the contract doc 05 (cache) builds
  on: a `CachedEntry` stores `Uint8Array` body + headers; re-decoding on cache hit
  reuses the same lazy `text()` path.**

- **Affected files** — `src/types.ts` (contract), `src/internal.ts` (helper), adapters
  (docs 02/04), `src/cache/*` (doc 05).

- **Effort / Value / Risk** — S (it's a decision + JSDoc; the adapters were streaming
  anyway) / high / low.

- **Implementation notes.** Internal helper `createBodyResult(bytesOrNull, charset)` in
  `src/internal.ts` producing the memoizing `text()`/`bytes()` pair keeps adapters
  consistent. `bytes()` should return the retained buffer (documenting that mutation is
  on the caller) rather than copying per call — copy-per-call would double peak memory.

### 3. §9 granularity contradiction: which events fire per attempt vs per logical request

- **Problem / observation.** §9's rule "emit **per attempt**, not per logical request"
  contradicts its own signatures: `onResponse(res: FetchResult)` takes the aggregate
  result (`attempts`, whole-request `timing`), and a failed attempt throws — there is no
  per-attempt `FetchResult` to emit. Taken literally the rule is unimplementable for
  `onResponse`/`onError`.

- **Evidence** — DESIGN §9 (rule + signatures), §4 (`FetchResult.attempts`, `timing`
  carry aggregates), §6 (failed attempts surface as `PageFetchError` into the retry
  layer).

- **Proposed change.** **Design deviation (clarifying fix):** granularity is defined
  per event, in `src/types.ts`:

  ```ts
  interface FetcherEvents {
  	/** PER ATTEMPT — fired before each attempt's I/O, including attempt 1. */
  	onRequest?(req: FetchRequest, info: { requestId: string; attempt: number }): void;
  	/** PER LOGICAL REQUEST — fired once with the final aggregate result. */
  	onResponse?(res: FetchResult): void; // res.requestId, res.attempts
  	/** PER SCHEDULED RETRY — fired when an attempt failed and another will run. */
  	onRetry?(info: {
  		requestId: string;
  		url: string;
  		attempt: number; // the attempt that just failed (1-based)
  		delay: number;
  		err: PageFetchError;
  	}): void;
  	/** PER LOGICAL REQUEST — fired once, on final failure (after last attempt). */
  	onError?(err: PageFetchError, req: FetchRequest): void;
  	/** On breaker state transition (host-level, not per request). */
  	onCircuitOpen?(info: { host: string; until: number; requestId?: string }): void;
  }
  ```

  Per-attempt visibility is thus complete without a per-attempt result object: every
  attempt announces itself via `onRequest`; every failed-but-retried attempt surfaces
  its error via `onRetry`; the terminal outcome is exactly one of `onResponse` |
  `onError`. Invariant to document and test: for a logical request with N attempts,
  handlers see N × `onRequest`, (N−1) × `onRetry`, and exactly one terminal event.

  **Emission ownership** (needed because layers compose freely): the retry layer emits
  `onRequest` (per attempt) and `onRetry`; `createFetcher`'s outermost instrumentation
  emits the terminal `onResponse`/`onError`; the breaker layer emits `onCircuitOpen`.
  When no retry layer is wired, the instrumentation wrapper emits the single
  `onRequest` (attempt 1) itself — `createFetcher` knows whether it wired a retry
  layer, so it can decide statically; standalone users pass `events` to whichever
  layer they want emitting (document this). Exact wiring is doc 06's scope.

  `onCircuitOpen` changes from positional args to an object bag for consistency and to
  carry the triggering `requestId` — small deviation from the §9 sketch, flagged in
  Open questions. Retry internals (`RetryOptions.onRetry` vs event `onRetry` overlap)
  belong to doc 03 — one pointer: keep both, `RetryOptions.onRetry` is the per-layer
  callback, `FetcherEvents.onRetry` the cross-cutting sink; same payload type
  (`RetryInfo`, exported once from `src/types.ts`).

- **Affected files** — `src/types.ts`; `src/retry.ts` + `src/fetcher.ts` (emission,
  docs 03/06).

- **Effort / Value / Risk** — S / high / low.

- **Implementation notes.** Handler exception policy in finding 10. All handlers are
  fire-and-forget: return values (including promises) ignored; the pipeline never
  awaits an event handler.

### 4. `PageFetchError`: class + `kind` confirmed; add `circuit-open` and `no-body`; add a realm-safe guard

- **Problem / observation.** Three sub-points.
  (a) _Is a single class with a `kind` union the right shape?_ Ecosystem precedent is
  thin but compatible: demino/collection use bare `class TimeoutError extends Error {}`
  subclasses (demino `src/utils/with-timeout.ts:15`, collection
  `src/lib/utils/with-timeout.ts:2`) and demino leans on `@marianmeres/http-utils`
  `createHttpError` — an `Error & { status?: number }` shape (demino `src/demino.ts:1`,
  `:69`) — i.e. the ecosystem already prefers _one error carrier + a discriminating
  field_ over a class hierarchy. A class-per-kind here would mean ~12 exported classes
  and `instanceof` ladders in `isRetryable`; the single class + `kind` union is the
  right call. **Confirmed sound — keep as designed.**
  (b) _Circuit-breaker rejections masquerade as `kind: "network"`_ (§6). This loses
  real information: the crawler cannot distinguish "host is down and we are backing
  off deliberately" (reschedule the URL later) from "DNS/TLS actually failed"
  (count as a fetch failure). It also makes `onCircuitOpen` + `onError` incoherent —
  the error says network, the event says breaker.
  (c) `instanceof PageFetchError` breaks across dual-registry installs (JSR + npm both
  resolvable in one graph) or bundler-duplicated module instances.

- **Evidence** — DESIGN §4 (class sketch), §6 (breaker: `kind: "network",
  retryable: false`); demino `src/demino.ts:69` (`error: (Error & { status?: number })`),
  demino `src/utils/with-timeout.ts:15`. All citations opened and confirmed.

- **Proposed change.** `src/errors.ts`:

  ```ts
  export type PageFetchErrorKind =
  	| "network"
  	| "timeout"
  	| "deadline"
  	| "aborted"
  	| "http"
  	| "too-large"
  	| "unsupported-type"
  	| "too-many-redirects"
  	| "browser"
  	| "decode"
  	| "circuit-open" // NEW — breaker rejection (Design deviation from §6, see below)
  	| "no-body"; // NEW — body intentionally absent (finding 6)

  export interface PageFetchErrorInit {
  	kind: PageFetchErrorKind;
  	url: string;
  	message?: string; // default derived from kind + url
  	status?: number;
  	finalUrl?: string;
  	requestId?: string;
  	attempts?: number; // default 0 (thrown before any attempt ran)
  	retryable?: boolean; // default per-kind table (doc 03 owns the table)
  	cause?: unknown;
  	/** Kind-specific extras, e.g. { until } for circuit-open, { maxBytes, read } for too-large. */
  	details?: Record<string, unknown>;
  }

  export class PageFetchError extends Error {
  	override name = "PageFetchError";
  	readonly kind: PageFetchErrorKind;
  	readonly url: string;
  	readonly status?: number;
  	readonly finalUrl?: string;
  	readonly requestId?: string;
  	readonly attempts: number;
  	readonly retryable: boolean;
  	readonly details?: Record<string, unknown>;
  	constructor(init: PageFetchErrorInit);
  	/** Realm-safe guard — use instead of instanceof in cross-package code. */
  	static is(e: unknown): e is PageFetchError; // duck-check: name + string kind + url
  }
  ```

  **Design deviation:** the breaker throws `kind: "circuit-open"`, `retryable: false`,
  `details: { host, until }` — _not_ `"network"` as §6 says. Rationale above; the
  breaker layer itself is doc 03's scope — flagged here because this doc owns the kind
  union. Retry classification table (§6) is unaffected: `circuit-open` joins the
  non-retryable rows.

  Constructor takes a single init object (12 optional positional params would be
  unusable); `cause` passes through standard `ErrorOptions`. `attempts` defaults to 0
  so guards/adapters throwing pre-attempt don't fake a count; the retry layer rewrites
  `attempts` on the final rethrow (doc 03).

- **Affected files** — `src/errors.ts` (new), `src/mod.ts` (export); every layer
  constructs these.

- **Effort / Value / Risk** — S / high / low.

- **Implementation notes.** `static is()` should duck-check
  (`e instanceof Error && (e as any).name === "PageFetchError" && typeof (e as any).kind === "string"`)
  with an `instanceof PageFetchError` fast path. Do not add per-kind subclasses. The
  `"decode"` kind is reserved: §7 mandates lenient fallback-to-utf-8 on unknown labels,
  so v1 never throws it from the default path — keep it in the union for a future
  strict-decode option rather than churning the union later (one-line note in JSDoc).

### 5. clog `Logger` as a first-class citizen: threading, levels, type-only mechanics

- **Problem / observation.** New user requirement, absent from the design doc (which
  says only "the package emits, it does not log", §9). The requirement is compatible:
  logging _complements_ events — same instrumentation points, human-oriented channel —
  and stays fully inert unless the caller injects a logger. Must not violate §2's
  zero-runtime-dependency promise.

- **Evidence** — clog `src/clog.ts:186-218`: `interface Logger { debug; log; warn;
  error }`, all `(...args: any[]) => any`, structurally satisfied by `console` and by
  `createClog(ns)`; exported from clog's `src/mod.ts:10` (`export * from "./clog.ts"`).
  clog version `3.21.0` (clog `deno.json`). demino precedent for an injectable logger
  option: `DeminoLogger` at demino `src/demino.ts:259,705`. All citations opened and
  confirmed. Type-only imports are erased from emitted JS (TypeScript `import type`
  semantics — no runtime specifier remains), so no runtime dependency is introduced.

- **Proposed change.**
  1. `deno.json` imports gain `"@marianmeres/clog": "jsr:@marianmeres/clog@^3.21.0"`
     (compile-time only; see Implementation notes for keeping it out of the npm
     build's runtime deps).
  2. `src/types.ts`:

     ```ts
     import type { Logger } from "@marianmeres/clog";

     /** Cross-cutting options accepted by every layer factory and createFetcher. */
     export interface ObservabilityOptions {
     	/** Console-compatible logger (clog Logger). Default: undefined = silent. */
     	logger?: Logger;
     	/** Machine-consumable event sink (see FetcherEvents). */
     	events?: FetcherEvents;
     }

     export type { Logger }; // re-export type-only, so consumers can type their
     // logger without depending on clog themselves (erased at runtime)
     ```

  3. Every layer factory intersects it:
     `createHttpAdapter(opts?: HttpAdapterOptions & ObservabilityOptions)`,
     `withRetry(opts?: RetryOptions & ObservabilityOptions)`, etc. `createFetcher`
     accepts one `logger`/`events` pair and passes the same instances to each layer it
     wires — one logger, many call sites, correlated by `requestId` prefix.
  4. **Level map** (normative, documented in README):
     - `debug` — per-attempt start/finish, adapter selection, redirect hops, charset
       decision, cache hit/miss/store, backoff delay computed, pool acquire/release.
     - `log` — coarse lifecycle only: fetcher created, adapter/browser launched,
       `dispose()` completed. Nothing per-request at this level.
     - `warn` — retry scheduled (attempt N failed, retrying in D ms), circuit opened /
       half-open probe, `Retry-After` capped by `maxDelay`, unsupported content-type
       skipped, decode fell back to utf-8, event-handler threw (finding 10).
     - `error` — final failure of a logical request, once, alongside `onError`.
  5. Namespace guidance (docs, not code): the package never creates a clog instance;
     README shows `createFetcher({ logger: createClog("fetcher") })` and notes that
     passing bare `console` also works. Line convention:
     `logger.debug(\`[\${requestId.slice(0, 8)}] attempt \${n} \${url}\`)`.

- **Affected files** — `deno.json` (import map), `src/types.ts`, every layer factory
  signature (docs 02–06), README (doc for it).

- **Effort / Value / Risk** — S / high (user-mandated) / low.

- **Implementation notes.** Rejected alternative: vendoring a local `Logger` copy —
  drift risk against clog and defeats the "first-class citizen" intent; structural
  typing already lets non-clog consumers pass `console`. Packaging detail — verified:
  `@marianmeres/npmbuild` emits **no** `dependencies` unless explicitly passed
  (default `[]`, npmbuild `npm-build.ts:129-140`), so clog stays out of the published
  runtime deps by simply not listing it. One sub-detail remains for the packaging doc:
  the npm build's `tsc` must resolve the clog `Logger` type _without_ it landing in
  `dependencies` — note that npmbuild's `jsrDependencies` route runs `npx jsr add`
  (`npm-build.ts:458-459`), which would add it to `dependencies`; use a types-only
  route instead. Also expected (confirm on first publish): on JSR the type-only import
  still appears in the package's dependency graph, because JSR ships TS source — this
  is types-only, pulls no runtime code, and is consistent with §2's promise.

### 6. Body-absence model: spec `retainBody`, add `hasBody`, define `skip-body` behavior

- **Problem / observation.** Two connected gaps. (a) §4 references `retainBody`
  ("Raw bytes, if retained (see `retainBody`)") but the option is never defined
  anywhere — **design gap**. (b) §7's `onUnsupportedType: "skip-body"` "returns headers
  only" but never says what `text()`/`bytes()` do on such a result. There are actually
  _four_ ways a result legitimately has no body: `retainBody: false`, `skip-body`
  policy hit, `method: "HEAD"`, and a 304 the cache layer cannot resolve. They need one
  unified contract, not four ad-hoc ones.

- **Evidence** — DESIGN §4 (`bytes()` comment), §7 (content-type policy), §8 (304
  path); finding 2 (eager-bytes contract this builds on).

- **Proposed change.**
  1. `FetchRequest.retainBody?: boolean` — default `true`. When `false`, the adapter
     aborts the body read right after headers (link-check mode): no bytes buffered,
     bandwidth saved; `size` is `undefined` (nothing was read — see Open questions for
     the drain-vs-abort call).
  2. `FetchResult.hasBody: boolean` — single source of truth, `true` iff bytes were
     retained and are available.
  3. When `hasBody === false`, both `text()` and `bytes()` reject with
     `PageFetchError` `kind: "no-body"`, `retryable: false`, `details: { reason:
     "retain-body" | "skip-body" | "head" | "not-modified" }`. Alternative considered
     and rejected: rejecting a `skip-body` read with `kind: "unsupported-type"` would
     be defensible, but then `retainBody: false` and HEAD would need different kinds
     for the identical condition ("you asked me not to keep the body"); one kind + a
     `reason` detail is strictly more regular. The result still resolves normally
     (`ok` per status) in all four cases — body absence is never itself an error;
     only _reading_ the absent body is.
  4. `skip-body` therefore means: guards layer inspects the `content-type` header,
     aborts the body stream, resolves with `hasBody: false`, `contentType` set, `size:
     undefined` — and `onUnsupportedType: "error"` (the default) throws
     `kind: "unsupported-type"` instead. Fetch-level default for `retainBody` also
     available in the guards options (doc 02 owns `GuardsOptions`; the field name and
     semantics are fixed here).

- **Affected files** — `src/types.ts`, `src/errors.ts`; enforcement in adapters +
  guards (doc 02), cache interplay (doc 05 — pointer: cache must not create
  revalidation entries from `hasBody: false` results).

- **Effort / Value / Risk** — S / high / low.

- **Implementation notes.** `createBodyResult(null, ...)` (finding 2's helper) covers
  the rejecting variant so all adapters behave identically. Add a fixture test:
  HEAD → `hasBody: false`, `text()` rejects with `kind: "no-body"`,
  `details.reason: "head"`.

### 7. `body: BodyInit` is retry-hostile — constrain to replayable types

- **Problem / observation.** §4 allows `body?: BodyInit`, and §6 retries failed
  attempts. `BodyInit` includes `ReadableStream`, which is one-shot by spec (a Request
  with a stream body locks/consumes it; a second send of the same stream fails). A
  retried POST with a stream body is a silent-corruption bug waiting to happen.
  Secondary observation for doc 03: retrying POST at all is unsafe by default
  (non-idempotent); mainstream HTTP clients retry only idempotent methods unless told
  otherwise.

- **Evidence** — DESIGN §4 (`body?: BodyInit`), §6 (retry layer). Replayability
  verified via `deno eval`: `new Request(url, { method: "POST", body: formData })`
  — `.clone().text()` and `.text()` return identical non-empty payloads (FormData is
  a plain data structure, replayable); constructing a second `Request` from an
  already-consumed `ReadableStream` throws `TypeError` (one-shot confirmed).

- **Proposed change.** `src/types.ts`:

  ```ts
  /** Body types that can be sent again on retry without corruption. */
  export type ReplayableBody =
  	| string
  	| Uint8Array
  	| ArrayBuffer
  	| Blob
  	| URLSearchParams
  	| FormData;

  interface FetchRequest {
  	/** Replayable value, or a factory invoked once per attempt (streaming escape hatch). */
  	body?: ReplayableBody | (() => ReplayableBody | ReadableStream<Uint8Array>);
  	// ...
  }
  ```

  **Design deviation** from `BodyInit`, deliberate: plain `ReadableStream` is rejected
  at the type level; callers who truly need streaming provide the factory form, which
  produces a fresh stream per attempt — the rule "each attempt gets a fresh body" is
  then enforceable by construction. Flag for doc 03 (one line, they own the table):
  default `isRetryable` should return `false` for `method: "POST"` regardless of error
  kind; POST retries are opt-in via a custom `isRetryable`.

- **Affected files** — `src/types.ts`; adapters invoke the factory per attempt
  (doc 02); retry default (doc 03).

- **Effort / Value / Risk** — S / med / low.

- **Implementation notes.** The factory is called by the _adapter_ at attempt time
  (not once by the retry layer) so standalone adapter use also works. Keep
  `Uint8Array` in the union even though `BufferSource` would subsume it — explicit
  beats clever in public unions.

### 8. `deadline: number | Date` — define the number's clock

- **Problem / observation.** §4 says "Hard deadline across all attempts (ms or absolute
  Date)" but never anchors what the ms number is relative to. Ambiguity here silently
  changes retry behavior (§6: "never sleep past it").

- **Evidence** — DESIGN §4 (`deadline?: number | Date`), §6 (deadline rule), §7
  (timeout vs deadline separation). `AbortSignal.any` / `AbortSignal.timeout` verified
  present (`deno eval` → `function function`).

- **Proposed change.** Normative JSDoc in `src/types.ts`:

  ```ts
  /** Hard deadline across all attempts, including retry sleeps.
   * number → milliseconds from the start of the logical request (the moment the
   *   outermost layer receives it, i.e. effectively first-attempt start);
   * Date → absolute wall-clock instant.
   * Already-expired deadline → immediate PageFetchError kind "deadline", attempts: 0. */
  deadline?: number | Date;
  ```

  Normalization rule: converted exactly once to absolute epoch ms
  (`deadlineAt = typeof d === "number" ? Date.now() + d : d.getTime()`) by the first
  layer that enforces it, then carried internally (internal field on the cloned
  request, e.g. `req[DEADLINE_AT]` symbol or a normalized `deadline: Date`) so inner
  layers do not restart the clock — restarting per layer is the bug this rule exists
  to prevent. Enforcement mechanics (which layer, `AbortSignal.any` composition with
  per-attempt `timeout`) belong to doc 02/03 — pointer only.

- **Affected files** — `src/types.ts` (contract); guards/retry (docs 02/03).

- **Effort / Value / Risk** — S / med / low.

- **Implementation notes.** Check-then-normalize is the whole trick: the
  already-expired case must be tested (fake timers, doc on §10's fixture list), and
  whichever internal carrier is chosen (symbol vs normalized Date) is an
  implementer's call — the observable contract above is what's fixed here.

### 9. Module layout and `mod.ts` export surface for this area

- **Problem / observation.** Greenfield: the scaffold has placeholder
  `src/mod.ts` → `src/page-fetcher.ts` ("it works"). The design doc suggests three
  package exports (§2) but no file layout. This doc owns the contracts modules; sibling
  layout (adapters/, cache/, retry, guards, fetcher) is proposed in docs 02–06 —
  pointers only.

- **Evidence** — repo `src/mod.ts`, `src/page-fetcher.ts` (placeholders, opened);
  `deno.json` (single `"./src/mod.ts"` export today); DESIGN §2.

- **Proposed change.**
  - `src/types.ts` — `FetchFn`, `FetchRequest`, `FetchResult`, `FetchTiming`,
    `ReplayableBody`, `Adapter`, `FetcherEvents`, `RetryInfo`,
    `ObservabilityOptions`, type-only `Logger` re-export. Types only — it imports
    nothing but the clog type and stays runtime-free.
  - `src/internal.ts` — shared runtime helpers `ensureRequestId`, `createBodyResult`
    (findings 1, 2); not exported from mod.
  - `src/errors.ts` — `PageFetchError`, `PageFetchErrorKind`, `PageFetchErrorInit`.
  - `src/mod.ts` — value exports: `createFetcher` (doc 06), `PageFetchError`; type
    exports: everything above via explicit `export type { ... }` (JSR fast-check
    friendly; no `export *` so the public surface is a reviewable list). Delete
    `src/page-fetcher.ts` placeholder.
  - `deno.json` `exports` becomes the §2 map:
    `{ ".": "./src/mod.ts", "./adapters": "./src/adapters/mod.ts", "./cache": "./src/cache/mod.ts" }`
    — flagged here because it is public surface; the packaging/npmbuild implications
    (subpath exports in the npm build) belong to the packaging dimension doc.

- **Affected files** — `src/types.ts` (new), `src/internal.ts` (new), `src/errors.ts`
  (new), `src/mod.ts` (rewrite), `src/page-fetcher.ts` (delete), `deno.json`.

- **Effort / Value / Risk** — S / med / low.

- **Implementation notes.** All public symbols need explicit JSDoc + explicit return
  types (JSR no-slow-types). Option interfaces live next to their layer
  (`RetryOptions` in `src/retry.ts` etc., re-exported as types from mod) — only the
  _shared_ types live in `types.ts`.

### 10. Small contract tightenings the sketch leaves ambiguous

- **Problem / observation.** Four leftover ambiguities in §4/§9, each cheap to pin now
  and annoying to retrofit.

- **Evidence** — DESIGN §4 (`ok`, `redirects`, `FetchTiming`), §9 (event signatures);
  finding 3.

- **Proposed change** (all in `src/types.ts` JSDoc, normative):
  1. **`ok`**: `true` iff `200 <= status < 300`, _or_ the result was resolved from the
     cache via a 304 revalidation (`notModified: true`, `status: 304`, body served from
     store). Mirrors `Response.ok` plus the one cache exception; doc 05 consumes this
     definition.
  2. **`redirects`**: the URLs that answered with a 3xx, in visit order — for
     `A → B → C(200)`: `url: A`, `redirects: [A, B]`, `finalUrl: C`; `[]` when no
     redirect occurred. (Resolves §4's "chain, excluding finalUrl" ambiguity about
     whether the origin URL is included: it is, iff it redirected — the chain is then
     self-contained.)
  3. **`FetchTiming` realism**: `startedAt`/`endedAt` are epoch ms spanning the whole
     logical request including retry sleeps; `total = endedAt - startedAt`. `dns` /
     `connect` are documented "best effort — typically `undefined` for the HTTP
     adapter" (platform `fetch` exposes no socket phases portably); `ttfb` (request
     start → headers resolved) and `download` (headers → last body byte) are
     measurable and required from the HTTP adapter; `render` browser-only. Keeping the
     optional fields is fine; _promising_ them would be a lie — this wording prevents
     that.
  4. **Event/logger handler failures**: every `FetcherEvents` handler call is wrapped;
     a throwing handler never affects the fetch outcome; the failure is reported via
     `logger.warn` (if present) and otherwise swallowed. Handlers are synchronous
     fire-and-forget — returned promises are not awaited (type is `void`).

- **Affected files** — `src/types.ts`; behaviors land in adapters/layers (docs 02–06).

- **Effort / Value / Risk** — S / med / low.

## Cross-doc pointers (not duplicated here)

- Retry classification table, POST-no-retry default, breaker mechanics → doc 03
  (this doc fixes only the _kinds_ `circuit-open` / table membership).
- `GuardsOptions` (`maxBytes`, `allowContentTypes`, `onUnsupportedType`, `maxRedirects`)
  field semantics → doc 02; the result-side flags they set are fixed here.
- `CacheStore` / `CachedEntry` shapes and the 304 path → doc 05; builds on findings 2,
  6, 10.1.
- `createFetcher` options composition and adapter routing → doc 06/02.
- npm build subpath exports + how the npm build's `tsc` resolves the clog type without
  a runtime dep (finding 5's note) → packaging doc.

## Open questions / decisions needed

- `onCircuitOpen` payload: OK to deviate from the §9 sketch's positional
  `(host, until)` to the object bag `{ host, until, requestId? }` (consistency +
  correlation)? Recommendation: yes.
- `retainBody: false`: abort the connection immediately after headers (recommended —
  bandwidth is the point; `size` stays `undefined`), or drain the body to report exact
  `size` at full bandwidth cost? Owner call; affects link-check ergonomics.
- Default retry policy and POST: confirm "never retry POST by default, opt-in via
  `isRetryable`" (recommended; affects doc 03's table).
- Re-export clog's `Logger` type from the package root (recommended, type-only, erased)
  vs requiring consumers to import it from `@marianmeres/clog` themselves?

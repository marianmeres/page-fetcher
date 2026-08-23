/**
 * Shared public type surface of `@marianmeres/page-fetcher`.
 *
 * This module is runtime-free: it contains nothing but types (its single import is
 * type-only and erased at compile time). Option interfaces that belong to one specific
 * layer live next to that layer (`RetryOptions` in `src/retry.ts`, ...); only types
 * shared across layers live here.
 *
 * @module
 */

import type { Logger } from "@marianmeres/clog";
import type { PageFetchError } from "./errors.ts";

/**
 * Console-compatible logger interface (from `@marianmeres/clog`).
 *
 * Re-exported so consumers can type their own logger without depending on clog
 * themselves. The import is type-only — no clog code is pulled in at runtime, and
 * `console` satisfies the interface structurally.
 */
export type { Logger };

/** HTTP methods supported by this package. */
export type HttpMethod = "GET" | "HEAD" | "POST";

/**
 * Body types that can be sent again on a retry without corruption.
 *
 * `ReadableStream` is deliberately absent: it is one-shot by spec, so a retried (or
 * 307/308-replayed) request carrying one would silently send an empty or partial body.
 * Use the {@linkcode BodyFactory} form for streaming.
 */
export type ReplayableBody =
	| string
	| Uint8Array
	| ArrayBuffer
	| Blob
	| URLSearchParams
	| FormData;

/**
 * Streaming escape hatch: invoked by the adapter once per attempt, so every attempt
 * gets a fresh body.
 */
export type BodyFactory = () => ReplayableBody | ReadableStream<Uint8Array>;

/** A single fetch operation. Every layer and every adapter is one of these. */
export type FetchFn = (req: FetchRequest) => Promise<FetchResult>;

/**
 * A composable layer: takes the next `FetchFn` and returns a wrapping one.
 *
 * Layers are composed outermost-first (see `compose()`); there is no class hierarchy
 * and no plugin registry.
 */
export type FetchLayer = (next: FetchFn) => FetchFn;

/** What to do when a response's content type is not in the allow-list. */
export type UnsupportedTypePolicy = "error" | "skip-body";

/** Why a result carries no body (see {@linkcode FetchResult.hasBody}). */
export type BodyAbsentReason =
	/** `retainBody: false` — the read was aborted right after the headers. */
	| "retain-body"
	/** Content type not allowed and `onUnsupportedType: "skip-body"`. */
	| "skip-body"
	/** `method: "HEAD"` — there is no body by definition. */
	| "head"
	/** A 304 the cache layer could not resolve into a stored body. */
	| "not-modified";

/** The request as passed into a {@linkcode FetchFn}. */
export interface FetchRequest {
	/** Absolute URL to fetch. */
	url: string;
	/** Default `"GET"`. */
	method?: HttpMethod;
	/** Request headers. Merged over the adapter-level defaults. */
	headers?: Record<string, string>;
	/**
	 * Request body. Must be replayable, or a factory called once per attempt.
	 * Note that POST is not retried by the default retry policy.
	 */
	body?: ReplayableBody | BodyFactory;
	/** Caller cancellation. Propagates to the platform fetch, browser navigation and retry sleeps. */
	signal?: AbortSignal;
	/** Per-attempt timeout (ms). Re-armed for every attempt. */
	timeout?: number;
	/**
	 * Hard deadline across all attempts, including retry sleeps.
	 *
	 * - `number` — milliseconds from the start of the logical request (the moment the
	 *   outermost layer receives it, i.e. effectively first-attempt start).
	 * - `Date` — absolute wall-clock instant.
	 *
	 * An already-expired deadline fails immediately with `PageFetchError`
	 * `kind: "deadline"`, `attempts: 0`. The first layer that enforces it converts a
	 * relative number into an absolute `Date` on the request it passes down, so inner
	 * layers never restart the clock.
	 */
	deadline?: number | Date;
	/**
	 * Keep the response body? Default `true`. When `false` the adapter aborts the read
	 * right after the headers (link-check mode): no bytes are buffered, `size` stays
	 * `undefined`, and reading the body rejects with `kind: "no-body"`.
	 */
	retainBody?: boolean;
	/** Explicit adapter name. Highest-priority routing input. */
	adapter?: string;
	/** Per-request adapter options (adapter-specific). */
	adapterOptions?: Record<string, unknown>;
	/**
	 * Correlation id for the logical request. Auto-generated (`crypto.randomUUID()`) by
	 * the first layer or adapter that observes it missing, and stable across attempts.
	 */
	requestId?: string;
	/** Arbitrary caller payload, echoed back on the result (the crawler uses it for depth/referrer). */
	meta?: Record<string, unknown>;
}

/**
 * Timing of one logical request.
 *
 * Who fills what: the HTTP adapter sets `startedAt`, `endedAt`, `total`, `ttfb` and
 * `download`; `dns` and `connect` are best-effort and stay `undefined` there (the
 * platform `fetch` exposes no socket phases portably); `render` is browser-only.
 */
export interface FetchTiming {
	/** Epoch ms at the start of the logical request. */
	startedAt: number;
	/** Epoch ms when the result was finalized (body fully read or knowingly skipped). */
	endedAt: number;
	/** `endedAt - startedAt`, spanning every attempt and every retry sleep. */
	total: number;
	/** Best effort — typically `undefined`. */
	dns?: number;
	/** Best effort — typically `undefined`. */
	connect?: number;
	/** Time to the final response's headers (not literally the first body byte). */
	ttfb?: number;
	/** Headers-received → last body byte. */
	download?: number;
	/** Browser adapter only. */
	render?: number;
}

/**
 * Normalized result of one logical request, whatever adapter produced it.
 *
 * Body contract (identical for every adapter): the bytes are read eagerly, before the
 * adapter's `FetchFn` resolves, and bounded by `maxBytes`; only the bytes→string
 * *decode* is lazy and memoized. Both accessors are async purely for API stability.
 */
export interface FetchResult {
	/** `true` iff `200 <= status < 300`, or the result was revalidated from cache via a 304. */
	ok: boolean;
	/** The requested URL. */
	url: string;
	/** URL of the final response, after redirects. Resolve relative references against this. */
	finalUrl: string;
	/** HTTP status. */
	status: number;
	/** HTTP status text, when the transport reports one. */
	statusText?: string;
	/** Response headers of the final response. */
	headers: Headers;
	/**
	 * URLs that answered with a 3xx, in visit order — for `A → B → C(200)`: `url` is
	 * `A`, `redirects` is `[A, B]`, `finalUrl` is `C`. Empty when nothing redirected.
	 */
	redirects: string[];
	/** Correlation id — always present on results. */
	requestId: string;
	/** Whether body bytes were retained and are readable. */
	hasBody: boolean;
	/**
	 * Body decoded per the resolved charset. Decoded on first call, then memoized.
	 * Rejects with `PageFetchError` `kind: "no-body"` when `hasBody` is `false`.
	 */
	text(): Promise<string>;
	/**
	 * Raw body bytes, already in memory. Returns the retained buffer itself — mutating
	 * it is on the caller. Same rejection rule as {@linkcode FetchResult.text}.
	 */
	bytes(): Promise<Uint8Array>;
	/** Parsed mime, lowercased, without parameters. */
	contentType?: string;
	/** Charset label actually used to decode. */
	charset?: string;
	/** Bytes actually read. `undefined` when no body was read. */
	size?: number;
	/** Served from the cache layer without touching the network. */
	fromCache: boolean;
	/** The 304 path was taken (body came from the cache store). */
	notModified: boolean;
	/** Timing of the whole logical request. */
	timing: FetchTiming;
	/** Attempts made. Adapters always report 1; the retry layer owns the final number; cache hits report 0. */
	attempts: number;
	/** Name of the adapter that produced this result. */
	adapter: string;
	/** Echoed back from the request. */
	meta?: Record<string, unknown>;
	/** Adapter-specific extras (browser: title, console errors, ...). */
	extra?: Record<string, unknown>;
}

/** An I/O backend: the thing at the bottom of the layer stack. */
export interface Adapter {
	/** Unique name, also reported as {@linkcode FetchResult.adapter}. */
	name: string;
	/** The actual I/O. */
	fetch: FetchFn;
	/** Called once on fetcher teardown. Must be idempotent. */
	dispose?(): Promise<void>;
	/** Optional readiness/health probe (e.g. browser launch check). */
	health?(): Promise<boolean>;
}

/**
 * The outcome of one attempt, as seen by retry classification and the circuit breaker:
 * exactly one of `error` / `result` is set.
 *
 * A non-2xx response is data, not an error (it resolves with `ok: false`), so the
 * dominant retry trigger is a *result* — which is why this is an either/or pair rather
 * than a mandatory error.
 */
export interface RetryOutcome {
	/** Set when the attempt threw. */
	error?: PageFetchError;
	/** Set when the attempt resolved with a result that classified as retryable. */
	result?: FetchResult;
}

/**
 * Payload of both `RetryOptions.onRetry` (the per-layer callback) and
 * `FetcherEvents.onRetry` (the cross-cutting sink).
 */
export type RetryInfo = {
	/** Correlation id; present whenever the request carried one. */
	requestId?: string;
	/** Requested URL. */
	url: string;
	/** The 1-based attempt that just failed. */
	attempt: number;
	/** Milliseconds that will be slept before the next attempt. */
	delay: number;
} & RetryOutcome;

/**
 * Machine-consumable event sink. Handlers are synchronous fire-and-forget: return
 * values (including promises) are ignored, and a throwing handler never affects the
 * fetch outcome (it is reported via `logger.warn`, if a logger was injected).
 *
 * Granularity is defined per event. For a logical request with N attempts, handlers see
 * N × `onRequest`, (N−1) × `onRetry`, and exactly one terminal event
 * (`onResponse` or `onError`).
 */
export interface FetcherEvents {
	/** PER ATTEMPT — before each attempt's I/O, including attempt 1. */
	onRequest?(req: FetchRequest, info: { requestId: string; attempt: number }): void;
	/** PER LOGICAL REQUEST — once, with the final aggregate result. */
	onResponse?(res: FetchResult): void;
	/** PER SCHEDULED RETRY — an attempt failed and another one will run. */
	onRetry?(info: RetryInfo): void;
	/** PER LOGICAL REQUEST — once, on final failure. */
	onError?(err: PageFetchError, req: FetchRequest): void;
	/** On breaker state transition (host-level, not per request). */
	onCircuitOpen?(info: { host: string; until: number; requestId?: string }): void;
}

/**
 * Cross-cutting options accepted by every layer factory, every adapter and
 * `createFetcher`.
 *
 * The two channels are complementary: `events` is the machine channel with defined
 * granularity, `logger` the human one. Errors are thrown (and reported via `onError`) —
 * inner layers never also log them at `error` level, so nothing double-reports.
 */
export interface ObservabilityOptions {
	/** Console-compatible logger. Default: `undefined`, i.e. silent. */
	logger?: Logger;
	/** Event sink. Default: `undefined`, i.e. no events. */
	events?: FetcherEvents;
}

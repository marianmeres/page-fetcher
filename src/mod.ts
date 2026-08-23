/**
 * `@marianmeres/page-fetcher` — fetch one web page by URL and get a normalized result,
 * whether the bytes came from a headless browser or a plain `fetch`.
 *
 * This is the transport layer: it knows nothing about links, recursion, sites or
 * crawling. Every layer is a `(next: FetchFn) => FetchFn` function, composable by hand;
 * `createFetcher` is only the convenience that wires the default stack.
 *
 * Adapters live in `@marianmeres/page-fetcher/adapters`, the cache layer in
 * `@marianmeres/page-fetcher/cache`.
 *
 * @module
 */

export { defaultRetryable, PageFetchError } from "./errors.ts";
export type { PageFetchErrorInit, PageFetchErrorKind } from "./errors.ts";

export {
	createCircuitBreaker,
	DEFAULT_CIRCUIT_COOLDOWN,
	DEFAULT_CIRCUIT_THRESHOLD,
	defaultIsFailure,
} from "./circuit-breaker.ts";
export type {
	CircuitBreakerOptions,
	CircuitState,
	CircuitStateChange,
} from "./circuit-breaker.ts";

// the cache *implementation* lives in the `/cache` subpath; only the types needed to
// spell `createFetcher({ cache })` are re-exported here
export type {
	CachedEntry,
	CacheLayerOptions,
	CacheMode,
	CacheStore,
} from "./cache/types.ts";

export { compose } from "./compose.ts";

export { createEventsLayer, safeEmit } from "./events.ts";

export { createFetcher } from "./fetcher.ts";
export type { CreateFetcherOptions, Fetcher } from "./fetcher.ts";

export { composeSignal, deadlineGuard, httpErrorGuard, timeoutGuard } from "./guards.ts";
export type {
	DeadlineGuardOptions,
	HttpErrorGuardOptions,
	TimeoutGuardOptions,
} from "./guards.ts";

export { createRetry, defaultIsRetryable, parseRetryAfter } from "./retry.ts";
export type { BackoffStrategy, RetryOptions } from "./retry.ts";

export { resolveDeadline, sleep } from "./utils.ts";

export type {
	Adapter,
	BodyAbsentReason,
	BodyFactory,
	FetcherEvents,
	FetchFn,
	FetchLayer,
	FetchRequest,
	FetchResult,
	FetchTiming,
	HttpMethod,
	Logger,
	ObservabilityOptions,
	ReplayableBody,
	RetryInfo,
	RetryOutcome,
	UnsupportedTypePolicy,
} from "./types.ts";

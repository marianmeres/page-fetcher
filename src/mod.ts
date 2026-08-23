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

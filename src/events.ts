/**
 * The events layer and the emission helper every layer uses.
 *
 * Event granularity is a contract, not an implementation detail, so it is worth stating
 * where each event comes from. For one logical request with N attempts:
 *
 * | Event           | Emitted by     | How often                                 |
 * | --------------- | -------------- | ----------------------------------------- |
 * | `onRequest`     | retry layer    | N — once before every attempt's I/O       |
 * | `onRetry`       | retry layer    | N−1 — once per scheduled retry            |
 * | `onCircuitOpen` | breaker layer  | only on transitions into `open`           |
 * | `onResponse`    | **this layer** | exactly 1, with the final result          |
 * | `onError`       | **this layer** | exactly 1, on final failure               |
 *
 * Hence the placement: the attempt-level events belong to the layer that owns the
 * attempt loop, while the terminal pair belongs to a layer sitting **above** retry —
 * which is what makes "exactly one terminal event per logical request" true rather than
 * aspirational. It sits **below** the circuit breaker on purpose: a refused request
 * never touched the network and deliberately emits nothing but `onCircuitOpen` at the
 * transition, so an open circuit under load cannot turn into an event storm.
 *
 * It sits below the **cache** for the same reason, and that has a consequence callers
 * must know about: a request the cache answers by itself never reaches this layer, so it
 * emits nothing — and a 304 revalidation emits `onResponse` with the raw 304, even though
 * the caller receives the synthesized stored result. `FetchResult.fromCache` is the
 * reliable way to count hits.
 *
 * @module
 */

import { PageFetchError } from "./errors.ts";
import { ensureRequestId } from "./internal.ts";
import type {
	FetchFn,
	FetchLayer,
	FetchRequest,
	FetchResult,
	Logger,
	ObservabilityOptions,
} from "./types.ts";

/**
 * Call an event handler without ever letting it affect the fetch.
 *
 * Handlers are synchronous fire-and-forget: a returned promise is not awaited, and a
 * throwing handler is reported via `logger.warn` (when one was injected) and otherwise
 * swallowed. A buggy `onResponse` must not turn a successful fetch into a failure.
 *
 * Use it for every user-supplied callback in a custom layer, not just for the
 * `FetcherEvents` handlers.
 */
export function safeEmit<A extends unknown[]>(
	handler: ((...args: A) => void) | undefined,
	logger: Logger | undefined,
	...args: A
): void {
	if (!handler) return;
	try {
		handler(...args);
	} catch (e) {
		logger?.warn(`event handler threw: ${e}`);
	}
}

/**
 * Emit the terminal event pair — `onResponse` on success, `onError` on failure —
 * exactly once per logical request.
 *
 * A non-`PageFetchError` throw (a `TypeError` from a misconfigured stack, say) is a
 * programmer error rather than a fetch outcome: it passes through unannounced, because
 * `onError` promises callers a `PageFetchError`.
 *
 * @example
 * ```ts
 * import { compose, createEventsLayer, createRetry } from "@marianmeres/page-fetcher";
 * import { createHttpAdapter } from "@marianmeres/page-fetcher/adapters";
 *
 * const fetchFn = compose([
 * 	createEventsLayer({ events: { onResponse: (r) => console.log(r.status) } }),
 * 	createRetry(),
 * ], createHttpAdapter().fetch);
 * ```
 */
export function createEventsLayer(options: ObservabilityOptions = {}): FetchLayer {
	const { events, logger } = options;

	return (next: FetchFn): FetchFn =>
	async (input: FetchRequest): Promise<FetchResult> => {
		const req = ensureRequestId(input);
		try {
			const res = await next(req);
			safeEmit(events?.onResponse, logger, res);
			return res;
		} catch (e) {
			if (PageFetchError.is(e)) safeEmit(events?.onError, logger, e, req);
			throw e;
		}
	};
}

/**
 * The composition primitive.
 *
 * There is no plugin registry and no class hierarchy here: a layer is a function
 * `(next: FetchFn) => FetchFn`, and a stack is those functions folded over a terminal
 * `FetchFn`. `createFetcher` is nothing but a preconfigured call to {@linkcode compose}.
 *
 * @module
 */

import type { FetchFn, FetchLayer } from "./types.ts";

/**
 * Fold layers over a terminal `FetchFn`. Layers are listed **outermost first**, the way
 * they are drawn in a stack diagram: `compose([a, b], t)` builds `a(b(t))`, so `a` sees
 * the request first and the response last.
 *
 * The direction is the whole reason this is exported — a hand-rolled `reduce` gets it
 * backwards half the time, and a stack with retry and the timeout guard swapped still
 * "works", it just stops re-arming the timeout per attempt.
 *
 * @example
 * ```ts
 * const fetchFn = compose(
 * 	[createCircuitBreaker(), createRetry({ attempts: 4 }), timeoutGuard()],
 * 	adapter.fetch,
 * );
 * ```
 */
export function compose(layers: FetchLayer[], terminal: FetchFn): FetchFn {
	return layers.reduceRight<FetchFn>((next, layer) => layer(next), terminal);
}

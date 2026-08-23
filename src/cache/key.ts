/**
 * Cache key derivation.
 *
 * The key derives from the **request only** — never from the response. Adapter routing
 * can be dynamic (`selectAdapter(req)`), and it resolves *below* the cache layer, so the
 * adapter that actually produced a response is unknowable at lookup time; keying a `set`
 * on it would produce entries no `get` could ever find.
 *
 * @module
 */

import type { FetchRequest } from "../types.ts";

/**
 * The default key: `` `${req.adapter ?? "*"}:GET:${req.url}` ``, or `undefined` for
 * anything that must not be cached.
 *
 * - **GET only.** Every other method returns `undefined` and passes through the layer
 *   untouched. HEAD is deliberately included in that: a cached HEAD entry would be
 *   bodyless, which breaks the `CachedEntry` invariant, and HEAD is cheap by
 *   construction. The method stays in the key string anyway, so widening this later
 *   needs no migration.
 * - **The requested adapter, not the resolved one** (see the module note). When routing
 *   is dynamic, results from different adapters for the same URL share a key — bake your
 *   routing rule into a custom `key` if that matters to you.
 * - **The URL goes in verbatim.** No normalization: `?a=1&b=2` and `?b=2&a=1` are two
 *   keys. URL canonicalization is the crawler's job, not the transport's.
 * - **`Vary` is out of scope.** Two requests for one URL with different
 *   `Accept-Language` hit the same entry. A custom `key` that folds the relevant request
 *   headers in is the escape hatch.
 *
 * @example
 * ```ts
 * cacheKey({ url: "https://example.com/" });                    // "*:GET:https://example.com/"
 * cacheKey({ url: "https://example.com/", adapter: "browser" }); // "browser:GET:https://example.com/"
 * cacheKey({ url: "https://example.com/", method: "POST" });     // undefined
 * ```
 */
export function cacheKey(req: FetchRequest): string | undefined {
	const method = req.method ?? "GET";
	if (method !== "GET") return undefined;
	return `${req.adapter ?? "*"}:${method}:${req.url}`;
}

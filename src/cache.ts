/**
 * The optional cache layer — off unless you hand `createFetcher` a store.
 *
 * Two modes through one interface:
 *
 * - **`"dev"`** — serve any hit, ignore freshness. The mode you want while iterating on
 *   extraction code: crawl once, then run a hundred times without touching the origin.
 * - **`"conditional"`** (default) — revalidate with `If-None-Match` / `If-Modified-Since`
 *   and resolve a 304 into the stored body. Still a round trip, but a cheap one, and
 *   correct against a live origin.
 *
 * It is **not** an RFC 9111 HTTP cache: no `Cache-Control` freshness parsing, no
 * heuristic freshness, no `Vary`, no `stale-while-revalidate`, no `stale-if-error`. `ttl`
 * is caller policy. See {@linkcode createCacheLayer} for the full scope statement.
 *
 * Flat barrel, kept in sync with the `deno.json` exports map and the npm build's entry
 * points.
 *
 * @example
 * ```ts
 * import { createFetcher } from "@marianmeres/page-fetcher";
 * import { createMemoryCache } from "@marianmeres/page-fetcher/cache";
 *
 * await using fetcher = createFetcher({
 * 	cache: { store: createMemoryCache({ maxEntries: 500 }), mode: "dev" },
 * });
 * ```
 *
 * @module
 */

export { cacheKey } from "./cache/key.ts";

export { createCacheLayer, defaultIsCacheable } from "./cache/layer.ts";

export { createMemoryCache, DEFAULT_MAX_ENTRIES } from "./cache/memory.ts";
export type { MemoryCache, MemoryCacheOptions } from "./cache/memory.ts";

export { deserializeCachedEntry, serializeCachedEntry } from "./cache/serialize.ts";

export { CACHE_ENTRY_VERSION } from "./cache/types.ts";
export type {
	CachedEntry,
	CacheLayerOptions,
	CacheMode,
	CacheStore,
} from "./cache/types.ts";

/**
 * The in-process cache store: a `Map` with LRU eviction and no timers.
 *
 * `Map` iteration order is insertion order (guaranteed by the language spec), so
 * "delete + re-set on every hit" gives real LRU behavior in a handful of lines — the
 * cheapest correct bound, and no dependency.
 *
 * There is deliberately **no background TTL sweeper**. A library has no business owning a
 * `setInterval` (Deno's test sanitizers flag leaked timers, and so should you); freshness
 * is layer policy anyway, expired entries are simply overwritten, and memory is bounded
 * by `maxEntries` regardless.
 *
 * @module
 */

import type { CachedEntry, CacheStore } from "./types.ts";
import type { Logger } from "../types.ts";

/** Default {@linkcode MemoryCacheOptions.maxEntries}. */
export const DEFAULT_MAX_ENTRIES = 1000;

/** Options of {@linkcode createMemoryCache}. */
export interface MemoryCacheOptions {
	/**
	 * Maximum entries kept; the least recently used is evicted first. Default `1000`.
	 *
	 * Size this to your corpus, and do the memory math honestly: 1000 entries at ~100 KB
	 * a page is ~100 MB, and with bodies at the HTTP adapter's 10 MB `maxBytes` ceiling
	 * the worst case is 10 GB. If that is your shape, write a persistent store instead
	 * (see `serializeCachedEntry`).
	 */
	maxEntries?: number;
	/** Console-compatible logger; debug-logs evictions. Default: silent. */
	logger?: Logger;
}

/** A {@linkcode CacheStore} backed by a bounded in-process `Map`. */
export interface MemoryCache extends CacheStore {
	/** Current entry count. Bodies dominate the actual memory, not this number. */
	readonly size: number;
	/** Drop everything. */
	clear(): void;
}

/**
 * Build an in-process LRU cache store.
 *
 * Entries are stored and returned **by reference** — no `structuredClone`, because
 * copying multi-MB bodies on every operation is exactly the cost the cache exists to
 * avoid. Treat a retrieved entry (its `body` above all) as read-only shared memory.
 *
 * @example
 * ```ts
 * import { createFetcher } from "@marianmeres/page-fetcher";
 * import { createMemoryCache } from "@marianmeres/page-fetcher/cache";
 *
 * const store = createMemoryCache({ maxEntries: 200 });
 * await using fetcher = createFetcher({ cache: { store, mode: "dev" } });
 * ```
 */
export function createMemoryCache(options: MemoryCacheOptions = {}): MemoryCache {
	const { maxEntries = DEFAULT_MAX_ENTRIES, logger } = options;
	if (!(maxEntries >= 1)) {
		throw new TypeError("createMemoryCache: `maxEntries` must be >= 1");
	}

	const map = new Map<string, CachedEntry>();

	return {
		get size(): number {
			return map.size;
		},

		get(key: string): Promise<CachedEntry | undefined> {
			const entry = map.get(key);
			if (entry !== undefined) {
				// touch: move to the end, so the front stays the eviction candidate
				map.delete(key);
				map.set(key, entry);
			}
			return Promise.resolve(entry);
		},

		set(key: string, entry: CachedEntry): Promise<void> {
			// delete first even on a replace, so the key moves to the end
			map.delete(key);
			map.set(key, entry);
			while (map.size > maxEntries) {
				const oldest = map.keys().next();
				if (oldest.done) break;
				map.delete(oldest.value);
				logger?.debug(`[cache] evict ${oldest.value}`);
			}
			return Promise.resolve();
		},

		delete(key: string): Promise<void> {
			map.delete(key);
			return Promise.resolve();
		},

		clear(): void {
			map.clear();
		},
	};
}

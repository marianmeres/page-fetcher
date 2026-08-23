/**
 * The cache layer's type surface: the stored entry, the store contract, and the layer's
 * options.
 *
 * The shape of {@linkcode CachedEntry} is driven by one requirement — a *persistent*
 * store must be able to implement it. That rules out the obvious "just stash the
 * `FetchResult`" design twice over: `JSON.stringify(new Headers({...}))` is `"{}"` (every
 * header, including the validators the conditional mode needs, silently vanishes) and
 * `JSON.stringify(new Uint8Array([1,2,3]))` is `{"0":1,"1":2,"2":3}`. So headers travel
 * as a plain lowercase-keyed record and the body travels as raw bytes the store is
 * expected to keep out-of-band (see `serializeCachedEntry`).
 *
 * @module
 */

import type { FetchRequest, FetchResult, Logger } from "../types.ts";

/** Current {@linkcode CachedEntry} format version. */
export const CACHE_ENTRY_VERSION = 1;

/**
 * One stored response.
 *
 * Everything except {@linkcode CachedEntry.body} is JSON-serializable by construction.
 * Deliberately absent: `meta` (a per-request caller payload, echoed from the *live*
 * request at synthesis time) and `extra` (adapter-specific, frequently not serializable
 * at all — browser handles and the like).
 */
export interface CachedEntry {
	/**
	 * Entry format version. A store that finds an unknown version should drop the entry
	 * rather than guess; a future `v: 2` makes this a discriminated union.
	 */
	v: typeof CACHE_ENTRY_VERSION;
	/** The requested URL (the URL component of the key). */
	url: string;
	/** URL of the final response, after redirects. */
	finalUrl: string;
	/** Redirect chain of the stored response, in visit order. */
	redirects: string[];
	/** Stored HTTP status. The default policy stores 200 only; the field is general. */
	status: number;
	/** Stored status text, when the transport reported one. */
	statusText?: string;
	/**
	 * Response headers as a plain, lowercase-keyed record (`Headers` is not
	 * JSON-serializable). `set-cookie` is stripped at store time — iterating `Headers`
	 * would keep only the last one anyway, and a shared cache has no business holding
	 * someone's cookies.
	 */
	headers: Record<string, string>;
	/**
	 * Raw body bytes. **Not** JSON-serializable — persistent stores keep this half
	 * out-of-band (see `serializeCachedEntry`).
	 */
	body: Uint8Array;
	/** Resolved mime, copied from the result so synthesis never re-sniffs. */
	contentType?: string;
	/** Charset label the body was decoded with, same reason. */
	charset?: string;
	/** Body length in bytes. */
	size: number;
	/** Adapter that produced the original response (provenance). */
	adapter: string;
	/** `headers["etag"]`, lifted out for convenience. */
	etag?: string;
	/** `headers["last-modified"]`, lifted out for convenience. */
	lastModified?: string;
	/** Epoch ms when the entry was stored or last revalidated. `ttl` math anchors here. */
	storedAt: number;
}

/**
 * A dumb async key-value store. It never inspects entries and knows nothing about
 * freshness, modes or TTLs — all policy lives in the layer.
 *
 * Implement it over anything: a `Map` ({@linkcode createMemoryCache}), the filesystem,
 * SQLite, Redis. `get` must resolve `undefined` for a miss, never throw for one.
 */
export interface CacheStore {
	/** Resolve the entry stored under `key`, or `undefined`. */
	get(key: string): Promise<CachedEntry | undefined>;
	/** Store (or replace) the entry under `key`. */
	set(key: string, entry: CachedEntry): Promise<void>;
	/** Remove `key`. A no-op for a key that is not there. */
	delete(key: string): Promise<void>;
}

/**
 * How the layer treats a hit.
 *
 * - `"dev"` — serve any hit, ignoring freshness entirely (with a `ttl`, any hit younger
 *   than it). The "iterate on my extraction code without re-crawling" mode.
 * - `"conditional"` — revalidate with `If-None-Match` / `If-Modified-Since` and resolve a
 *   304 into the stored body. Correct against a live origin, still costs a round trip.
 */
export type CacheMode = "dev" | "conditional";

/** Options of `createCacheLayer`. */
export interface CacheLayerOptions {
	/** Where entries live. Required — there is no implicit default store. */
	store: CacheStore;
	/** Default `"conditional"`, the correct-by-default mode. */
	mode?: CacheMode;
	/**
	 * Freshness window in ms, anchored at {@linkcode CachedEntry.storedAt}.
	 *
	 * - `"dev"`: entries older than `ttl` are refetched. No `ttl` ⇒ serve forever.
	 * - `"conditional"`: entries younger than `ttl` are served **without** revalidation
	 *   (a caller-driven `max-age`). No `ttl` ⇒ revalidate on every request.
	 */
	ttl?: number;
	/**
	 * Key override. Return `undefined` to bypass caching for a request entirely.
	 * Default: `cacheKey`.
	 */
	key?(req: FetchRequest): string | undefined;
	/**
	 * Which live results get stored. Default: `defaultIsCacheable` (status 200 and no
	 * `Cache-Control: no-store`). Replaces the default entirely — wrap it to extend.
	 *
	 * A result with no readable body is never stored whatever this returns: an entry
	 * without bytes cannot be synthesized back into a result.
	 */
	isCacheable?(res: FetchResult): boolean;
	/** Console-compatible logger. Default: `undefined`, i.e. silent. */
	logger?: Logger;
}

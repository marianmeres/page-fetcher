/**
 * `createCacheLayer` — one wrapper, two modes, and the full 304 flow.
 *
 * **This is not an RFC 9111 HTTP cache**, and pretending otherwise would be the worst
 * thing it could do. It parses no `Cache-Control` freshness directives, computes no
 * heuristic freshness, honors no `Vary`, and does no `stale-while-revalidate`. `ttl` is
 * *your* policy, not the origin's. The only header-derived behaviors are the validators
 * (`ETag` / `Last-Modified`) and one `no-store` courtesy check.
 *
 * Placement: outermost. A hit must cost nothing and depend on nothing — not on an open
 * circuit, not on a deadline, not on the retry budget. Anything it *does* forward goes
 * down the ordinary stack, so a revalidation is retried, timed out and counted exactly
 * like any other request.
 *
 * One consequence worth stating loudly: enabling this layer forces full body retention in
 * memory for every cacheable response, because storing an entry means reading the bytes.
 * That is inherent to caching, not a defect.
 *
 * @module
 */

import { createBodyResult, ensureRequestId } from "../internal.ts";
import type {
	FetchFn,
	FetchLayer,
	FetchRequest,
	FetchResult,
	FetchTiming,
} from "../types.ts";
import { cacheKey } from "./key.ts";
import {
	CACHE_ENTRY_VERSION,
	type CachedEntry,
	type CacheLayerOptions,
} from "./types.ts";

/**
 * Request headers that make the layer step aside entirely: the caller is running its own
 * conditional or partial-content dance, and answering it from our store would be wrong.
 */
const BYPASS_HEADERS = ["if-none-match", "if-modified-since", "range"];

/** Headers never merged from a 304 into the stored entry. */
const NEVER_FRESHEN = ["content-length"];

/**
 * The default cacheability policy: status 200, and the origin did not say `no-store`.
 *
 * Only 200 — not 2xx-wide, because 204/206 are bodyless/partial and 201 & co. are non-GET
 * territory the layer never reaches anyway. Negative caching is a one-liner override:
 * `isCacheable: (res) => res.status === 200 || res.status === 404` works today, since
 * entries carry a general `status` and synthesis replays whatever was stored.
 */
export function defaultIsCacheable(res: FetchResult): boolean {
	if (res.status !== 200) return false;
	const cc = res.headers.get("cache-control")?.toLowerCase() ?? "";
	// not `includes("no-store")`: that false-positives on `no-store-policy` extensions
	return !/(^|[\s,])no-store($|[\s,=])/.test(cc);
}

/** `Headers` → plain lowercase-keyed record, minus `set-cookie`. */
function plainHeaders(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of headers) {
		// iteration yields set-cookie entries individually, so fromEntries would keep
		// only the last one — and a shared cache should not hold cookies at all
		if (k === "set-cookie") continue;
		out[k] = v;
	}
	return out;
}

/** The bypass header a request carries, if any (matched case-insensitively). */
function bypassHeader(headers: Record<string, string> | undefined): string | undefined {
	for (const k of Object.keys(headers ?? {})) {
		const lower = k.toLowerCase();
		if (BYPASS_HEADERS.includes(lower)) return lower;
	}
	return undefined;
}

/** Turn a live result into a storable entry. Reads (and therefore buffers) the body. */
async function entryFromResult(
	res: FetchResult,
	req: FetchRequest,
): Promise<CachedEntry> {
	const body = await res.bytes();
	const headers = plainHeaders(res.headers);
	return {
		v: CACHE_ENTRY_VERSION,
		url: req.url,
		finalUrl: res.finalUrl,
		redirects: res.redirects,
		status: res.status,
		statusText: res.statusText,
		headers,
		body,
		contentType: res.contentType,
		charset: res.charset,
		size: res.size ?? body.length,
		adapter: res.adapter,
		etag: headers["etag"],
		lastModified: headers["last-modified"],
		storedAt: Date.now(),
	};
}

/**
 * RFC 9111 §4.3.4-lite: merge a 304's headers over the stored ones and restamp the
 * entry. The body, status and redirect chain are exactly what the 304 promises they still
 * are — the stored ones.
 */
function freshen(entry: CachedEntry, res: FetchResult): CachedEntry {
	const incoming = plainHeaders(res.headers);
	for (const skip of NEVER_FRESHEN) delete incoming[skip];
	const headers = { ...entry.headers, ...incoming };
	return {
		...entry,
		headers,
		etag: headers["etag"],
		lastModified: headers["last-modified"],
		storedAt: Date.now(),
	};
}

/**
 * Synthesize a {@linkcode FetchResult} from a stored entry.
 *
 * `meta` is echoed from the **live** request, never from the entry (it is a per-request
 * caller payload). `extra` is absent — whatever the originating adapter attached was
 * about that fetch, not about this one.
 */
function entryToResult(
	entry: CachedEntry,
	req: FetchRequest & { requestId: string },
	o: { notModified: boolean; attempts: number; timing: FetchTiming; adapter?: string },
): FetchResult {
	const body = createBodyResult(entry.body, {
		url: req.url,
		requestId: req.requestId,
		charset: entry.charset,
	});
	return {
		ok: entry.status >= 200 && entry.status < 300,
		url: req.url,
		finalUrl: entry.finalUrl,
		status: entry.status,
		statusText: entry.statusText,
		headers: new Headers(entry.headers),
		redirects: entry.redirects,
		requestId: req.requestId,
		hasBody: body.hasBody,
		text: body.text,
		bytes: body.bytes,
		contentType: entry.contentType,
		charset: entry.charset,
		size: entry.size,
		fromCache: true,
		notModified: o.notModified,
		timing: o.timing,
		attempts: o.attempts,
		// provenance beats a "cache" sentinel — `fromCache` already flags the hit
		adapter: o.adapter ?? entry.adapter,
		meta: req.meta,
	};
}

/**
 * Cache GET responses, in one of two modes.
 *
 * | Scenario                                  | `fromCache` | `notModified` | `attempts`    | `timing`         | `adapter`      |
 * | ----------------------------------------- | ----------- | ------------- | ------------- | ---------------- | -------------- |
 * | Live network fetch                        | `false`     | `false`       | real, ≥1      | real             | resolved       |
 * | Pure hit (dev, or conditional within ttl) | `true`      | `false`       | **0**         | store-lookup     | entry's        |
 * | 304 revalidation                          | `true`      | `true`        | revalidation's| revalidation's   | revalidation's |
 * | Fresh 200 stored this request             | `false`     | `false`       | real          | real             | resolved       |
 *
 * `attempts: 0` on a pure hit is the honest number — zero network attempts were made. A
 * 304's `attempts` and `timing` are real, because a conditional request genuinely hit the
 * network; only the content comes from the (freshened) entry.
 *
 * Errors from below propagate unchanged: the layer never converts an error, and never
 * serves a hit to paper over one. There is no `stale-if-error` in v1.
 *
 * @example
 * ```ts
 * const fetchFn = createCacheLayer({
 * 	store: createMemoryCache(),
 * 	mode: "dev",          // serve any hit, ignore freshness
 * 	ttl: 3_600_000,       // ...younger than an hour
 * })(adapter.fetch);
 * ```
 */
export function createCacheLayer(options: CacheLayerOptions): FetchLayer {
	const {
		store,
		mode = "conditional",
		ttl,
		key: keyOf = cacheKey,
		isCacheable = defaultIsCacheable,
		logger,
	} = options;

	if (!store) throw new TypeError("createCacheLayer: `store` is required");

	/**
	 * A broken store degrades to a bypass rather than taking fetching down with it — a
	 * cache is an optimization, and a failing disk should not stop a crawl.
	 */
	async function safeGet(key: string): Promise<CachedEntry | undefined> {
		try {
			return await store.get(key);
		} catch (e) {
			logger?.warn(`[cache] ${key}: store.get failed, bypassing: ${e}`);
			return undefined;
		}
	}

	async function safeSet(key: string, entry: CachedEntry): Promise<void> {
		try {
			await store.set(key, entry);
		} catch (e) {
			logger?.warn(`[cache] ${key}: store.set failed, not stored: ${e}`);
		}
	}

	/** Store a live result when policy and shape allow it. Never throws. */
	async function maybeStore(
		key: string,
		res: FetchResult,
		req: FetchRequest,
		label: string,
	): Promise<void> {
		if (!isCacheable(res)) {
			logger?.debug(`[cache] ${key}: ${label} → not cacheable (${res.status})`);
			return;
		}
		if (!res.hasBody) {
			// a custom isCacheable cannot conjure bytes that were never retained
			logger?.debug(`[cache] ${key}: ${label} → not cacheable (no body)`);
			return;
		}
		try {
			await safeSet(key, await entryFromResult(res, req));
			logger?.debug(`[cache] ${key}: ${label} → stored`);
		} catch (e) {
			logger?.warn(`[cache] ${key}: could not read body for storage: ${e}`);
		}
	}

	return (next: FetchFn): FetchFn =>
	async (input: FetchRequest): Promise<FetchResult> => {
		const req = ensureRequestId(input);

		const key = keyOf(req);
		if (key === undefined) {
			logger?.debug(`[cache] bypass (uncacheable request) ${req.url}`);
			return await next(req);
		}
		const bypass = bypassHeader(req.headers);
		if (bypass) {
			logger?.debug(`[cache] ${key}: bypass (request carries ${bypass})`);
			return await next(req);
		}
		if (req.retainBody === false) {
			// the caller explicitly asked for no body; serving one from the store would
			// contradict that, and a bodyless result is not storable either way
			logger?.debug(`[cache] ${key}: bypass (retainBody: false)`);
			return await next(req);
		}

		const startedAt = Date.now();
		const entry = await safeGet(key);

		if (entry) {
			const age = startedAt - entry.storedAt;
			const fresh = mode === "dev"
				? ttl === undefined || age < ttl
				: ttl !== undefined && age < ttl;
			if (fresh) {
				const endedAt = Date.now();
				logger?.debug(
					`[cache] ${key}: hit (${mode}${ttl === undefined ? "" : ", ttl"})`,
				);
				return entryToResult(entry, req, {
					notModified: false,
					attempts: 0,
					timing: { startedAt, endedAt, total: endedAt - startedAt },
				});
			}
		}

		// ---- conditional revalidation ------------------------------------------
		if (mode === "conditional" && entry && (entry.etag || entry.lastModified)) {
			const headers = { ...req.headers };
			// both when both are known: RFC 9110 §13.1.3 has the recipient ignore
			// If-Modified-Since in that case, so the ETag simply wins
			if (entry.etag) headers["if-none-match"] = entry.etag;
			if (entry.lastModified) headers["if-modified-since"] = entry.lastModified;

			const res = await next({ ...req, headers });

			if (res.status === 304) {
				const freshened = freshen(entry, res);
				await safeSet(key, freshened);
				logger?.debug(`[cache] ${key}: revalidate → 304 (freshened)`);
				return entryToResult(freshened, req, {
					notModified: true,
					attempts: res.attempts,
					timing: res.timing,
					adapter: res.adapter,
				});
			}
			// anything else — including a 5xx — is returned as-is, and the stored entry
			// stays exactly where it is: a flaky origin must not evict a good cache
			await maybeStore(key, res, req, "revalidate → replaced");
			return res;
		}

		// ---- miss, dev-expired, or an entry with no validators -------------------
		const res = await next(req);
		await maybeStore(key, res, req, "miss");
		return res;
	};
}

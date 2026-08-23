/**
 * Split a {@linkcode CachedEntry} into the two halves a persistent store needs, and put
 * it back together.
 *
 * These two functions are the whole contract for backing the cache with the filesystem,
 * SQLite, Redis or anything else — and they exist so nobody re-discovers the two traps
 * `types.ts` opens with (`Headers` and `Uint8Array` both JSON-stringify to garbage).
 * They hash nothing and encode nothing: bytes are handed back raw, so the store picks its
 * own encoding (a BLOB column, a sibling file, base64 — its call).
 *
 * @module
 */

import { PageFetchError } from "../errors.ts";
import { CACHE_ENTRY_VERSION, type CachedEntry } from "./types.ts";

/**
 * Split an entry into a JSON string (everything but the body) and the raw body bytes.
 *
 * @example
 * ```ts
 * import { serializeCachedEntry } from "@marianmeres/page-fetcher/cache";
 * import type { CacheStore } from "@marianmeres/page-fetcher/cache";
 *
 * // one half of a filesystem-backed store (hash the key yourself if it must be a
 * // filename — these helpers deliberately do no hashing)
 * const set: CacheStore["set"] = async (key, entry) => {
 * 	const { meta, body } = serializeCachedEntry(entry);
 * 	await Deno.writeTextFile(`./cache/${key}.json`, meta);
 * 	await Deno.writeFile(`./cache/${key}.bin`, body);
 * };
 * ```
 */
export function serializeCachedEntry(
	entry: CachedEntry,
): { meta: string; body: Uint8Array } {
	const { body, ...rest } = entry;
	return { meta: JSON.stringify(rest), body };
}

/**
 * Inverse of {@linkcode serializeCachedEntry}.
 *
 * Rejects anything it cannot vouch for — malformed JSON, a non-object, or an entry
 * version this build does not know — by throwing `PageFetchError` `kind: "decode"`. A
 * store should treat that as a miss (drop the row and refetch), not as a fatal error.
 */
export function deserializeCachedEntry(meta: string, body: Uint8Array): CachedEntry {
	let parsed: unknown;
	try {
		parsed = JSON.parse(meta);
	} catch (e) {
		throw new PageFetchError({
			kind: "decode",
			url: "",
			message: `Cached entry metadata is not valid JSON: ${e}`,
			cause: e,
		});
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new PageFetchError({
			kind: "decode",
			url: "",
			message: "Cached entry metadata is not an object",
		});
	}
	const entry = parsed as Omit<CachedEntry, "body">;
	if (entry.v !== CACHE_ENTRY_VERSION) {
		throw new PageFetchError({
			kind: "decode",
			url: typeof entry.url === "string" ? entry.url : "",
			message: `Unsupported cached entry version ${
				JSON.stringify(entry.v)
			} (expected ${CACHE_ENTRY_VERSION})`,
			details: { version: entry.v, expected: CACHE_ENTRY_VERSION },
		});
	}
	return { ...entry, body };
}

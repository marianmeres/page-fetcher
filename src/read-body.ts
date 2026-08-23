/**
 * Streaming body reader with a hard byte budget.
 *
 * This is a helper, not a `(next: FetchFn) => FetchFn` layer: enforcing `maxBytes`
 * requires access to the body *stream*, which only exists inside the adapter, between
 * the headers arriving and the body being read. A wrapper would only ever see a
 * finished result — by which point the oversized download already happened.
 *
 * @module
 */

import { PageFetchError } from "./errors.ts";
import { abortErrorFrom } from "./internal.ts";
import type { Logger } from "./types.ts";

/** Options of {@linkcode readBodyLimited}. */
export interface ReadBodyOptions {
	/**
	 * Maximum number of **decoded** bytes to accept.
	 *
	 * Decoded, not wire bytes: the platform transparently decompresses, so a gzipped
	 * response yields more bytes from the reader than `Content-Length` advertises.
	 */
	maxBytes: number;
	/** URL, for error construction. */
	url: string;
	/** Correlation id, for error construction. */
	requestId?: string;
	/** Observed between chunks, so an abort mid-body is noticed promptly. */
	signal?: AbortSignal;
	/** Silent by default. */
	logger?: Logger;
}

/**
 * Read a response body into memory, aborting as soon as `maxBytes` is exceeded.
 *
 * @returns the collected bytes (empty when `body` is `null`, i.e. HEAD / 204 / 304)
 * @throws {PageFetchError} `kind: "too-large"` when the budget is blown, or
 * `kind: "aborted"` (or the signal's own reason) when the read was cancelled
 */
export async function readBodyLimited(
	body: ReadableStream<Uint8Array> | null,
	opts: ReadBodyOptions,
): Promise<Uint8Array> {
	if (body === null) return new Uint8Array(0);

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;

	try {
		while (true) {
			if (opts.signal?.aborted) {
				throw abortErrorFrom(opts.signal, {
					url: opts.url,
					requestId: opts.requestId,
				});
			}
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.length;
			if (total > opts.maxBytes) {
				opts.logger?.warn(
					`maxBytes exceeded (${total} > ${opts.maxBytes}) reading ${opts.url}`,
				);
				throw new PageFetchError({
					kind: "too-large",
					url: opts.url,
					requestId: opts.requestId,
					retryable: false,
					message:
						`Response body exceeded maxBytes (${opts.maxBytes}) fetching ${opts.url}`,
					details: { maxBytes: opts.maxBytes, read: total },
				});
			}
			chunks.push(value);
		}
	} finally {
		// cancel() is enough — it propagates to the underlying fetch connection; it is a
		// no-op on an already-finished stream
		await reader.cancel().catch(() => {});
	}

	if (chunks.length === 1) return chunks[0];
	const out = new Uint8Array(total);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.length;
	}
	return out;
}

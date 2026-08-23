/**
 * Shared runtime helpers used by every layer and adapter. Not part of the public
 * surface — nothing here is exported from `mod.ts`.
 *
 * @module
 */

import { PageFetchError } from "./errors.ts";
import type { BodyAbsentReason, FetchRequest } from "./types.ts";

/** A request that is guaranteed to carry a correlation id. */
export type IdentifiedRequest = FetchRequest & { requestId: string };

/**
 * Stamp a correlation id on the request unless it already has one.
 *
 * Every public layer factory and every adapter starts with this, so a standalone layer
 * behaves exactly like a composed stack. Idempotent (the outermost layer wins) and
 * never mutates the caller's object.
 */
export function ensureRequestId(req: FetchRequest): IdentifiedRequest {
	return req.requestId
		? req as IdentifiedRequest
		: { ...req, requestId: crypto.randomUUID() };
}

/** Short form used to prefix log lines. */
export function shortId(requestId: string | undefined): string {
	return requestId ? requestId.slice(0, 8) : "????????";
}

/** The `bytes()` / `text()` pair of a {@linkcode FetchResult}. */
export interface BodyAccessors {
	/** Whether body bytes were retained and are readable. */
	hasBody: boolean;
	/** Raw bytes, already in memory. */
	bytes(): Promise<Uint8Array>;
	/** Decoded text, memoized after the first call. */
	text(): Promise<string>;
}

/**
 * Build the body accessors every adapter must hand back, so the body contract (eager
 * bytes, lazy memoized decode) is implemented in exactly one place.
 *
 * Pass `null` for a knowingly absent body: both accessors then reject with
 * `kind: "no-body"` carrying `details.reason`, while the result itself still resolves
 * normally — body absence is never an error, only *reading* an absent body is.
 */
export function createBodyResult(
	bytes: Uint8Array | null,
	opts: {
		/** Requested URL, for error construction. */
		url: string;
		/** Correlation id, for error construction. */
		requestId?: string;
		/** Charset label to decode with. Must already be a label `TextDecoder` accepts. */
		charset?: string;
		/** Why the body is absent. Only meaningful when `bytes` is `null`. */
		absentReason?: BodyAbsentReason;
	},
): BodyAccessors {
	if (bytes === null) {
		const reject = (): Promise<never> =>
			Promise.reject(
				new PageFetchError({
					kind: "no-body",
					url: opts.url,
					requestId: opts.requestId,
					retryable: false,
					details: { reason: opts.absentReason ?? "retain-body" },
				}),
			);
		return { hasBody: false, bytes: reject, text: reject };
	}

	let decoded: string | undefined;
	return {
		hasBody: true,
		bytes: (): Promise<Uint8Array> => Promise.resolve(bytes),
		text: (): Promise<string> => {
			if (decoded === undefined) {
				decoded = decodeOrFallback(bytes, opts.charset ?? "utf-8");
			}
			return Promise.resolve(decoded);
		},
	};
}

/**
 * Decode with the given label, never throwing: an unsupported label falls back to
 * utf-8, and invalid byte sequences become U+FFFD (non-fatal decoding).
 */
function decodeOrFallback(bytes: Uint8Array, label: string): string {
	try {
		return new TextDecoder(label).decode(bytes);
	} catch {
		return new TextDecoder("utf-8").decode(bytes);
	}
}

/**
 * Turn an abort into the right {@linkcode PageFetchError}.
 *
 * The timeout and deadline guards abort with a `PageFetchError` as the abort *reason*
 * (`AbortSignal.any` adopts it), which is how the catch side tells "our timeout fired"
 * from "the caller cancelled". Anything else means the caller's own signal fired.
 */
export function abortErrorFrom(
	signal: AbortSignal | undefined,
	ctx: { url: string; requestId?: string; cause?: unknown },
): PageFetchError {
	const reason = signal?.reason;
	if (PageFetchError.is(reason)) return reason;
	return new PageFetchError({
		kind: "aborted",
		url: ctx.url,
		requestId: ctx.requestId,
		retryable: false,
		cause: reason ?? ctx.cause,
	});
}

/** Whether a thrown value is the platform's "the signal aborted" rejection. */
export function isAbortError(e: unknown): boolean {
	return e instanceof DOMException && e.name === "AbortError" ||
		(e instanceof Error && e.name === "AbortError");
}

/**
 * Copy of `err` with a different `attempts` count.
 *
 * `PageFetchError` fields are readonly, so the retry layer (and an adapter stamping its
 * single attempt) re-creates the error instead of mutating it.
 */
export function withAttempts(err: PageFetchError, attempts: number): PageFetchError {
	if (err.attempts === attempts) return err;
	return new PageFetchError({
		kind: err.kind,
		url: err.url,
		message: err.message,
		status: err.status,
		finalUrl: err.finalUrl,
		requestId: err.requestId,
		attempts,
		retryable: err.retryable,
		cause: err.cause,
		details: err.details,
	});
}

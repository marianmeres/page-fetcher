/**
 * The retry layer.
 *
 * Two things make this different from a naive retry wrapper. First, a non-2xx response
 * is *data* here (it resolves with `ok: false`), so the dominant retry trigger is a
 * **result**, not a thrown error — hence the `RetryOutcome` either/or pair everywhere.
 * Second, retrying never converts a result into a throw or vice versa: whatever the
 * last attempt produced is what the caller sees, with `attempts` stamped on it.
 *
 * @module
 */

import { defaultRetryable, PageFetchError } from "./errors.ts";
import { safeEmit } from "./events.ts";
import { ensureRequestId, shortId, withAttempts } from "./internal.ts";
import type {
	FetchFn,
	FetchLayer,
	FetchRequest,
	FetchResult,
	ObservabilityOptions,
	RetryInfo,
	RetryOutcome,
} from "./types.ts";
import { resolveDeadline, sleep } from "./utils.ts";

/** Backoff shapes. A function receives the 1-based attempt that just failed. */
export type BackoffStrategy =
	| "exponential"
	| "linear"
	| "fixed"
	| ((attempt: number) => number);

/** Options of {@linkcode createRetry}. */
export interface RetryOptions extends ObservabilityOptions {
	/** Total attempts including the first. Default `3`. */
	attempts?: number;
	/** Default `"exponential"`. */
	backoff?: BackoffStrategy;
	/** Base delay in ms. Default `500`. */
	baseDelay?: number;
	/** Upper bound for any single delay, `Retry-After` included. Default `30_000`. */
	maxDelay?: number;
	/** Full jitter (`random() * delay`). Default `true`; ignored for a function backoff. */
	jitter?: boolean;
	/** Honor a `Retry-After` response header. Default `true`. */
	respectRetryAfter?: boolean;
	/**
	 * Replaces the built-in classification entirely. Wrap
	 * {@linkcode defaultIsRetryable} to extend rather than replace it.
	 */
	isRetryable?(outcome: RetryOutcome, attempt: number, req: FetchRequest): boolean;
	/** Per-layer callback, fired just before the sleep. */
	onRetry?(info: RetryInfo): void;
}

/**
 * The built-in classification.
 *
 * - `POST` is never retried — it is not idempotent, and a silently duplicated write is
 *   worse than a failed one. Opt in with a custom `isRetryable`.
 * - A thrown error is retried per its own `retryable` flag (network / timeout / browser
 *   crashes yes; `too-large`, `unsupported-type`, `decode`, `too-many-redirects`,
 *   `circuit-open`, `aborted`, `deadline` no).
 * - A resolved result is retried for 408, 425, 429 and 5xx only.
 */
export function defaultIsRetryable(
	outcome: RetryOutcome,
	_attempt: number,
	req: FetchRequest,
): boolean {
	if ((req.method ?? "GET") === "POST") return false;
	if (outcome.error) return outcome.error.retryable;
	if (outcome.result) return defaultRetryable("http", outcome.result.status);
	return false;
}

/**
 * Parse a `Retry-After` header value into milliseconds from `now`.
 *
 * Accepts both forms — delay-seconds and an HTTP-date — and returns `undefined` for
 * anything unparseable, so the caller falls back to its own backoff.
 */
export function parseRetryAfter(
	value: string | null | undefined,
	now: number = Date.now(),
): number | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
	const at = Date.parse(trimmed);
	if (Number.isNaN(at)) return undefined;
	return Math.max(0, at - now);
}

/** Backoff for the attempt that just failed, before jitter and capping. */
function rawBackoff(
	strategy: BackoffStrategy,
	attempt: number,
	baseDelay: number,
): number {
	if (typeof strategy === "function") return strategy(attempt);
	switch (strategy) {
		case "linear":
			return baseDelay * attempt;
		case "fixed":
			return baseDelay;
		default:
			return baseDelay * 2 ** (attempt - 1);
	}
}

/**
 * Retry failed attempts with backoff.
 *
 * @example
 * ```ts
 * import { createRetry } from "@marianmeres/page-fetcher";
 * import { createHttpAdapter } from "@marianmeres/page-fetcher/adapters";
 *
 * const fetchFn = createRetry({ attempts: 4, baseDelay: 250 })(
 * 	createHttpAdapter().fetch,
 * );
 * ```
 */
export function createRetry(options: RetryOptions = {}): FetchLayer {
	const {
		attempts: maxAttempts = 3,
		backoff = "exponential",
		baseDelay = 500,
		maxDelay = 30_000,
		jitter = true,
		respectRetryAfter = true,
		isRetryable = defaultIsRetryable,
		onRetry,
		events,
		logger,
	} = options;

	function computeDelay(outcome: RetryOutcome, attempt: number): number {
		if (respectRetryAfter && outcome.result) {
			const after = parseRetryAfter(outcome.result.headers.get("retry-after"));
			if (after !== undefined) {
				// server-directed: no jitter, but still capped
				if (after > maxDelay) {
					logger?.warn(
						`Retry-After ${after} ms capped to maxDelay ${maxDelay} ms`,
					);
				}
				return Math.min(maxDelay, after);
			}
		}
		const raw = Math.min(
			maxDelay,
			Math.max(0, rawBackoff(backoff, attempt, baseDelay)),
		);
		// full jitter — near-zero delays are by design; a custom function means the
		// caller wants full control, so it is left alone
		return jitter && typeof backoff !== "function" ? Math.random() * raw : raw;
	}

	return (next: FetchFn): FetchFn =>
	async (input: FetchRequest): Promise<FetchResult> => {
		const identified = ensureRequestId(input);
		const requestId = identified.requestId;
		const rid = shortId(requestId);

		// anchor a relative deadline here too, so a standalone retry layer behaves like
		// a wired one (idempotent: a Date passes through unchanged)
		const deadlineAt = resolveDeadline(identified.deadline);
		const req: FetchRequest = deadlineAt === undefined
			? identified
			: { ...identified, deadline: new Date(deadlineAt) };

		const expired = () => deadlineAt !== undefined && Date.now() >= deadlineAt;

		for (let attempt = 1;; attempt++) {
			if (req.signal?.aborted) {
				throw new PageFetchError({
					kind: "aborted",
					url: req.url,
					requestId,
					attempts: attempt - 1,
					retryable: false,
					cause: req.signal.reason,
				});
			}
			if (expired()) {
				throw new PageFetchError({
					kind: "deadline",
					url: req.url,
					requestId,
					attempts: attempt - 1,
					retryable: false,
				});
			}

			safeEmit(events?.onRequest, logger, req, { requestId, attempt });
			logger?.debug(`[${rid}] attempt ${attempt}/${maxAttempts} ${req.url}`);

			let outcome: RetryOutcome;
			try {
				outcome = { result: await next(req) };
			} catch (e) {
				// TypeErrors and friends are programmer/config errors, not fetch
				// outcomes — they must never be classified or retried
				if (!PageFetchError.is(e)) throw e;
				outcome = { error: e };
			}

			const isLast = attempt >= maxAttempts;
			if (isLast || !isRetryable(outcome, attempt, req)) {
				if (outcome.error) throw withAttempts(outcome.error, attempt);
				return { ...outcome.result!, attempts: attempt };
			}

			const delay = computeDelay(outcome, attempt);

			// never sleep past the deadline
			if (deadlineAt !== undefined && Date.now() + delay > deadlineAt) {
				logger?.debug(
					`[${rid}] deadline would elapse during backoff — failing fast`,
				);
				// an ok:false result is real data a crawler wants recorded; only an
				// error in hand becomes a deadline failure
				if (outcome.result) return { ...outcome.result, attempts: attempt };
				throw new PageFetchError({
					kind: "deadline",
					url: req.url,
					requestId,
					attempts: attempt,
					retryable: false,
					cause: outcome.error,
				});
			}

			const info: RetryInfo = {
				requestId,
				url: req.url,
				attempt,
				delay,
				...outcome,
			};
			logger?.warn(
				`[${rid}] attempt ${attempt} failed (${
					outcome.error
						? outcome.error.kind
						: `status ${outcome.result?.status}`
				}), retrying in ${Math.round(delay)} ms`,
			);
			safeEmit(onRetry as ((i: RetryInfo) => void) | undefined, logger, info);
			safeEmit(events?.onRetry, logger, info);

			try {
				await sleep(delay, req.signal);
			} catch (cause) {
				if (PageFetchError.is(cause)) throw withAttempts(cause, attempt);
				throw new PageFetchError({
					kind: "aborted",
					url: req.url,
					requestId,
					attempts: attempt,
					retryable: false,
					cause,
				});
			}
		}
	};
}

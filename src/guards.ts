/**
 * The wrapper-level guards: per-attempt timeout, total deadline, and the non-2xx
 * throwing policy.
 *
 * These are true `(next: FetchFn) => FetchFn` layers, unlike the stream guards
 * (`maxBytes`, content-type policy, charset), which must run inside an adapter.
 * Placement matters, and each guard wants a different spot: the timeout guard sits
 * **below** retry so it re-arms on every attempt, the deadline guard sits **above** it
 * because the deadline spans attempts and must also bound the sleeps between them, and
 * {@linkcode httpErrorGuard} sits above retry as well — see its own note for why.
 *
 * @module
 */

import { PageFetchError } from "./errors.ts";
import { ensureRequestId, shortId } from "./internal.ts";
import type { FetchFn, FetchLayer, FetchRequest, FetchResult, Logger } from "./types.ts";
import { resolveDeadline } from "./utils.ts";

/** Options of {@linkcode timeoutGuard}. */
export interface TimeoutGuardOptions {
	/** Used when the request carries no `timeout`. */
	defaultTimeout?: number;
	/** Silent by default. */
	logger?: Logger;
}

/** Options of {@linkcode deadlineGuard}. */
export interface DeadlineGuardOptions {
	/** Used when the request carries no `deadline`. */
	defaultDeadline?: number | Date;
	/** Silent by default. */
	logger?: Logger;
}

/**
 * Combine several signals into one, dropping the empty slots.
 *
 * Returns `undefined` when there is nothing to listen to (so no signal is attached at
 * all), the single signal when only one is real, and an `AbortSignal.any` composition
 * otherwise — which adopts the first-aborted source's reason, and that adoption is what
 * lets the catch side tell a timeout from a deadline from a caller cancellation.
 */
export function composeSignal(
	signals: (AbortSignal | undefined | null)[],
): AbortSignal | undefined {
	const real = signals.filter((s): s is AbortSignal => !!s);
	if (real.length === 0) return undefined;
	if (real.length === 1) return real[0];
	return AbortSignal.any(real);
}

/**
 * Per-attempt timeout.
 *
 * The effective budget is `min(timeout, deadline remaining)` — whichever binds first
 * decides the abort *reason*, so a request cut off by its overall deadline reports
 * `kind: "deadline"` (not retryable) while a slow single attempt reports
 * `kind: "timeout"` (retryable).
 *
 * Uses a plain `setTimeout` plus an `AbortController` rather than
 * `AbortSignal.timeout()`, whose timer cannot be cancelled: a fast attempt would keep
 * the signal and every listener attached to it alive until the timer fired, and with
 * retries that accumulates.
 */
export function timeoutGuard(options: TimeoutGuardOptions = {}): FetchLayer {
	const { defaultTimeout, logger } = options;

	return (next: FetchFn): FetchFn =>
	async (input: FetchRequest): Promise<FetchResult> => {
		const req = ensureRequestId(input);
		const timeout = req.timeout ?? defaultTimeout;
		const deadlineAt = resolveDeadline(req.deadline);
		const remaining = deadlineAt === undefined ? undefined : deadlineAt - Date.now();

		const budget = Math.min(timeout ?? Infinity, remaining ?? Infinity);
		if (!Number.isFinite(budget)) return await next(req);

		// whichever constraint binds first names the failure
		const kind = remaining !== undefined && remaining <= (timeout ?? Infinity)
			? "deadline"
			: "timeout";

		const controller = new AbortController();
		const timer = setTimeout(() => {
			controller.abort(
				new PageFetchError({
					kind,
					url: req.url,
					requestId: req.requestId,
					message: kind === "timeout"
						? `Attempt timed out after ${budget} ms fetching ${req.url}`
						: `Deadline exceeded fetching ${req.url}`,
				}),
			);
		}, Math.max(0, budget));

		logger?.debug(
			`[${shortId(req.requestId)}] ${kind} budget ${Math.max(0, budget)} ms`,
		);

		try {
			return await next({
				...req,
				signal: composeSignal([req.signal, controller.signal]),
			});
		} finally {
			clearTimeout(timer);
		}
	};
}

/**
 * Total deadline across all attempts.
 *
 * Does three things: fails fast when the deadline has already passed, anchors a
 * relative deadline into an absolute `Date` on the request it passes down (so no inner
 * layer restarts the clock), and arms an abort so an attempt already in flight is
 * actually cut off when the deadline arrives.
 */
export function deadlineGuard(options: DeadlineGuardOptions = {}): FetchLayer {
	const { defaultDeadline, logger } = options;

	return (next: FetchFn): FetchFn =>
	async (input: FetchRequest): Promise<FetchResult> => {
		const req = ensureRequestId(input);
		const raw = req.deadline ?? defaultDeadline;
		if (raw === undefined) return await next(req);

		const deadlineAt = resolveDeadline(raw)!;
		const remaining = deadlineAt - Date.now();
		if (remaining <= 0) {
			throw new PageFetchError({
				kind: "deadline",
				url: req.url,
				requestId: req.requestId,
				attempts: 0,
				retryable: false,
				message: `Deadline already expired for ${req.url}`,
			});
		}

		const controller = new AbortController();
		const timer = setTimeout(() => {
			controller.abort(
				new PageFetchError({
					kind: "deadline",
					url: req.url,
					requestId: req.requestId,
					message: `Deadline exceeded fetching ${req.url}`,
				}),
			);
		}, remaining);

		logger?.debug(`[${shortId(req.requestId)}] deadline in ${remaining} ms`);

		try {
			return await next({
				...req,
				// anchored: from here down, "deadline" is always an absolute instant
				deadline: new Date(deadlineAt),
				signal: composeSignal([req.signal, controller.signal]),
			});
		} finally {
			clearTimeout(timer);
		}
	};
}

/** Options of {@linkcode httpErrorGuard}. */
export interface HttpErrorGuardOptions {
	/** Silent by default. */
	logger?: Logger;
}

/**
 * Turn a non-2xx result into a thrown `PageFetchError` (`kind: "http"`).
 *
 * Off unless you ask for it: a 404 is data a crawler wants recorded, not an exception
 * to handle. This is the opt-in for callers who would rather write `try`/`catch` — it
 * is the only place in the package where a non-2xx becomes a throw.
 *
 * **Place it above the retry layer.** There, retry still sees the raw `ok: false`
 * result and can honor its `Retry-After` header; below retry it would see an `http`
 * error instead, and a server-directed backoff would silently degrade into the local
 * one. The whole result — headers and (still readable) body included — is carried on
 * `details.result`, so throwing costs the caller no information.
 *
 * @example
 * ```ts
 * const fetchFn = compose([httpErrorGuard(), createRetry()], adapter.fetch);
 * ```
 */
export function httpErrorGuard(options: HttpErrorGuardOptions = {}): FetchLayer {
	const { logger } = options;

	return (next: FetchFn): FetchFn =>
	async (input: FetchRequest): Promise<FetchResult> => {
		const res = await next(ensureRequestId(input));
		if (res.ok) return res;

		logger?.debug(`[${shortId(res.requestId)}] throwing on HTTP ${res.status}`);
		throw new PageFetchError({
			kind: "http",
			url: res.url,
			finalUrl: res.finalUrl,
			status: res.status,
			requestId: res.requestId,
			attempts: res.attempts,
			message: `HTTP ${res.status}${
				res.statusText ? ` ${res.statusText}` : ""
			} fetching ${res.finalUrl}`,
			details: { result: res },
		});
	};
}

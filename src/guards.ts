/**
 * The control-flow guards: per-attempt timeout and total deadline.
 *
 * These are true `(next: FetchFn) => FetchFn` layers, unlike the stream guards
 * (`maxBytes`, content-type policy, charset), which must run inside an adapter.
 * Placement matters: the timeout guard sits **below** retry so it re-arms on every
 * attempt, while the deadline guard sits **above** it, because the deadline spans
 * attempts and must also bound the sleeps between them.
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

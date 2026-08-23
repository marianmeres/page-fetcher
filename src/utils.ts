/**
 * Small shared utilities: abort-aware sleeping and deadline anchoring.
 *
 * @module
 */

/**
 * Sleep, cancellably.
 *
 * Resolves after `ms`, or rejects **immediately** with the signal's reason when the
 * signal aborts (which is how a caller's cancellation cuts a retry sleep short). The
 * abort listener is removed on the normal path, so nothing leaks.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Convert a deadline into absolute epoch milliseconds — the internal arithmetic form.
 *
 * A `number` is relative (milliseconds from `now`), a `Date` is already absolute.
 * The rule that makes this safe: the outermost layer that reads a *relative* deadline
 * replaces it with a `Date` on the request it passes down, so inner layers cannot
 * restart the clock — a deadline that silently slides later on every attempt is a bug
 * no test finds unless it is designed for.
 */
export function resolveDeadline(
	deadline: number | Date | undefined,
	now: number = Date.now(),
): number | undefined {
	if (deadline === undefined) return undefined;
	return typeof deadline === "number" ? now + deadline : deadline.getTime();
}

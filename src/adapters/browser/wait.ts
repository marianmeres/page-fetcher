/**
 * Navigation and the wait strategies — "when is this page done?".
 *
 * The default is a **soft hybrid**: navigate with `waitUntil: "load"`, then wait for a
 * bounded window of network quiet, and if that window never arrives, proceed anyway and
 * say so (`extra.networkidleTimedOut`). Both halves of that are deliberate. Plain
 * `"load"` returns the pre-hydration DOM on any client-rendered site — the single most
 * common "the browser adapter returns an empty page" report — and a hard-failing
 * networkidle makes the adapter unusable on the analytics/websocket-carrying pages it
 * exists for, since those never go quiet at all.
 *
 * The explicit conditions (`{ selector }`, `{ fn }`) fail hard on timeout instead: the
 * caller named a condition, so its absence means the page is not what they asked for.
 *
 * @module
 */

import { PageFetchError } from "../../errors.ts";
import { abortErrorFrom, isAbortError } from "../../internal.ts";
import type { Logger } from "../../types.ts";
import type { DriverNavResult, DriverPage } from "./driver.ts";

/**
 * When to consider a navigation finished.
 *
 * - `"load"` / `"domcontentloaded"` — the raw lifecycle events, fastest and dumbest.
 * - `"networkidle"` — load, then a bounded wait for network quiet (see
 *   {@linkcode NetworkIdleOptions}). The default.
 * - `{ selector }` — DOM-ready, then wait for that selector to appear.
 * - `{ fn }` — DOM-ready, then wait until the JavaScript source evaluates truthy in
 *   the page. A **string**, not a function: it has to serialize into the page anyway,
 *   and the two drivers order their `waitForFunction` arguments differently. Both an
 *   expression (`"document.title === 'ready'"`) and a function source
 *   (`"() => document.title === 'ready'"`) work — see {@linkcode toPageExpression}.
 */
export type WaitStrategy =
	| "load"
	| "domcontentloaded"
	| "networkidle"
	| { selector: string; timeout?: number }
	| { fn: string; timeout?: number };

/** Tuning of the `"networkidle"` strategy. */
export interface NetworkIdleOptions {
	/** How long the network must stay quiet. Default `500`. Ignored by Playwright, whose window is fixed. */
	idleMs?: number;
	/** Cap on the idle wait — **separate** from the navigation timeout. Default `10_000`. */
	timeout?: number;
	/**
	 * Treat "never went idle" as a failure. Default `false`: proceed with whatever
	 * rendered and report `extra.networkidleTimedOut`.
	 */
	strict?: boolean;
}

/** Defaults of {@linkcode NetworkIdleOptions}. */
export const DEFAULT_NETWORK_IDLE: Required<NetworkIdleOptions> = {
	idleMs: 500,
	timeout: 10_000,
	strict: false,
};

/** Default navigation budget, used when neither the request nor the adapter sets one. */
export const DEFAULT_NAVIGATION_TIMEOUT = 30_000;

/** Default wait strategy — the soft hybrid this module's header argues for. */
export const DEFAULT_WAIT: WaitStrategy = "networkidle";

/** What {@linkcode applyWait} reports back. */
export interface WaitOutcome {
	/** The HTTP half of the navigation. */
	nav: DriverNavResult;
	/** Epoch ms at which the navigation itself resolved — the browser's `ttfb` anchor. */
	navigatedAt: number;
	/** Milliseconds spent waiting *after* the navigation resolved. */
	render: number;
	/** The idle window never arrived and `strict` was off. */
	networkidleTimedOut?: boolean;
}

/** Context {@linkcode browserErrorFrom} needs to build a useful error. */
export interface BrowserErrorContext {
	/** Requested URL. */
	url: string;
	/** Correlation id. */
	requestId?: string;
	/** The request's signal, if any — an aborted one outranks every other reading. */
	signal?: AbortSignal;
	/** What was being attempted, e.g. `"navigating to https://x/"`. */
	phase?: string;
	/** Status, when one was already known. */
	status?: number;
}

/** Messages that mean "the network never answered", not "the browser broke". */
const NETWORK_ERROR = /net::ERR_|NS_ERROR_|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN/i;
/** Messages that mean a driver-side budget elapsed. */
const TIMEOUT_ERROR = /timeout|timed out/i;

/**
 * Map anything a driver threw onto a {@linkcode PageFetchError}.
 *
 * Cancellation is checked first and beats every other reading, because cancelling a
 * browser fetch *is* closing the page — so an abort surfaces as whatever unrelated-
 * looking failure the in-flight operation happened to produce, and only the signal
 * knows the truth. When the signal was aborted by a guard, that guard's own error is
 * the abort reason and is returned unchanged, so a timeout keeps reporting as a
 * timeout.
 *
 * Everything else is classified by message, which is as good as it gets: neither driver
 * exposes machine-readable navigation error codes. DNS/connection failures become
 * `kind: "network"`, driver budgets become `kind: "timeout"`, and the rest is
 * `kind: "browser"` — all three retryable, since none of them says the page is
 * permanently unfetchable.
 */
export function browserErrorFrom(
	cause: unknown,
	ctx: BrowserErrorContext,
): PageFetchError {
	if (PageFetchError.is(cause)) return cause;
	if (ctx.signal?.aborted || isAbortError(cause)) {
		return abortErrorFrom(ctx.signal, {
			url: ctx.url,
			requestId: ctx.requestId,
			cause,
		});
	}

	const detail = cause instanceof Error ? cause.message : String(cause);
	const kind = NETWORK_ERROR.test(detail)
		? "network"
		: TIMEOUT_ERROR.test(detail)
		? "timeout"
		: "browser";

	return new PageFetchError({
		kind,
		url: ctx.url,
		status: ctx.status,
		requestId: ctx.requestId,
		attempts: 1,
		message: ctx.phase ? `Failed ${ctx.phase}: ${detail}` : detail,
		cause,
	});
}

/** Sources that are a function rather than a value: arrow, named or anonymous. */
const FUNCTION_SOURCE =
	/^\s*(async\s+)?(function[\s(]|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/;

/**
 * Turn a wait-function source into an expression the page can evaluate.
 *
 * Both drivers evaluate a **string** `waitForFunction` argument as an expression, so
 * `"() => done"` evaluates to a function *object* — which is truthy, so the wait
 * resolves instantly and silently returns the un-waited-for page. That trap is the
 * whole reason this exists: a source that looks like a function is wrapped in a call,
 * anything else is passed through as the expression it already is.
 *
 * @example
 * ```ts
 * toPageExpression("() => document.title === 'ready'"); // "(() => document.title === 'ready')()"
 * toPageExpression("document.title === 'ready'");       // unchanged
 * ```
 */
export function toPageExpression(fn: string): string {
	return FUNCTION_SOURCE.test(fn) ? `(${fn})()` : fn;
}

/** Reject a strategy the driver could not act on, at the moment it is configured. */
function invalid(strategy: unknown): never {
	throw new TypeError(
		`Invalid wait strategy: ${JSON.stringify(strategy)}. Expected "load", ` +
			`"domcontentloaded", "networkidle", { selector } or { fn }.`,
	);
}

/**
 * Validate a wait strategy and return it unchanged.
 *
 * Called once when the adapter is created and once per request that overrides it, so a
 * typo fails at configuration time rather than as a mystery navigation.
 */
export function normalizeWait(strategy: unknown): WaitStrategy {
	if (typeof strategy === "string") {
		if (
			strategy === "load" || strategy === "domcontentloaded" ||
			strategy === "networkidle"
		) {
			return strategy;
		}
		invalid(strategy);
	}
	if (strategy && typeof strategy === "object") {
		const candidate = strategy as { selector?: unknown; fn?: unknown };
		if (typeof candidate.selector === "string" && candidate.selector) {
			return strategy as WaitStrategy;
		}
		if (typeof candidate.fn === "string" && candidate.fn) {
			return strategy as WaitStrategy;
		}
	}
	invalid(strategy);
}

/** The lifecycle event a strategy navigates with. */
function waitUntilFor(strategy: WaitStrategy): "load" | "domcontentloaded" {
	if (strategy === "load" || strategy === "networkidle") return "load";
	if (strategy === "domcontentloaded") return "domcontentloaded";
	// an explicit condition is the real signal — do not also wait for subresources
	return "domcontentloaded";
}

/** Options of {@linkcode applyWait}. */
export interface ApplyWaitOptions {
	/** Budget for the navigation itself. */
	navigationTimeout: number;
	/** Fully resolved networkidle tuning. */
	networkidle: Required<NetworkIdleOptions>;
	/** Correlation id, for error construction. */
	requestId?: string;
	/** The request's signal — see {@linkcode browserErrorFrom}. */
	signal?: AbortSignal;
	/** Silent by default. */
	logger?: Logger;
}

/**
 * Navigate and wait, the strategy deciding how patient to be.
 *
 * @example
 * ```ts
 * const { nav, render } = await applyWait(page, url, "networkidle", {
 * 	navigationTimeout: 30_000,
 * 	networkidle: DEFAULT_NETWORK_IDLE,
 * });
 * ```
 */
export async function applyWait(
	page: DriverPage,
	url: string,
	strategy: WaitStrategy,
	opts: ApplyWaitOptions,
): Promise<WaitOutcome> {
	const { navigationTimeout, networkidle, requestId, signal, logger } = opts;
	const errorContext = { url, requestId, signal };

	let nav: DriverNavResult;
	try {
		nav = await page.goto(url, {
			waitUntil: waitUntilFor(strategy),
			timeout: navigationTimeout,
		});
	} catch (cause) {
		throw browserErrorFrom(cause, {
			...errorContext,
			phase: `navigating to ${url}`,
		});
	}

	const waitStart = Date.now();
	let networkidleTimedOut: boolean | undefined;

	if (strategy === "networkidle") {
		try {
			await page.waitForNetworkIdle({
				idleMs: networkidle.idleMs,
				timeout: networkidle.timeout,
			});
		} catch (cause) {
			const error = browserErrorFrom(cause, {
				...errorContext,
				status: nav.status,
				phase: `waiting for network idle on ${url}`,
			});
			// a cancelled or crashed page is not "the page is merely busy" — only a
			// plain idle-window timeout is soft
			if (networkidle.strict || error.kind !== "timeout") throw error;
			logger?.debug(
				`network never went idle within ${networkidle.timeout} ms on ${url} ` +
					`— proceeding with what rendered`,
			);
			networkidleTimedOut = true;
		}
	} else if (typeof strategy === "object" && "selector" in strategy) {
		try {
			await page.waitForSelector(strategy.selector, {
				timeout: strategy.timeout ?? navigationTimeout,
			});
		} catch (cause) {
			throw browserErrorFrom(cause, {
				...errorContext,
				status: nav.status,
				phase: `waiting for selector "${strategy.selector}" on ${url}`,
			});
		}
	} else if (typeof strategy === "object" && "fn" in strategy) {
		try {
			await page.waitForFunction(toPageExpression(strategy.fn), {
				timeout: strategy.timeout ?? navigationTimeout,
			});
		} catch (cause) {
			throw browserErrorFrom(cause, {
				...errorContext,
				status: nav.status,
				phase: `waiting for the wait function on ${url}`,
			});
		}
	}

	return {
		nav,
		navigatedAt: waitStart,
		render: Date.now() - waitStart,
		networkidleTimedOut,
	};
}

/**
 * The browser adapter: navigate a real page, hand back the serialized DOM as a
 * {@linkcode FetchResult}.
 *
 * Same contract as the HTTP adapter — a non-2xx resolves with `ok: false`, one attempt
 * is reported, the body accessors follow the eager-bytes/lazy-decode rule — with three
 * differences that are inherent to driving a browser and are stated loudly rather than
 * hidden:
 *
 * 1. **`bytes()` is the serialized DOM, not the wire bytes.** The document has been
 *    parsed, scripted and re-serialized by the time we see it; there is no way back to
 *    the original transport bytes without CDP-level response capture. `charset` is
 *    therefore always `"utf-8"`, whatever the server sent.
 * 2. **Redirects are already followed** when the navigation resolves, so `maxRedirects`
 *    is enforced after the fact rather than aborting mid-chain.
 * 3. **`finalUrl` is the end of the HTTP redirect chain** — the server's truth, which
 *    is what relative references resolve against. When client-side routing moved the
 *    page somewhere else during the wait phase, that shows up as `extra.pageUrl`.
 *
 * The adapter never imports a browser. Inject a driver:
 * `createBrowserAdapter({ driver: playwrightDriver(playwright) })`.
 *
 * @module
 */

import { parseContentType } from "../../content-type.ts";
import { PageFetchError } from "../../errors.ts";
import {
	abortErrorFrom,
	createBodyResult,
	ensureRequestId,
	type IdentifiedRequest,
	shortId,
	withAttempts,
} from "../../internal.ts";
import type {
	Adapter,
	FetchRequest,
	FetchResult,
	ObservabilityOptions,
} from "../../types.ts";
import { type BlockingOptions, compileRequestFilter } from "./blocking.ts";
import type { BrowserDriver, DriverContextOptions, DriverPage } from "./driver.ts";
import {
	type ContextLease,
	type ContextProvider,
	type ContextStrategy,
	createContextPool,
	poolShapeFor,
} from "./pool.ts";
import {
	applyWait,
	browserErrorFrom,
	DEFAULT_NAVIGATION_TIMEOUT,
	DEFAULT_NETWORK_IDLE,
	DEFAULT_WAIT,
	type NetworkIdleOptions,
	normalizeWait,
	type WaitStrategy,
} from "./wait.ts";

/** Default cap on the **serialized DOM**, not on wire bytes: 10 MiB. */
export const DEFAULT_MAX_DOM_BYTES = 10 * 1024 * 1024;

/**
 * Default redirect cap, enforced post-hoc (the browser already followed the chain).
 *
 * Separate from the HTTP adapter's constant of the same value, because the two enforce
 * it at opposite ends: one aborts the chain, this one reports on a completed one.
 */
export const DEFAULT_BROWSER_MAX_REDIRECTS = 5;

/** Default cap on each captured list. */
export const DEFAULT_CAPTURE_LIMIT = 50;

/**
 * Inspect (and steer) the settled page before its DOM is read.
 *
 * Runs after the wait strategy resolved and before `content()`, so it may scroll,
 * dismiss a cookie banner or click "load more". Whatever it returns is merged into
 * {@linkcode FetchResult.extra} last, so it can override the adapter's own entries.
 * A throwing hook never fails the fetch — it lands in `extra.onPageError`.
 *
 * `page` is the **driver's own** page object (`DriverPage.raw`), typed `unknown` so
 * that no Playwright or Puppeteer type reaches this package's public surface; cast it
 * to your driver's `Page`.
 */
export type OnPageHook = (
	page: unknown,
	req: FetchRequest,
) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;

/** Options of {@linkcode createBrowserAdapter}. */
export interface BrowserAdapterOptions extends ObservabilityOptions, BlockingOptions {
	/** Adapter name, reported as `FetchResult.adapter`. Default `"browser"`. */
	name?: string;
	/**
	 * The injected driver — `playwrightDriver(playwright)`, `puppeteerDriver(puppeteer)`
	 * or your own {@linkcode BrowserDriver}. Required: this package never imports a
	 * browser itself.
	 */
	driver: BrowserDriver;
	/** Context options: viewport, locale, timezone, `javaScriptEnabled`, … */
	contextOptions?: DriverContextOptions;
	/**
	 * Convenience for `contextOptions.userAgent`.
	 *
	 * Unset by default — **deliberately different from the HTTP adapter**, which
	 * announces itself. Replacing a real browser's `User-Agent` with a bot string is
	 * exactly what gets a headless browser served different HTML or blocked outright,
	 * which defeats the reason to run one. Set it when politeness matters more than
	 * fidelity.
	 */
	userAgent?: string;
	/** Extra headers on every request from this adapter's contexts. */
	headers?: Record<string, string>;
	/** When to consider a page done. Default `"networkidle"` (the soft hybrid). */
	wait?: WaitStrategy;
	/** Tuning of the `"networkidle"` strategy. */
	networkidle?: NetworkIdleOptions;
	/** Navigation budget in ms. A request's own `timeout` wins. Default `30_000`. */
	navigationTimeout?: number;
	/** Redirect cap. Default {@linkcode DEFAULT_BROWSER_MAX_REDIRECTS}. */
	maxRedirects?: number;
	/** Cap on the serialized DOM. Default {@linkcode DEFAULT_MAX_DOM_BYTES}. */
	maxBytes?: number;
	/** Default for `FetchRequest.retainBody`. Default `true`. */
	retainBody?: boolean;
	/** See {@linkcode OnPageHook}. */
	onPage?: OnPageHook;
	/** Collect `console.error` and uncaught page exceptions. Default `true`. */
	captureConsoleErrors?: boolean;
	/** Collect requests that never completed. Default `true`. */
	captureFailedRequests?: boolean;
	/** Cap on each captured list. Default {@linkcode DEFAULT_CAPTURE_LIMIT}. */
	captureLimit?: number;
	/** How contexts are shared between requests. Default `"pooled"`. */
	contextStrategy?: ContextStrategy;
	/** Concurrent contexts. Default `3`. Ignored by the `"shared"` strategy. */
	poolSize?: number;
	/** Pages a pooled context serves before it is replaced. Default `50`. */
	maxPagesPerContext?: number;
	/** How long a request waits for a free context. Default `30_000`. */
	acquireTimeout?: number;
	/** Register a process-exit hook that tears the browser down. Default `true`. */
	exitHooks?: boolean;
	/**
	 * Where contexts come from. Defaults to a {@linkcode createContextPool} built from
	 * the options above; inject your own to take the lifecycle over entirely.
	 */
	contexts?: ContextProvider;
}

/** Per-request overrides, read from `FetchRequest.adapterOptions`. */
interface RequestOverrides extends BlockingOptions {
	/** Overrides the adapter's wait strategy. */
	wait?: WaitStrategy;
	/** Overrides the adapter's networkidle tuning. */
	networkidle?: NetworkIdleOptions;
	/** Merged over the adapter's context options — forces a dedicated context. */
	contextOptions?: DriverContextOptions;
	/** Replaces the adapter's hook for this request. */
	onPage?: OnPageHook;
}

/** Lowercase the keys of a header record. */
function lowerKeys(headers: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
	return out;
}

/** Non-empty object? */
function has(value: object | undefined): boolean {
	return !!value && Object.keys(value).length > 0;
}

/**
 * Reject as soon as `signal` fires, whatever the in-flight work is doing.
 *
 * Neither driver's `goto` takes a signal, so cancellation is emulated: the caller
 * closes the page (which does cancel the navigation) *and* stops waiting for it, since
 * a wedged driver must not outlive the request that asked for it.
 */
function raceAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return work;
	// whoever loses this race still settles; its rejection must not go unhandled
	work.catch(() => {});
	return new Promise<T>((resolve, reject) => {
		const onAbort = () =>
			reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
		if (signal.aborted) return onAbort();
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

/**
 * Create the browser adapter.
 *
 * @example
 * ```ts ignore
 * import * as playwright from "playwright";
 * import { createBrowserAdapter, playwrightDriver } from "@marianmeres/page-fetcher/adapters";
 *
 * await using fetcher = createFetcher({
 * 	adapters: createBrowserAdapter({ driver: playwrightDriver(playwright) }),
 * });
 * const res = await fetcher.fetch("https://example.com/");
 * console.log(res.status, (await res.text()).length, res.extra?.title);
 * ```
 */
export function createBrowserAdapter(options: BrowserAdapterOptions): Adapter {
	const {
		name = "browser",
		driver,
		userAgent,
		headers,
		navigationTimeout = DEFAULT_NAVIGATION_TIMEOUT,
		maxRedirects = DEFAULT_BROWSER_MAX_REDIRECTS,
		maxBytes = DEFAULT_MAX_DOM_BYTES,
		onPage,
		captureConsoleErrors = true,
		captureFailedRequests = true,
		captureLimit = DEFAULT_CAPTURE_LIMIT,
		contextStrategy = "pooled",
		acquireTimeout,
		exitHooks,
		logger,
	} = options;

	if (!driver || typeof driver.launch !== "function") {
		throw new TypeError(
			"createBrowserAdapter: `driver` is required — inject one with " +
				"playwrightDriver(playwright), puppeteerDriver(puppeteer), or your own.",
		);
	}

	// ---- adapter-level context options ---------------------------------------
	const baseContextOptions: DriverContextOptions = { ...options.contextOptions };
	if (userAgent) baseContextOptions.userAgent = userAgent;
	if (has(headers)) {
		baseContextOptions.extraHTTPHeaders = {
			...baseContextOptions.extraHTTPHeaders,
			...lowerKeys(headers!),
		};
	}
	// say so once, at wiring time, rather than silently dropping an option
	if (baseContextOptions.locale && !driver.capabilities.locale) {
		logger?.warn(
			`[browser] driver "${driver.name}" cannot emulate locale — ` +
				`"${baseContextOptions.locale}" is approximated at best`,
		);
	}
	if (baseContextOptions.timezoneId && !driver.capabilities.timezone) {
		logger?.warn(
			`[browser] driver "${driver.name}" cannot emulate a timezone — ` +
				`"${baseContextOptions.timezoneId}" will be ignored`,
		);
	}

	const baseWait = normalizeWait(options.wait ?? DEFAULT_WAIT);
	const baseNetworkIdle: Required<NetworkIdleOptions> = {
		...DEFAULT_NETWORK_IDLE,
		...options.networkidle,
	};
	const baseFilterOptions: BlockingOptions = {
		blockResources: options.blockResources,
		blockUrls: options.blockUrls,
		allowUrls: options.allowUrls,
	};
	const baseFilter = compileRequestFilter(baseFilterOptions);

	const contexts = options.contexts ?? createContextPool({
		driver,
		...poolShapeFor(contextStrategy, {
			size: options.poolSize,
			maxPagesPerContext: options.maxPagesPerContext,
		}),
		acquireTimeout,
		exitHooks,
		contextOptions: baseContextOptions,
		logger,
	});

	/**
	 * Context options this request needs on top of the adapter's.
	 *
	 * Returns `undefined` when it adds nothing — the overwhelmingly common case, and
	 * the only one that can share a context. When it does add something, the caller
	 * gets a dedicated context: Playwright honors these at context creation only, so
	 * quietly applying them per page would work on one driver and not the other.
	 */
	function requestContextOptions(
		req: FetchRequest,
		overrides: RequestOverrides,
	): DriverContextOptions | undefined {
		const requestHeaders = has(req.headers) ? lowerKeys(req.headers!) : undefined;
		if (!requestHeaders && !has(overrides.contextOptions)) return undefined;

		const merged: DriverContextOptions = {
			...baseContextOptions,
			...overrides.contextOptions,
		};
		if (requestHeaders) {
			const { "user-agent": ua, ...rest } = requestHeaders;
			if (ua) merged.userAgent = ua;
			if (Object.keys(rest).length) {
				merged.extraHTTPHeaders = {
					...merged.extraHTTPHeaders,
					...rest,
				};
			}
		}
		return merged;
	}

	async function browserFetch(req: IdentifiedRequest): Promise<FetchResult> {
		const requestId = req.requestId;
		const rid = shortId(requestId);
		const startedAt = Date.now();
		const url = req.url;

		try {
			new URL(url);
		} catch (cause) {
			throw new PageFetchError({
				kind: "network",
				url,
				requestId,
				attempts: 1,
				retryable: false,
				message: `Invalid URL: ${url}`,
				cause,
			});
		}

		const method = req.method ?? "GET";
		if (method !== "GET") {
			throw new PageFetchError({
				kind: "network",
				url,
				requestId,
				attempts: 1,
				retryable: false,
				message:
					`The browser adapter can only navigate, i.e. GET — got ${method}. ` +
					`Route non-GET requests to the http adapter.`,
			});
		}
		if (req.signal?.aborted) throw abortErrorFrom(req.signal, { url, requestId });

		const overrides = (req.adapterOptions ?? {}) as RequestOverrides;
		const wait = overrides.wait === undefined
			? baseWait
			: normalizeWait(overrides.wait);
		const networkidle: Required<NetworkIdleOptions> = overrides.networkidle
			? { ...baseNetworkIdle, ...overrides.networkidle }
			: baseNetworkIdle;
		// replacement, not merge: partially merged blocking rules are unpredictable
		const filter = overrides.blockResources !== undefined ||
				overrides.blockUrls !== undefined || overrides.allowUrls !== undefined
			? compileRequestFilter({
				blockResources: overrides.blockResources,
				blockUrls: overrides.blockUrls,
				allowUrls: overrides.allowUrls,
			})
			: baseFilter;
		const hook = overrides.onPage ?? onPage;
		const retainBody = req.retainBody ?? options.retainBody ?? true;
		const contextOptions = requestContextOptions(req, overrides);
		const pageOptions = contextOptions ?? baseContextOptions;

		const consoleErrors: string[] = [];
		const failedRequests: { url: string; failure: string }[] = [];
		let crashed: Error | undefined;

		/** Push under the cap, marking the list once when it overflows. */
		const capped = <T>(list: T[], marker: T) => (item: T) => {
			if (list.length < captureLimit) list.push(item);
			else if (list.length === captureLimit) list.push(marker);
		};

		logger?.debug(`[${rid}] browser GET ${url}`);
		let lease: ContextLease;
		try {
			lease = await contexts.acquire(req.signal, contextOptions);
		} catch (e) {
			// a launch failure, an acquire timeout or a disposed pool is a fetch
			// outcome like any other — it must never leave here as a raw Error
			throw withAttempts(
				browserErrorFrom(e, {
					url,
					requestId,
					signal: req.signal,
					phase: "acquiring a browser context",
				}),
				1,
			);
		}
		let page: DriverPage | undefined;
		let broken = false;
		const onAbort = () => void page?.close().catch(() => {});
		req.signal?.addEventListener("abort", onAbort, { once: true });

		const run = async (): Promise<FetchResult> => {
			page = await lease.context.newPage();
			// setup order matters: options and the filter must be installed before the
			// navigation they are meant to affect
			await page.applyPageOptions(pageOptions);
			await page.setRequestFilter(filter);
			if (captureConsoleErrors) {
				page.onConsoleError(capped(consoleErrors, "… truncated"));
			}
			if (captureFailedRequests) {
				page.onRequestFailed(
					capped(failedRequests, { url: "…", failure: "truncated" }),
				);
			}
			page.onCrash((error) => {
				crashed = error;
			});

			const { nav, navigatedAt, render, networkidleTimedOut } = await applyWait(
				page,
				url,
				wait,
				{
					navigationTimeout: req.timeout ?? navigationTimeout,
					networkidle,
					requestId,
					signal: req.signal,
					logger,
				},
			);

			// post-hoc: the browser already followed the chain, so this is a report,
			// not an interception
			if (nav.redirects.length > maxRedirects) {
				throw new PageFetchError({
					kind: "too-many-redirects",
					url,
					finalUrl: nav.finalUrl,
					status: nav.status,
					requestId,
					attempts: 1,
					retryable: false,
					message:
						`Exceeded maxRedirects (${maxRedirects}) fetching ${url} — the ` +
						`browser followed ${nav.redirects.length} hops`,
					details: { maxRedirects, chain: nav.redirects },
				});
			}

			let hookExtra: Record<string, unknown> | undefined;
			let onPageError: string | undefined;
			if (hook) {
				try {
					// `??` does not narrow a `void` union under tsc's strict mode, so
					// widen the awaited value first
					const returned: unknown = await hook(page.raw, req);
					hookExtra = (returned ?? undefined) as
						| Record<string, unknown>
						| undefined;
				} catch (e) {
					onPageError = e instanceof Error ? e.message : String(e);
					logger?.warn(`[${rid}] onPage hook threw: ${onPageError}`);
				}
			}

			// read after the hook: it may have navigated the page somewhere else
			const pageUrl = page.url();
			const title = await page.title();

			let bytes: Uint8Array | null = null;
			let size: number | undefined;
			if (retainBody) {
				const html = await page.content();
				bytes = new TextEncoder().encode(html);
				size = bytes.length;
				if (size > maxBytes) {
					throw new PageFetchError({
						kind: "too-large",
						url,
						finalUrl: nav.finalUrl,
						status: nav.status,
						requestId,
						attempts: 1,
						retryable: false,
						message:
							`Serialized DOM (${size} bytes) exceeds maxBytes (${maxBytes}) ` +
							`fetching ${url}`,
						details: { maxBytes, size },
					});
				}
			} else {
				logger?.debug(`[${rid}] retainBody: false — skipping content()`);
			}

			const headersOut = new Headers(nav.headers);
			const { mime } = parseContentType(headersOut.get("content-type"));
			const endedAt = Date.now();
			const body = createBodyResult(bytes, {
				url,
				requestId,
				charset: "utf-8",
				absentReason: "retain-body",
			});

			const extra: Record<string, unknown> = { title };
			if (consoleErrors.length) extra.consoleErrors = consoleErrors;
			if (failedRequests.length) extra.failedRequests = failedRequests;
			if (networkidleTimedOut) extra.networkidleTimedOut = true;
			if (pageUrl && pageUrl !== nav.finalUrl) extra.pageUrl = pageUrl;
			if (onPageError !== undefined) extra.onPageError = onPageError;
			// the hook wins on a key collision — it knows more than we do
			if (hookExtra) Object.assign(extra, hookExtra);

			return {
				ok: nav.status >= 200 && nav.status < 300,
				url,
				finalUrl: nav.finalUrl,
				status: nav.status,
				statusText: nav.statusText,
				headers: headersOut,
				redirects: nav.redirects,
				requestId,
				hasBody: body.hasBody,
				text: body.text,
				bytes: body.bytes,
				contentType: mime,
				// the DOM was re-serialized: whatever charset the wire used is gone
				charset: bytes ? "utf-8" : undefined,
				size,
				fromCache: false,
				notModified: false,
				timing: {
					startedAt,
					endedAt,
					total: endedAt - startedAt,
					// includes launch/context/page setup — a cold first fetch says so
					ttfb: navigatedAt - startedAt,
					render,
				},
				attempts: 1,
				adapter: name,
				meta: req.meta,
				extra,
			};
		};

		let settled = false;
		const work = run().finally(() => {
			settled = true;
		});

		try {
			return await raceAbort(work, req.signal);
		} catch (e) {
			const error = browserErrorFrom(e, { url, requestId, signal: req.signal });
			// a dead page means a possibly dead context: do not hand it to anyone else
			broken = crashed !== undefined || error.kind === "browser";
			throw withAttempts(error, 1);
		} finally {
			req.signal?.removeEventListener("abort", onAbort);
			if (settled) {
				await page?.close().catch(() => {});
				lease.release({ broken });
			} else {
				// we stopped waiting for a cancelled navigation, but it is still
				// unwinding — clean up when it does, so neither the page nor the
				// lease leaks
				const cleanup = () => {
					void page?.close().catch(() => {});
					lease.release({ broken: true });
				};
				void work.then(cleanup, cleanup);
			}
		}
	}

	return {
		name,
		fetch: (input: FetchRequest): Promise<FetchResult> =>
			browserFetch(ensureRequestId(input)),
		dispose: (): Promise<void> => contexts.dispose(),
		health: async (): Promise<boolean> => {
			try {
				const lease = await contexts.acquire();
				lease.release();
				return true;
			} catch (e) {
				logger?.warn(`[browser] health check failed: ${e}`);
				return false;
			}
		},
	};
}

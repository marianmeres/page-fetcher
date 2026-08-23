/**
 * The structural driver interface the browser adapter is written against.
 *
 * Two decisions are baked in here. **Drivers are injected, never lazily imported**: a
 * dynamic `import("playwright")` has no spelling that works for both JSR and npm
 * consumers (a bare specifier is unmapped in Deno, `npm:playwright` is invalid in the
 * npm build, and a computed specifier evades both toolchains' analysis), so the caller
 * imports the driver package and hands it to a bridge — see `playwrightDriver` and
 * `puppeteerDriver`. And the interface is **structural**: nothing here imports a type
 * from Playwright or Puppeteer, which keeps the compile-time dependency surface at
 * exactly one type-only import (clog's `Logger`) and makes the whole browser subsystem
 * testable against an in-memory fake driver, with no browser and no network.
 *
 * The surface is deliberately larger than the six methods a "launch, goto, content"
 * sketch suggests, because the adapter needs request interception (resource blocking),
 * three wait shapes, crash detection and capture hooks — and smaller than either real
 * driver, because everything a page-fetcher never does is left out.
 *
 * Two model differences are absorbed by the bridges rather than leaking here:
 * Playwright honors context options at `newContext`, Puppeteer needs the equivalents
 * applied per page ({@linkcode DriverPage.applyPageOptions}); and "network idle" is a
 * fixed 500 ms window in Playwright but configurable in Puppeteer, so it is its own
 * operation instead of a `waitUntil` value.
 *
 * @module
 */

/**
 * Browsing-context options.
 *
 * Not every driver can honor every option — check
 * {@linkcode BrowserDriver.capabilities} before promising a caller that `locale`
 * applies.
 */
export interface DriverContextOptions {
	/** `User-Agent` for every request from this context. */
	userAgent?: string;
	/** Viewport size, or `null` for the driver's default. */
	viewport?: { width: number; height: number } | null;
	/** BCP-47 locale, e.g. `"sk-SK"`. Puppeteer approximates it with `Accept-Language`. */
	locale?: string;
	/** IANA timezone, e.g. `"Europe/Bratislava"`. */
	timezoneId?: string;
	/** Default `true`. `false` is the cheap way to fetch server-rendered HTML. */
	javaScriptEnabled?: boolean;
	/** Extra headers on every request from this context. */
	extraHTTPHeaders?: Record<string, string>;
}

/** What a navigation reports back — the HTTP half of a browser fetch. */
export interface DriverNavResult {
	/** Status of the final response. */
	status: number;
	/** Status text, when the driver exposes one. */
	statusText?: string;
	/** Response headers of the final response, keys lowercased. */
	headers: Record<string, string>;
	/** HTTP redirect chain, oldest first, excluding the final URL. */
	redirects: string[];
	/** End of the HTTP redirect chain — not necessarily where the page ended up. */
	finalUrl: string;
}

/** One page (tab). Created per request by the adapter, or reused from the pool. */
export interface DriverPage {
	/**
	 * Navigate. `waitUntil` is narrowed to the two states both drivers implement
	 * identically; anything more patient is expressed with the `waitFor*` operations.
	 */
	goto(
		url: string,
		opts: { waitUntil: "load" | "domcontentloaded"; timeout: number },
	): Promise<DriverNavResult>;
	/**
	 * Wait until the network has been quiet for `idleMs`.
	 *
	 * `idleMs` is a request, not a promise: Playwright's window is a fixed 500 ms and
	 * the value is ignored there.
	 */
	waitForNetworkIdle(opts: { idleMs: number; timeout: number }): Promise<void>;
	/** Wait for a selector to appear. */
	waitForSelector(selector: string, opts: { timeout: number }): Promise<void>;
	/**
	 * Wait until a predicate returns truthy in the page.
	 *
	 * The predicate is a **self-contained function source string** — the two drivers
	 * order the `(fn, args, options)` parameters differently, and a string sidesteps
	 * the difference completely.
	 */
	waitForFunction(fn: string, opts: { timeout: number }): Promise<void>;
	/** Serialized DOM, after scripts have run. */
	content(): Promise<string>;
	/** Document title. */
	title(): Promise<string>;
	/** Where the page actually is now — history API and client-side routing included. */
	url(): string;
	/**
	 * Install a request filter. Must be called **before** `goto`, and at most once per
	 * page: returning `"abort"` blocks the request, `"continue"` lets it through.
	 */
	setRequestFilter(
		filter: (req: { url: string; resourceType: string }) => "abort" | "continue",
	): Promise<void>;
	/** Console errors and uncaught page exceptions. */
	onConsoleError(cb: (text: string) => void): void;
	/** Requests that never completed. */
	onRequestFailed(cb: (info: { url: string; failure: string }) => void): void;
	/** The page (not the browser) died. */
	onCrash(cb: (err: Error) => void): void;
	/**
	 * Apply context options that this driver can only set per page. A no-op for drivers
	 * whose contexts already took them ({@linkcode BrowserDriver.capabilities}).
	 */
	applyPageOptions(opts: DriverContextOptions): Promise<void>;
	/** Close the page. Also the way an in-flight navigation is cancelled. */
	close(): Promise<void>;
	/** The driver's own page object, handed to the adapter's `onPage` hook. */
	raw: unknown;
}

/** An isolated browsing context — its own cookie jar, cache and storage. */
export interface DriverContext {
	/** Open a new page in this context. */
	newPage(): Promise<DriverPage>;
	/** Close the context and every page in it. */
	close(): Promise<void>;
	/** The driver's own context object. */
	raw: unknown;
}

/** A running browser process. */
export interface DriverBrowser {
	/** Create an isolated context. */
	newContext(opts: DriverContextOptions): Promise<DriverContext>;
	/** The browser died or the connection dropped — the pool's crash signal. */
	onDisconnected(cb: () => void): void;
	/** Close the browser. Must be idempotent-safe to call after a crash. */
	close(): Promise<void>;
	/** Child-process id, when the driver exposes one (Puppeteer does, Playwright does not). */
	readonly pid?: number;
	/** The driver's own browser object. */
	raw: unknown;
}

/**
 * A browser automation backend.
 *
 * Implement this to drive something the bundled bridges do not cover; the adapter and
 * the pool never see anything else.
 */
export interface BrowserDriver {
	/** `"playwright"`, `"puppeteer"`, or your own. Reported in logs and errors. */
	readonly name: string;
	/** Launch a browser process. */
	launch(): Promise<DriverBrowser>;
	/**
	 * What this driver can actually honor from {@linkcode DriverContextOptions}. The
	 * adapter warns (via its logger) when a caller sets an option that will be ignored
	 * or approximated, instead of silently dropping it.
	 */
	readonly capabilities: {
		/** True locale emulation (Puppeteer only approximates it with a header). */
		locale: boolean;
		/** Timezone emulation. */
		timezone: boolean;
		/** Options honored at context creation rather than per page. */
		contextOptions: boolean;
	};
}

/** Lowercase every header key, so result mapping never has to care which driver ran. */
export function normalizeHeaders(
	headers: Record<string, string> | undefined | null,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers ?? {})) out[k.toLowerCase()] = v;
	return out;
}

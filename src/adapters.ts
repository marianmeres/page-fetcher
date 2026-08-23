/**
 * Adapters — the things that actually perform I/O at the bottom of a layer stack.
 *
 * Flat barrel, kept in sync with the `deno.json` exports map and the npm build's entry
 * points. See {@linkcode createHttpAdapter} for the plain-`fetch` adapter, and
 * {@linkcode playwrightDriver} / {@linkcode puppeteerDriver} for the browser drivers —
 * which the caller injects, since this package never imports a browser itself.
 *
 * @module
 */

export {
	createHttpAdapter,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_REDIRECTS,
	DEFAULT_USER_AGENT,
} from "./adapters/http.ts";
export type { HttpAdapterOptions } from "./adapters/http.ts";

export {
	DEFAULT_ALLOW_CONTENT_TYPES,
	isAllowedContentType,
	isMetaSniffable,
	parseContentType,
} from "./content-type.ts";
export type { ParsedContentType } from "./content-type.ts";

export {
	decodeText,
	detectBom,
	isSupportedEncoding,
	sniffCharset,
	sniffMetaCharset,
} from "./charset.ts";
export type { CharsetSource, SniffCharsetOptions } from "./charset.ts";

export { readBodyLimited } from "./read-body.ts";
export type { ReadBodyOptions } from "./read-body.ts";

export { normalizeHeaders } from "./adapters/browser/driver.ts";
export type {
	BrowserDriver,
	DriverBrowser,
	DriverContext,
	DriverContextOptions,
	DriverNavResult,
	DriverPage,
} from "./adapters/browser/driver.ts";

export { playwrightDriver } from "./adapters/browser/drivers/playwright.ts";
export type {
	PlaywrightDriverOptions,
	PlaywrightSource,
} from "./adapters/browser/drivers/playwright.ts";

export { puppeteerDriver } from "./adapters/browser/drivers/puppeteer.ts";
export type {
	PuppeteerDriverOptions,
	PuppeteerSource,
} from "./adapters/browser/drivers/puppeteer.ts";

export {
	createBrowserAdapter,
	createSingleContextProvider,
	DEFAULT_BROWSER_MAX_REDIRECTS,
	DEFAULT_CAPTURE_LIMIT,
	DEFAULT_MAX_DOM_BYTES,
} from "./adapters/browser/browser-adapter.ts";
export type {
	BrowserAdapterOptions,
	ContextLease,
	ContextProvider,
	OnPageHook,
} from "./adapters/browser/browser-adapter.ts";

export {
	compileRequestFilter,
	DEFAULT_BLOCKED_RESOURCES,
} from "./adapters/browser/blocking.ts";
export type {
	BlockingOptions,
	RequestFilter,
	ResourceKind,
	UrlPredicate,
} from "./adapters/browser/blocking.ts";

export {
	applyWait,
	browserErrorFrom,
	DEFAULT_NAVIGATION_TIMEOUT,
	DEFAULT_NETWORK_IDLE,
	DEFAULT_WAIT,
	normalizeWait,
} from "./adapters/browser/wait.ts";
export type {
	ApplyWaitOptions,
	BrowserErrorContext,
	NetworkIdleOptions,
	WaitOutcome,
	WaitStrategy,
} from "./adapters/browser/wait.ts";

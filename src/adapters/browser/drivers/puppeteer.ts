/**
 * Puppeteer bridge.
 *
 * Holds no import of `puppeteer` at module scope — it only touches the object handed to
 * it — so importing this package never pulls a browser in. The caller installs
 * Puppeteer and injects it:
 *
 * ```ts ignore
 * import puppeteer from "puppeteer";
 * import { puppeteerDriver } from "@marianmeres/page-fetcher/adapters";
 *
 * const driver = puppeteerDriver(puppeteer);
 * ```
 *
 * Two things differ from the Playwright bridge, and both are absorbed here rather than
 * in the adapter: Puppeteer's contexts take no options, so `userAgent`, `viewport` and
 * friends are applied per page; and there is no locale emulation at all, so `locale` is
 * approximated with an `Accept-Language` header and reported as unsupported in
 * `capabilities`.
 *
 * @module
 */

import type {
	BrowserDriver,
	DriverBrowser,
	DriverContext,
	DriverContextOptions,
	DriverNavResult,
	DriverPage,
} from "../driver.ts";
import { normalizeHeaders } from "../driver.ts";

/**
 * What {@linkcode puppeteerDriver} accepts: Puppeteer's default export, or a namespace
 * import carrying it as `.default`.
 *
 * Typed `unknown` throughout on purpose — see the note on `PlaywrightSource`; the shape
 * is validated at call time instead.
 */
export interface PuppeteerSource {
	/** `puppeteer.launch` */
	launch?: unknown;
	/** Present when the module was imported as a namespace. */
	default?: unknown;
}

/** Options of {@linkcode puppeteerDriver}. */
export interface PuppeteerDriverOptions {
	/**
	 * Passed to `puppeteer.launch()` verbatim — `headless`, `executablePath`,
	 * `args: ["--no-sandbox"]`, and anything else Puppeteer accepts.
	 */
	launchOptions?: Record<string, unknown>;
	/** Driver name, reported in logs. Default `"puppeteer"`. */
	name?: string;
}

// ---------------------------------------------------------------------------
// The slice of Puppeteer this bridge touches. Internal: the injected object is
// validated at runtime and cast, so these shapes never have to line up with
// Puppeteer's real declarations.
// ---------------------------------------------------------------------------

interface PptRequest {
	url(): string;
	resourceType(): string;
	redirectChain(): PptRequest[];
	failure(): { errorText: string } | null;
	abort(): Promise<void>;
	continue(): Promise<void>;
}

interface PptResponse {
	status(): number;
	statusText(): string;
	headers(): Record<string, string>;
	url(): string;
	request(): PptRequest;
}

interface PptConsoleMessage {
	type(): string;
	text(): string;
}

interface PptPage {
	goto(url: string, options?: unknown): Promise<PptResponse | null>;
	waitForNetworkIdle(options?: unknown): Promise<void>;
	waitForSelector(selector: string, options?: unknown): Promise<unknown>;
	waitForFunction(fn: unknown, options?: unknown): Promise<unknown>;
	content(): Promise<string>;
	title(): Promise<string>;
	url(): string;
	setRequestInterception(enabled: boolean): Promise<void>;
	setUserAgent(userAgent: string): Promise<void>;
	setViewport(viewport: { width: number; height: number }): Promise<void>;
	setJavaScriptEnabled(enabled: boolean): Promise<void>;
	setExtraHTTPHeaders(headers: Record<string, string>): Promise<void>;
	emulateTimezone(timezoneId: string): Promise<void>;
	on(event: string, cb: (arg: never) => void): unknown;
	close(): Promise<void>;
}

interface PptContext {
	newPage(): Promise<PptPage>;
	close(): Promise<void>;
}

interface PptBrowser {
	/** Renamed from `createIncognitoBrowserContext` in Puppeteer 22 — both are tried. */
	createBrowserContext?(): Promise<PptContext>;
	createIncognitoBrowserContext?(): Promise<PptContext>;
	/** Not every build exposes the child process (a remote connection has none). */
	process?(): { pid?: number } | null;
	on(event: string, cb: () => void): unknown;
	close(): Promise<void>;
}

interface PptLauncher {
	launch(options?: unknown): Promise<PptBrowser>;
}

function toNavResult(response: PptResponse): DriverNavResult {
	return {
		status: response.status(),
		statusText: response.statusText() || undefined,
		headers: normalizeHeaders(response.headers()),
		// already chronological, and it excludes the final request
		redirects: response.request().redirectChain().map((r) => r.url()),
		finalUrl: response.url(),
	};
}

function wrapPage(page: PptPage): DriverPage {
	return {
		async goto(url, opts): Promise<DriverNavResult> {
			const response = await page.goto(url, {
				waitUntil: opts.waitUntil,
				timeout: opts.timeout,
			});
			if (!response) {
				throw new Error(`Puppeteer returned no response navigating to ${url}`);
			}
			return toNavResult(response);
		},
		async waitForNetworkIdle({ idleMs, timeout }): Promise<void> {
			await page.waitForNetworkIdle({ idleTime: idleMs, timeout });
		},
		async waitForSelector(selector, { timeout }): Promise<void> {
			await page.waitForSelector(selector, { timeout });
		},
		async waitForFunction(fn, { timeout }): Promise<void> {
			await page.waitForFunction(fn, { timeout });
		},
		content: () => page.content(),
		title: () => page.title(),
		url: () => page.url(),
		async setRequestFilter(filter): Promise<void> {
			await page.setRequestInterception(true);
			page.on("request", (request: PptRequest) => {
				const verdict = filter({
					url: request.url(),
					resourceType: request.resourceType(),
				});
				// the page may be gone by the time we answer; losing that race is
				// normal and must not become an unhandled rejection
				const answered = verdict === "abort"
					? request.abort()
					: request.continue();
				answered.catch(() => {});
			});
		},
		onConsoleError(cb): void {
			page.on("console", (message: PptConsoleMessage) => {
				if (message.type() === "error") cb(message.text());
			});
			page.on("pageerror", (error: Error) => cb(error?.message ?? String(error)));
		},
		onRequestFailed(cb): void {
			page.on("requestfailed", (request: PptRequest) => {
				cb({
					url: request.url(),
					failure: request.failure?.()?.errorText ?? "unknown",
				});
			});
		},
		onCrash(cb): void {
			// Puppeteer reports a page crash as an "error" event
			page.on("error", (error: Error) => cb(error ?? new Error("page crashed")));
		},
		/** Puppeteer contexts take no options, so the equivalents land here. */
		async applyPageOptions(opts: DriverContextOptions): Promise<void> {
			if (opts.userAgent) await page.setUserAgent(opts.userAgent);
			if (opts.viewport) await page.setViewport(opts.viewport);
			if (opts.javaScriptEnabled !== undefined) {
				await page.setJavaScriptEnabled(opts.javaScriptEnabled);
			}
			if (opts.timezoneId) await page.emulateTimezone(opts.timezoneId);

			const headers = normalizeHeaders(opts.extraHTTPHeaders);
			// no locale emulation exists here — this is the closest honest equivalent
			if (opts.locale && !headers["accept-language"]) {
				headers["accept-language"] = opts.locale;
			}
			if (Object.keys(headers).length) await page.setExtraHTTPHeaders(headers);
		},
		close: () => page.close(),
		raw: page,
	};
}

function wrapContext(context: PptContext): DriverContext {
	return {
		newPage: async (): Promise<DriverPage> => wrapPage(await context.newPage()),
		close: () => context.close(),
		raw: context,
	};
}

/**
 * Note what is missing: context options. Puppeteer's contexts take none, so the whole
 * of {@linkcode DriverContextOptions} is applied per page instead — see
 * `applyPageOptions` above, and `capabilities.contextOptions: false` below.
 */
function wrapBrowser(browser: PptBrowser): DriverBrowser {
	return {
		async newContext(): Promise<DriverContext> {
			const create = browser.createBrowserContext ??
				browser.createIncognitoBrowserContext;
			if (typeof create !== "function") {
				throw new TypeError(
					"puppeteerDriver: the browser exposes neither createBrowserContext " +
						"nor createIncognitoBrowserContext",
				);
			}
			return wrapContext(await create.call(browser));
		},
		onDisconnected(cb): void {
			browser.on("disconnected", cb);
		},
		close: () => browser.close(),
		pid: browser.process?.()?.pid,
		raw: browser,
	};
}

/** A short, useful description of a wrong argument. */
function describe(value: unknown): string {
	if (value === null || value === undefined) return String(value);
	if (typeof value !== "object") return typeof value;
	const keys = Object.keys(value as object);
	return keys.length ? `an object with keys: ${keys.join(", ")}` : "an empty object";
}

/**
 * Bridge an injected Puppeteer module to a {@linkcode BrowserDriver}.
 *
 * The argument is validated immediately, so a wrong import shape fails at wiring time
 * with a message that names what was expected — not on the first fetch, minutes later.
 *
 * @example
 * ```ts ignore
 * import puppeteer from "puppeteer";
 *
 * const driver = puppeteerDriver(puppeteer, {
 * 	launchOptions: { headless: true, args: ["--no-sandbox"] },
 * });
 * ```
 */
export function puppeteerDriver(
	source: PuppeteerSource,
	options: PuppeteerDriverOptions = {},
): BrowserDriver {
	const { launchOptions, name = "puppeteer" } = options;
	const launcher = ((source as { default?: unknown })?.default ?? source) as
		| PptLauncher
		| undefined;
	if (!launcher || typeof launcher.launch !== "function") {
		throw new TypeError(
			`puppeteerDriver: expected the puppeteer module (with a "launch" method), ` +
				`got ${describe(source)}`,
		);
	}

	return {
		name,
		launch: async (): Promise<DriverBrowser> =>
			wrapBrowser(await launcher.launch(launchOptions)),
		capabilities: { locale: false, timezone: true, contextOptions: false },
	};
}

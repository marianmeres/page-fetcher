/**
 * Playwright bridge.
 *
 * Holds no import of `playwright` at module scope — it only touches the object handed
 * to it — so importing this package never pulls a browser in, and the zero-runtime-
 * dependency promise stays literally true. The caller installs Playwright and injects
 * it:
 *
 * ```ts ignore
 * import * as playwright from "playwright";
 * import { playwrightDriver } from "@marianmeres/page-fetcher/adapters";
 *
 * const driver = playwrightDriver(playwright, { browser: "chromium" });
 * ```
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
 * What {@linkcode playwrightDriver} accepts: the `playwright` module itself, or a
 * single browser type such as `playwright.chromium`.
 *
 * Every member is typed `unknown` on purpose — a structurally precise stand-in for
 * Playwright's own types would be a compile-time dependency in all but name, and would
 * reject perfectly good module shapes over an irrelevant signature detail. The shape is
 * validated at call time instead, where a wrong argument produces a message that says
 * what was expected.
 */
export interface PlaywrightSource {
	/** `playwright.chromium` */
	chromium?: unknown;
	/** `playwright.firefox` */
	firefox?: unknown;
	/** `playwright.webkit` */
	webkit?: unknown;
	/** Present when a single browser type was passed instead of the module. */
	launch?: unknown;
	/** Present when the module was imported as a namespace with a default export. */
	default?: unknown;
}

/** Options of {@linkcode playwrightDriver}. */
export interface PlaywrightDriverOptions {
	/** Which engine to launch. Default `"chromium"`. */
	browser?: "chromium" | "firefox" | "webkit";
	/**
	 * Passed to `browserType.launch()` verbatim — `headless`, `executablePath`,
	 * `args: ["--no-sandbox"]`, `proxy`, and anything else Playwright accepts.
	 */
	launchOptions?: Record<string, unknown>;
	/** Driver name, reported in logs. Default `"playwright"`. */
	name?: string;
}

// ---------------------------------------------------------------------------
// The slice of Playwright this bridge touches. Internal: the injected object is
// validated at runtime and cast, so these shapes never have to line up with
// Playwright's real declarations.
// ---------------------------------------------------------------------------

interface PwRequest {
	url(): string;
	resourceType(): string;
	redirectedFrom(): PwRequest | null;
}

interface PwResponse {
	status(): number;
	statusText(): string;
	headers(): Record<string, string>;
	url(): string;
	request(): PwRequest;
}

interface PwRoute {
	request(): PwRequest;
	abort(errorCode?: string): Promise<void>;
	continue(): Promise<void>;
}

interface PwFailedRequest extends PwRequest {
	failure(): { errorText: string } | null;
}

interface PwConsoleMessage {
	type(): string;
	text(): string;
}

interface PwPage {
	goto(url: string, options?: unknown): Promise<PwResponse | null>;
	waitForLoadState(state: string, options?: unknown): Promise<void>;
	waitForSelector(selector: string, options?: unknown): Promise<unknown>;
	waitForFunction(fn: unknown, arg?: unknown, options?: unknown): Promise<unknown>;
	content(): Promise<string>;
	title(): Promise<string>;
	url(): string;
	route(pattern: string, handler: (route: PwRoute) => void): Promise<void>;
	on(event: string, cb: (arg: never) => void): unknown;
	close(): Promise<void>;
}

interface PwContext {
	newPage(): Promise<PwPage>;
	close(): Promise<void>;
}

interface PwBrowser {
	newContext(options?: unknown): Promise<PwContext>;
	on(event: string, cb: () => void): unknown;
	close(): Promise<void>;
}

interface PwBrowserType {
	launch(options?: unknown): Promise<PwBrowser>;
}

/** Walk `redirectedFrom()` back to the start of the chain, oldest first. */
function redirectChain(response: PwResponse): string[] {
	const chain: string[] = [];
	let previous = response.request().redirectedFrom();
	while (previous) {
		chain.unshift(previous.url());
		previous = previous.redirectedFrom();
	}
	return chain;
}

function toNavResult(response: PwResponse): DriverNavResult {
	return {
		status: response.status(),
		statusText: response.statusText() || undefined,
		headers: normalizeHeaders(response.headers()),
		redirects: redirectChain(response),
		finalUrl: response.url(),
	};
}

function wrapPage(page: PwPage): DriverPage {
	return {
		async goto(url, opts): Promise<DriverNavResult> {
			const response = await page.goto(url, {
				waitUntil: opts.waitUntil,
				timeout: opts.timeout,
			});
			if (!response) {
				// same-document navigations and about:blank — nothing to report on
				throw new Error(`Playwright returned no response navigating to ${url}`);
			}
			return toNavResult(response);
		},
		async waitForNetworkIdle({ timeout }): Promise<void> {
			// Playwright's idle window is a fixed 500 ms, so idleMs cannot apply
			await page.waitForLoadState("networkidle", { timeout });
		},
		async waitForSelector(selector, { timeout }): Promise<void> {
			await page.waitForSelector(selector, { timeout });
		},
		async waitForFunction(fn, { timeout }): Promise<void> {
			await page.waitForFunction(fn, undefined, { timeout });
		},
		content: () => page.content(),
		title: () => page.title(),
		url: () => page.url(),
		async setRequestFilter(filter): Promise<void> {
			await page.route("**/*", (route) => {
				const request = route.request();
				const verdict = filter({
					url: request.url(),
					resourceType: request.resourceType(),
				});
				// the page may be gone by the time we answer; losing that race is
				// normal and must not become an unhandled rejection
				const answered = verdict === "abort" ? route.abort() : route.continue();
				answered.catch(() => {});
			});
		},
		onConsoleError(cb): void {
			page.on("console", (message: PwConsoleMessage) => {
				if (message.type() === "error") cb(message.text());
			});
			// an uncaught exception in page scripts is a page error, not a console one
			page.on("pageerror", (error: Error) => cb(error?.message ?? String(error)));
		},
		onRequestFailed(cb): void {
			page.on("requestfailed", (request: PwFailedRequest) => {
				cb({
					url: request.url(),
					failure: request.failure?.()?.errorText ?? "unknown",
				});
			});
		},
		onCrash(cb): void {
			page.on("crash", () => cb(new Error("Playwright page crashed")));
		},
		// context options were already honored at newContext()
		applyPageOptions: (): Promise<void> => Promise.resolve(),
		close: () => page.close(),
		raw: page,
	};
}

function wrapContext(context: PwContext): DriverContext {
	return {
		newPage: async (): Promise<DriverPage> => wrapPage(await context.newPage()),
		close: () => context.close(),
		raw: context,
	};
}

function wrapBrowser(browser: PwBrowser): DriverBrowser {
	return {
		async newContext(opts: DriverContextOptions): Promise<DriverContext> {
			return wrapContext(await browser.newContext(opts));
		},
		onDisconnected(cb): void {
			browser.on("disconnected", cb);
		},
		close: () => browser.close(),
		raw: browser,
	};
}

/** Pick the browser type out of whatever was injected. */
function resolveBrowserType(
	source: PlaywrightSource,
	which: "chromium" | "firefox" | "webkit",
): PwBrowserType {
	const module = (source?.default ?? source) as PlaywrightSource | undefined;
	const candidate = (module?.[which] ?? module) as PwBrowserType | undefined;
	if (!candidate || typeof candidate.launch !== "function") {
		throw new TypeError(
			`playwrightDriver: expected the playwright module (with a "${which}" ` +
				`browser type) or a browser type itself, got ${describe(source)}`,
		);
	}
	return candidate;
}

/** A short, useful description of a wrong argument. */
function describe(value: unknown): string {
	if (value === null || value === undefined) return String(value);
	if (typeof value !== "object") return typeof value;
	const keys = Object.keys(value as object);
	return keys.length ? `an object with keys: ${keys.join(", ")}` : "an empty object";
}

/**
 * Bridge an injected Playwright module (or a single browser type) to a
 * {@linkcode BrowserDriver}.
 *
 * The argument is validated immediately, so a wrong import shape fails at wiring time
 * with a message that names what was expected — not on the first fetch, minutes later.
 *
 * @example
 * ```ts ignore
 * import * as playwright from "playwright";
 *
 * const driver = playwrightDriver(playwright, {
 * 	browser: "chromium",
 * 	launchOptions: { headless: true, args: ["--no-sandbox"] },
 * });
 * ```
 */
export function playwrightDriver(
	source: PlaywrightSource,
	options: PlaywrightDriverOptions = {},
): BrowserDriver {
	const { browser = "chromium", launchOptions, name = "playwright" } = options;
	const browserType = resolveBrowserType(source, browser);

	return {
		name,
		launch: async (): Promise<DriverBrowser> =>
			wrapBrowser(await browserType.launch(launchOptions)),
		capabilities: { locale: true, timezone: true, contextOptions: true },
	};
}

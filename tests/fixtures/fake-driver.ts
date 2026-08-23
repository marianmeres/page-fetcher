/**
 * A scriptable in-memory {@linkcode BrowserDriver}.
 *
 * This is why the driver interface exists: the pool, the wait strategies, crash
 * recovery and result mapping only ever see `BrowserDriver`, so their entire test suite
 * can run with no browser, no network and no real time — a crash becomes
 * `route.crash: true` and a hang becomes `route.delay: 30_000` under `FakeTime`.
 *
 * It lives here, not under `tests/browser/`, because that directory is excluded from
 * the default test task (it is the flagged real-browser suite) and these tests must
 * always run.
 */

import type {
	BrowserDriver,
	DriverBrowser,
	DriverContext,
	DriverContextOptions,
	DriverNavResult,
	DriverPage,
} from "../../src/adapters/browser/driver.ts";
import { sleep } from "../../src/utils.ts";

/** How the fake answers one URL. Every field is optional; the defaults are a boring 200. */
export interface FakeRoute {
	/** Default `200`. */
	status?: number;
	/** Default `"OK"`. */
	statusText?: string;
	/** Response headers. Default `{ "content-type": "text/html; charset=utf-8" }`. */
	headers?: Record<string, string>;
	/** Serialized DOM returned by `content()`. */
	html?: string;
	/** Document title. */
	title?: string;
	/** HTTP redirect chain, oldest first. */
	redirects?: string[];
	/** End of the HTTP redirect chain. Defaults to the requested URL. */
	finalUrl?: string;
	/** Where the page ends up after client-side routing. Defaults to `finalUrl`. */
	pageUrl?: string;
	/** Milliseconds the navigation takes. Exceeding `goto`'s timeout fails it. */
	delay?: number;
	/** `goto` rejects with this message instead of navigating. */
	error?: string;
	/** The page crashes during the navigation. */
	crash?: boolean;
	/** The browser process dies during the navigation. */
	killBrowser?: boolean;
	/** Console errors emitted while navigating. */
	consoleErrors?: string[];
	/** Failed requests emitted while navigating. */
	requestFailures?: { url: string; failure: string }[];
	/** Subresources offered to the installed request filter. */
	resources?: { url: string; resourceType: string }[];
	/** How long the network takes to go quiet. Exceeding the timeout fails the wait. */
	networkIdleAfter?: number;
	/** Selectors that never appear. */
	missingSelectors?: string[];
	/** `waitForFunction` never becomes truthy. */
	functionNeverTrue?: boolean;
}

/** Options of {@linkcode fakeDriver}. */
export interface FakeDriverOptions {
	/** Driver name. Default `"fake"`. */
	name?: string;
	/** Routes keyed by exact URL. */
	routes?: Record<string, FakeRoute>;
	/** Used for any URL without an explicit route. */
	fallback?: FakeRoute;
	/** Fail this many launches before the first successful one. */
	failLaunches?: number;
	/** Milliseconds a launch takes. */
	launchDelay?: number;
	/** Kill the browser once this many pages have been opened on it. */
	crashAfterPages?: number;
	/** Overrides the reported capabilities. */
	capabilities?: Partial<BrowserDriver["capabilities"]>;
}

/** A fake browser, with the extra handles a test needs. */
export interface FakeBrowser extends DriverBrowser {
	/** Fire the disconnected listeners, exactly as a real crash would. */
	crash(): void;
	/** Still usable? */
	readonly alive: boolean;
	/** Pages opened on this browser and not yet closed. */
	readonly openPages: number;
}

/** Counters every test can assert on. */
export interface FakeStats {
	launches: number;
	contexts: number;
	pages: number;
	closedPages: number;
	closedContexts: number;
	closedBrowsers: number;
	gotos: number;
}

/** The driver plus its inspection surface. */
export interface FakeDriver extends BrowserDriver {
	/** Narrowed: a test always gets the inspectable browser back. */
	launch(): Promise<FakeBrowser>;
	/** Ordered operation log: `"launch"`, `"newContext"`, `"goto <url>"`, … */
	readonly log: string[];
	/** Live counters. */
	readonly stats: FakeStats;
	/** URLs the installed request filter aborted. */
	readonly blocked: string[];
	/** URLs the installed request filter let through. */
	readonly loaded: string[];
	/** Context options each context was created with, in creation order. */
	readonly contextOptions: DriverContextOptions[];
	/** Context options applied per page (the Puppeteer-shaped path). */
	readonly pageOptions: DriverContextOptions[];
	/** Every browser launched, oldest first. */
	readonly browsers: FakeBrowser[];
	/** Kill every live browser. */
	crashAll(): void;
}

const DEFAULT_ROUTE: FakeRoute = {};

/** A timeout failure shaped like the ones the real drivers throw. */
function timeoutError(what: string, ms: number): Error {
	return new Error(`Timeout ${ms}ms exceeded waiting for ${what}`);
}

/**
 * Build a scriptable in-memory driver.
 *
 * @example
 * ```ts
 * const driver = fakeDriver({
 * 	routes: {
 * 		"http://x.test/": { html: "<html><body>hi</body></html>", title: "hi" },
 * 		"http://x.test/slow": { delay: 30_000 },
 * 		"http://x.test/boom": { crash: true },
 * 	},
 * });
 * ```
 */
export function fakeDriver(options: FakeDriverOptions = {}): FakeDriver {
	const {
		name = "fake",
		routes = {},
		fallback = DEFAULT_ROUTE,
		failLaunches = 0,
		launchDelay = 0,
		crashAfterPages,
		capabilities,
	} = options;

	const log: string[] = [];
	const blocked: string[] = [];
	const loaded: string[] = [];
	const contextOptions: DriverContextOptions[] = [];
	const pageOptions: DriverContextOptions[] = [];
	const browsers: FakeBrowser[] = [];
	const stats: FakeStats = {
		launches: 0,
		contexts: 0,
		pages: 0,
		closedPages: 0,
		closedContexts: 0,
		closedBrowsers: 0,
		gotos: 0,
	};

	const routeFor = (url: string): FakeRoute => routes[url] ?? fallback;

	function makePage(browser: FakeBrowser & { markPageClosed(): void }): DriverPage {
		let filter:
			| ((r: { url: string; resourceType: string }) => "abort" | "continue")
			| undefined;
		const consoleCbs: ((text: string) => void)[] = [];
		const failedCbs: ((info: { url: string; failure: string }) => void)[] = [];
		const crashCbs: ((err: Error) => void)[] = [];
		// closing a page is how the adapter cancels an in-flight navigation, so the
		// fake has to model exactly that
		const closer = new AbortController();
		let closed = false;
		let current = "about:blank";
		// the route the last navigation used: `current` may have moved on to a
		// client-side URL that matches no route key at all
		let active: FakeRoute = DEFAULT_ROUTE;
		const raw = { fake: "page", url: () => current };

		/** Sleep, but abort when the page closes — and fail when the budget runs out. */
		async function wait(ms: number, budget: number, what: string): Promise<void> {
			if (ms > budget) {
				await sleep(budget, closer.signal);
				throw timeoutError(what, budget);
			}
			if (ms > 0) await sleep(ms, closer.signal);
		}

		return {
			async goto(url, opts): Promise<DriverNavResult> {
				if (closed) throw new Error("Fake page is closed");
				if (!browser.alive) throw new Error("Fake browser is not running");
				log.push(`goto ${url}`);
				stats.gotos++;
				const route = routeFor(url);
				active = route;

				for (const resource of route.resources ?? []) {
					const verdict = filter?.(resource) ?? "continue";
					(verdict === "abort" ? blocked : loaded).push(resource.url);
				}
				for (const text of route.consoleErrors ?? []) {
					for (const cb of consoleCbs) cb(text);
				}
				for (const failure of route.requestFailures ?? []) {
					for (const cb of failedCbs) cb(failure);
				}

				await wait(route.delay ?? 0, opts.timeout, `navigation to ${url}`);

				if (route.crash) {
					const err = new Error("Fake page crashed");
					for (const cb of crashCbs) cb(err);
					throw err;
				}
				if (route.killBrowser) {
					browser.crash();
					throw new Error("Fake browser is not running");
				}
				if (route.error) throw new Error(route.error);

				const finalUrl = route.finalUrl ?? url;
				current = route.pageUrl ?? finalUrl;
				return {
					status: route.status ?? 200,
					statusText: route.statusText ?? "OK",
					headers: route.headers ??
						{ "content-type": "text/html; charset=utf-8" },
					redirects: route.redirects ?? [],
					finalUrl,
				};
			},
			async waitForNetworkIdle({ timeout }): Promise<void> {
				await wait(active.networkIdleAfter ?? 0, timeout, "network idle");
			},
			async waitForSelector(selector, { timeout }): Promise<void> {
				const missing = active.missingSelectors?.includes(selector);
				await wait(missing ? Infinity : 0, timeout, `selector "${selector}"`);
			},
			async waitForFunction(_fn, { timeout }): Promise<void> {
				await wait(active.functionNeverTrue ? Infinity : 0, timeout, "function");
			},
			content: (): Promise<string> =>
				Promise.resolve(active.html ?? "<html><body>fake</body></html>"),
			title: (): Promise<string> => Promise.resolve(active.title ?? ""),
			url: () => current,
			setRequestFilter(next): Promise<void> {
				filter = next;
				return Promise.resolve();
			},
			onConsoleError(cb): void {
				consoleCbs.push(cb);
			},
			onRequestFailed(cb): void {
				failedCbs.push(cb);
			},
			onCrash(cb): void {
				crashCbs.push(cb);
			},
			applyPageOptions(opts): Promise<void> {
				pageOptions.push(opts);
				return Promise.resolve();
			},
			close(): Promise<void> {
				if (!closed) {
					closed = true;
					stats.closedPages++;
					browser.markPageClosed();
					closer.abort(new Error("Fake page closed"));
					log.push("close page");
				}
				return Promise.resolve();
			},
			raw,
		};
	}

	function makeBrowser(): FakeBrowser {
		const disconnected: (() => void)[] = [];
		let alive = true;
		let open = 0;
		let pagesOpened = 0;

		const browser: FakeBrowser & { markPageClosed(): void } = {
			async newContext(opts: DriverContextOptions): Promise<DriverContext> {
				if (!alive) throw new Error("Fake browser is not running");
				log.push("newContext");
				stats.contexts++;
				contextOptions.push(opts);
				let contextClosed = false;
				await Promise.resolve();
				return {
					newPage: (): Promise<DriverPage> => {
						if (!alive) {
							return Promise.reject(
								new Error("Fake browser is not running"),
							);
						}
						if (contextClosed) {
							return Promise.reject(new Error("Fake context is closed"));
						}
						log.push("newPage");
						stats.pages++;
						open++;
						pagesOpened++;
						const page = makePage(browser);
						if (
							crashAfterPages !== undefined &&
							pagesOpened > crashAfterPages
						) {
							browser.crash();
						}
						return Promise.resolve(page);
					},
					close: (): Promise<void> => {
						if (!contextClosed) {
							contextClosed = true;
							stats.closedContexts++;
							log.push("close context");
						}
						return Promise.resolve();
					},
					raw: { fake: "context" },
				};
			},
			onDisconnected(cb): void {
				disconnected.push(cb);
			},
			close(): Promise<void> {
				if (alive) {
					alive = false;
					stats.closedBrowsers++;
					log.push("close browser");
				}
				return Promise.resolve();
			},
			crash(): void {
				if (!alive) return;
				alive = false;
				log.push("crash browser");
				for (const cb of disconnected) cb();
			},
			markPageClosed(): void {
				open--;
			},
			get alive(): boolean {
				return alive;
			},
			get openPages(): number {
				return open;
			},
			raw: { fake: "browser" },
		};
		return browser;
	}

	return {
		name,
		async launch(): Promise<FakeBrowser> {
			log.push("launch");
			stats.launches++;
			if (launchDelay) await sleep(launchDelay);
			if (stats.launches <= failLaunches) {
				throw new Error(`Fake launch #${stats.launches} failed`);
			}
			const browser = makeBrowser();
			browsers.push(browser);
			return browser;
		},
		capabilities: {
			locale: true,
			timezone: true,
			contextOptions: true,
			...capabilities,
		},
		log,
		stats,
		blocked,
		loaded,
		contextOptions,
		pageOptions,
		browsers,
		crashAll(): void {
			for (const browser of browsers) browser.crash();
		},
	};
}

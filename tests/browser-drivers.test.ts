/**
 * Driver-bridge unit tests.
 *
 * The bridges are the package's mapping table between one internal interface and two
 * third-party APIs, so they are tested the way a mapping table should be: against
 * hand-built mock modules shaped like Playwright and Puppeteer. Neither package is
 * installed, and neither needs to be — that is the entire point of the structural
 * interface. The fake driver gets the same treatment, because everything downstream
 * (pool, adapter) will be tested through it.
 */
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { normalizeHeaders } from "../src/adapters/browser/driver.ts";
import { playwrightDriver } from "../src/adapters/browser/drivers/playwright.ts";
import { puppeteerDriver } from "../src/adapters/browser/drivers/puppeteer.ts";
import { fakeDriver } from "./fixtures/fake-driver.ts";
import { settleWithFakeTime as settle } from "./helpers.ts";

/** Collects `on(event, cb)` registrations and lets a test fire them. */
function emitter() {
	const listeners = new Map<string, ((arg: never) => void)[]>();
	return {
		on(event: string, cb: (arg: never) => void): unknown {
			listeners.set(event, [...(listeners.get(event) ?? []), cb]);
			return undefined;
		},
		emit(event: string, arg?: unknown): void {
			for (const cb of listeners.get(event) ?? []) {
				(cb as (a: unknown) => void)(arg);
			}
		},
		has: (event: string) => (listeners.get(event) ?? []).length > 0,
	};
}

// ---------------------------------------------------------------------------
// playwright bridge
// ---------------------------------------------------------------------------

function pwRequest(url: string, from: unknown = null, resourceType = "document") {
	return {
		url: () => url,
		resourceType: () => resourceType,
		redirectedFrom: () => from,
		failure: () => ({ errorText: "net::ERR_CONNECTION_REFUSED" }),
	};
}

function pwMock(config: { nullResponse?: boolean } = {}) {
	const calls: string[] = [];
	const pageEvents = emitter();
	const browserEvents = emitter();
	let routeHandler: ((route: unknown) => void) | undefined;

	const hop1 = pwRequest("http://a.test/1");
	const hop2 = pwRequest("http://a.test/2", hop1);
	const response = {
		status: () => 200,
		statusText: () => "OK",
		headers: () => ({ "Content-Type": "text/html", ETag: '"v1"' }),
		url: () => "http://a.test/3",
		request: () => pwRequest("http://a.test/3", hop2),
	};

	const page = {
		goto(url: string, options?: unknown) {
			calls.push(`goto ${url} ${JSON.stringify(options)}`);
			return Promise.resolve(config.nullResponse ? null : response);
		},
		waitForLoadState(state: string, options?: unknown) {
			calls.push(`waitForLoadState ${state} ${JSON.stringify(options)}`);
			return Promise.resolve();
		},
		waitForSelector(selector: string, options?: unknown) {
			calls.push(`waitForSelector ${selector} ${JSON.stringify(options)}`);
			return Promise.resolve(null);
		},
		waitForFunction(fn: unknown, arg?: unknown, options?: unknown) {
			calls.push(
				`waitForFunction ${fn} arg=${JSON.stringify(arg)} ${
					JSON.stringify(options)
				}`,
			);
			return Promise.resolve(null);
		},
		content: () => Promise.resolve("<html>pw</html>"),
		title: () => Promise.resolve("pw title"),
		url: () => "http://a.test/3#spa",
		route(pattern: string, handler: (route: unknown) => void) {
			calls.push(`route ${pattern}`);
			routeHandler = handler;
			return Promise.resolve();
		},
		on: pageEvents.on,
		close: () => {
			calls.push("close page");
			return Promise.resolve();
		},
	};

	const context = {
		newPage: () => {
			calls.push("newPage");
			return Promise.resolve(page);
		},
		close: () => {
			calls.push("close context");
			return Promise.resolve();
		},
	};

	const browser = {
		newContext(options?: unknown) {
			calls.push(`newContext ${JSON.stringify(options)}`);
			return Promise.resolve(context);
		},
		on: browserEvents.on,
		close: () => {
			calls.push("close browser");
			return Promise.resolve();
		},
	};

	const chromium = {
		launch(options?: unknown) {
			calls.push(`launch ${JSON.stringify(options)}`);
			return Promise.resolve(browser);
		},
	};

	return {
		module: { chromium, firefox: chromium, webkit: chromium },
		calls,
		pageEvents,
		browserEvents,
		fireRoute: (url: string, resourceType: string, sink: string[]) => {
			routeHandler?.({
				request: () => pwRequest(url, null, resourceType),
				abort: () => {
					sink.push(`abort ${url}`);
					return Promise.resolve();
				},
				continue: () => {
					sink.push(`continue ${url}`);
					return Promise.resolve();
				},
			});
		},
	};
}

Deno.test("playwrightDriver: accepts a module, a namespace or a bare browser type", () => {
	const pw = pwMock();
	assertEquals(playwrightDriver(pw.module).name, "playwright");
	assertEquals(playwrightDriver({ default: pw.module }).name, "playwright");
	assertEquals(playwrightDriver(pw.module.chromium).name, "playwright");
	assertEquals(
		playwrightDriver(pw.module, { name: "pw-firefox", browser: "firefox" }).name,
		"pw-firefox",
	);
	assertEquals(playwrightDriver(pw.module).capabilities, {
		locale: true,
		timezone: true,
		contextOptions: true,
	});
});

Deno.test("playwrightDriver: a wrong argument fails at wiring time, descriptively", () => {
	const e = assertThrows(
		() => playwrightDriver({ notAModule: true } as never),
		TypeError,
	);
	assert(e.message.includes('"chromium"'), e.message);
	assert(e.message.includes("notAModule"), e.message);
	assertThrows(() => playwrightDriver(undefined as never), TypeError);
	assertThrows(() => playwrightDriver("playwright" as never), TypeError);
});

Deno.test("playwrightDriver: launch, context options and browser wiring", async () => {
	const pw = pwMock();
	const driver = playwrightDriver(pw.module, {
		launchOptions: { headless: true, args: ["--no-sandbox"] },
	});
	const browser = await driver.launch();
	assertEquals(pw.calls[0], 'launch {"headless":true,"args":["--no-sandbox"]}');
	// Playwright honors context options where they belong: at the context
	const context = await browser.newContext({
		userAgent: "bot/1",
		locale: "sk-SK",
		viewport: { width: 800, height: 600 },
	});
	assert(pw.calls[1].startsWith('newContext {"userAgent":"bot/1"'));
	assertEquals(browser.pid, undefined);

	let disconnected = 0;
	browser.onDisconnected(() => disconnected++);
	pw.browserEvents.emit("disconnected");
	assertEquals(disconnected, 1);

	const page = await context.newPage();
	// ... and needs nothing applied per page
	await page.applyPageOptions({ userAgent: "ignored" });
	assert(!pw.calls.some((c) => c.includes("setUserAgent")));

	await page.close();
	await context.close();
	await browser.close();
	assertEquals(pw.calls.slice(-3), ["close page", "close context", "close browser"]);
});

Deno.test("playwrightDriver: navigation mapping — headers, redirect chain, finalUrl", async () => {
	const pw = pwMock();
	const page = await (await (await playwrightDriver(pw.module).launch())
		.newContext({})).newPage();

	const nav = await page.goto("http://a.test/1", {
		waitUntil: "load",
		timeout: 15_000,
	});
	assertEquals(
		pw.calls.at(-1),
		'goto http://a.test/1 {"waitUntil":"load","timeout":15000}',
	);
	assertEquals(nav.status, 200);
	assertEquals(nav.statusText, "OK");
	// header keys are lowercased for everyone downstream
	assertEquals(nav.headers, { "content-type": "text/html", etag: '"v1"' });
	// redirectedFrom() is walked backwards, reported oldest first, final excluded
	assertEquals(nav.redirects, ["http://a.test/1", "http://a.test/2"]);
	assertEquals(nav.finalUrl, "http://a.test/3");
	// the page may have moved on since — that is the adapter's business, not ours
	assertEquals(page.url(), "http://a.test/3#spa");
	assertEquals(await page.content(), "<html>pw</html>");
	assertEquals(await page.title(), "pw title");
});

Deno.test("playwrightDriver: a navigation with no response is a loud failure", async () => {
	const pw = pwMock({ nullResponse: true });
	const page = await (await (await playwrightDriver(pw.module).launch())
		.newContext({})).newPage();
	await assertRejects(
		() => page.goto("http://a.test/1", { waitUntil: "load", timeout: 1 }),
		Error,
		"no response",
	);
});

Deno.test("playwrightDriver: waits map to the right Playwright calls", async () => {
	const pw = pwMock();
	const page = await (await (await playwrightDriver(pw.module).launch())
		.newContext({})).newPage();

	// idleMs cannot apply — Playwright's window is a fixed 500 ms
	await page.waitForNetworkIdle({ idleMs: 250, timeout: 5_000 });
	assertEquals(pw.calls.at(-1), 'waitForLoadState networkidle {"timeout":5000}');

	await page.waitForSelector("#app", { timeout: 3_000 });
	assertEquals(pw.calls.at(-1), 'waitForSelector #app {"timeout":3000}');

	// (fn, arg, options) — Playwright's parameter order
	await page.waitForFunction("() => window.ready", { timeout: 2_000 });
	assertEquals(
		pw.calls.at(-1),
		'waitForFunction () => window.ready arg=undefined {"timeout":2000}',
	);
});

Deno.test("playwrightDriver: request filter, capture hooks and crash", async () => {
	const pw = pwMock();
	const page = await (await (await playwrightDriver(pw.module).launch())
		.newContext({})).newPage();

	const routed: string[] = [];
	await page.setRequestFilter((req) =>
		req.resourceType === "image" ? "abort" : "continue"
	);
	assertEquals(pw.calls.at(-1), "route **/*");
	pw.fireRoute("http://a.test/logo.png", "image", routed);
	pw.fireRoute("http://a.test/app.js", "script", routed);
	assertEquals(routed, [
		"abort http://a.test/logo.png",
		"continue http://a.test/app.js",
	]);

	const consoleErrors: string[] = [];
	page.onConsoleError((text) => consoleErrors.push(text));
	pw.pageEvents.emit("console", { type: () => "warning", text: () => "meh" });
	pw.pageEvents.emit("console", { type: () => "error", text: () => "boom" });
	pw.pageEvents.emit("pageerror", new Error("uncaught"));
	// warnings are not errors; an uncaught exception is
	assertEquals(consoleErrors, ["boom", "uncaught"]);

	const failed: { url: string; failure: string }[] = [];
	page.onRequestFailed((info) => failed.push(info));
	pw.pageEvents.emit("requestfailed", pwRequest("http://a.test/gone"));
	assertEquals(failed, [{
		url: "http://a.test/gone",
		failure: "net::ERR_CONNECTION_REFUSED",
	}]);

	const crashes: Error[] = [];
	page.onCrash((err) => crashes.push(err));
	pw.pageEvents.emit("crash");
	assertEquals(crashes.length, 1);
	assert(crashes[0].message.includes("crashed"));
});

// ---------------------------------------------------------------------------
// puppeteer bridge
// ---------------------------------------------------------------------------

function pptMock(config: { legacyContext?: boolean; noContextApi?: boolean } = {}) {
	const calls: string[] = [];
	const pageEvents = emitter();
	const browserEvents = emitter();
	let requestHandler: ((req: unknown) => void) | undefined;

	const record = (line: string) => {
		calls.push(line);
		return Promise.resolve();
	};

	const page = {
		goto(url: string, options?: unknown) {
			calls.push(`goto ${url} ${JSON.stringify(options)}`);
			return Promise.resolve({
				status: () => 404,
				statusText: () => "",
				headers: () => ({ "X-Trace": "1" }),
				url: () => "http://b.test/final",
				request: () => ({
					url: () => "http://b.test/final",
					resourceType: () => "document",
					redirectChain: () => [
						{ url: () => "http://b.test/1" },
						{ url: () => "http://b.test/2" },
					],
					failure: () => null,
					abort: () => Promise.resolve(),
					continue: () => Promise.resolve(),
				}),
			});
		},
		waitForNetworkIdle: (options?: unknown) =>
			record(`waitForNetworkIdle ${JSON.stringify(options)}`),
		waitForSelector: (selector: string, options?: unknown) =>
			record(`waitForSelector ${selector} ${JSON.stringify(options)}`),
		waitForFunction: (fn: unknown, options?: unknown) =>
			record(`waitForFunction ${fn} ${JSON.stringify(options)}`),
		content: () => Promise.resolve("<html>ppt</html>"),
		title: () => Promise.resolve("ppt title"),
		url: () => "http://b.test/final",
		setRequestInterception(enabled: boolean) {
			calls.push(`setRequestInterception ${enabled}`);
			return Promise.resolve();
		},
		setUserAgent: (ua: string) => record(`setUserAgent ${ua}`),
		setViewport: (v: { width: number; height: number }) =>
			record(`setViewport ${v.width}x${v.height}`),
		setJavaScriptEnabled: (on: boolean) => record(`setJavaScriptEnabled ${on}`),
		setExtraHTTPHeaders: (h: Record<string, string>) =>
			record(`setExtraHTTPHeaders ${JSON.stringify(h)}`),
		emulateTimezone: (tz: string) => record(`emulateTimezone ${tz}`),
		on(event: string, cb: (arg: never) => void) {
			if (event === "request") requestHandler = cb as (req: unknown) => void;
			return pageEvents.on(event, cb);
		},
		close: () => record("close page"),
	};

	const context = {
		newPage: () => {
			calls.push("newPage");
			return Promise.resolve(page);
		},
		close: () => record("close context"),
	};

	const contextApi = config.noContextApi ? {} : config.legacyContext
		? {
			createIncognitoBrowserContext: () => {
				calls.push("createIncognitoBrowserContext");
				return Promise.resolve(context);
			},
		}
		: {
			createBrowserContext: () => {
				calls.push("createBrowserContext");
				return Promise.resolve(context);
			},
		};

	const browser = {
		...contextApi,
		process: () => ({ pid: 4242 }),
		on: browserEvents.on,
		close: () => record("close browser"),
	};

	return {
		module: {
			launch(options?: unknown) {
				calls.push(`launch ${JSON.stringify(options)}`);
				return Promise.resolve(browser);
			},
		},
		calls,
		pageEvents,
		browserEvents,
		fireRequest: (url: string, resourceType: string, sink: string[]) => {
			requestHandler?.({
				url: () => url,
				resourceType: () => resourceType,
				abort: () => {
					sink.push(`abort ${url}`);
					return Promise.resolve();
				},
				continue: () => {
					sink.push(`continue ${url}`);
					return Promise.resolve();
				},
			});
		},
	};
}

Deno.test("puppeteerDriver: accepts the module or a namespace, rejects anything else", () => {
	const ppt = pptMock();
	assertEquals(puppeteerDriver(ppt.module).name, "puppeteer");
	assertEquals(puppeteerDriver({ default: ppt.module }).name, "puppeteer");
	assertEquals(puppeteerDriver(ppt.module, { name: "ppt" }).name, "ppt");
	// no locale emulation exists in Puppeteer — say so instead of pretending
	assertEquals(puppeteerDriver(ppt.module).capabilities, {
		locale: false,
		timezone: true,
		contextOptions: false,
	});
	const e = assertThrows(() => puppeteerDriver({ nope: 1 } as never), TypeError);
	assert(e.message.includes('"launch"'), e.message);
});

Deno.test("puppeteerDriver: contexts, pid and both context-API spellings", async () => {
	const modern = pptMock();
	const browser = await puppeteerDriver(modern.module).launch();
	assertEquals(browser.pid, 4242);
	await browser.newContext({});
	assert(modern.calls.includes("createBrowserContext"));

	// Puppeteer < 22 spelled it differently, and plenty of installs still do
	const legacy = pptMock({ legacyContext: true });
	await (await puppeteerDriver(legacy.module).launch()).newContext({});
	assert(legacy.calls.includes("createIncognitoBrowserContext"));

	const broken = pptMock({ noContextApi: true });
	await assertRejects(
		async () => await (await puppeteerDriver(broken.module).launch()).newContext({}),
		TypeError,
		"createBrowserContext",
	);
});

Deno.test("puppeteerDriver: context options are applied per page", async () => {
	const ppt = pptMock();
	const page = await (await (await puppeteerDriver(ppt.module).launch())
		.newContext({ userAgent: "ignored-here" })).newPage();
	// the context took nothing — that call carries no options at all
	assert(!ppt.calls.some((c) => c.includes("ignored-here")));

	await page.applyPageOptions({
		userAgent: "bot/2",
		viewport: { width: 1024, height: 768 },
		javaScriptEnabled: false,
		timezoneId: "Europe/Bratislava",
		locale: "sk-SK",
		extraHTTPHeaders: { "X-Trace": "abc" },
	});
	assert(ppt.calls.includes("setUserAgent bot/2"));
	assert(ppt.calls.includes("setViewport 1024x768"));
	assert(ppt.calls.includes("setJavaScriptEnabled false"));
	assert(ppt.calls.includes("emulateTimezone Europe/Bratislava"));
	// locale is approximated by a header, and the keys are normalized
	assert(
		ppt.calls.includes(
			'setExtraHTTPHeaders {"x-trace":"abc","accept-language":"sk-SK"}',
		),
		ppt.calls.join("\n"),
	);
});

Deno.test("puppeteerDriver: navigation mapping and wait calls", async () => {
	const ppt = pptMock();
	const page = await (await (await puppeteerDriver(ppt.module).launch())
		.newContext({})).newPage();

	const nav = await page.goto("http://b.test/1", {
		waitUntil: "domcontentloaded",
		timeout: 9_000,
	});
	assertEquals(
		ppt.calls.at(-1),
		'goto http://b.test/1 {"waitUntil":"domcontentloaded","timeout":9000}',
	);
	assertEquals(nav.status, 404);
	// an empty statusText is reported as absent, not as ""
	assertEquals(nav.statusText, undefined);
	assertEquals(nav.headers, { "x-trace": "1" });
	// redirectChain() is already chronological
	assertEquals(nav.redirects, ["http://b.test/1", "http://b.test/2"]);
	assertEquals(nav.finalUrl, "http://b.test/final");

	// Puppeteer's idle window IS configurable, so idleMs is honored here
	await page.waitForNetworkIdle({ idleMs: 250, timeout: 5_000 });
	assertEquals(
		ppt.calls.at(-1),
		'waitForNetworkIdle {"idleTime":250,"timeout":5000}',
	);
	// (fn, options) — no argument slot, unlike Playwright
	await page.waitForFunction("() => window.ready", { timeout: 2_000 });
	assertEquals(
		ppt.calls.at(-1),
		'waitForFunction () => window.ready {"timeout":2000}',
	);
});

Deno.test("puppeteerDriver: interception, capture hooks and the crash event", async () => {
	const ppt = pptMock();
	const page = await (await (await puppeteerDriver(ppt.module).launch())
		.newContext({})).newPage();

	const routed: string[] = [];
	await page.setRequestFilter((req) =>
		req.resourceType === "font" ? "abort" : "continue"
	);
	assert(ppt.calls.includes("setRequestInterception true"));
	ppt.fireRequest("http://b.test/f.woff2", "font", routed);
	ppt.fireRequest("http://b.test/app.js", "script", routed);
	assertEquals(routed, [
		"abort http://b.test/f.woff2",
		"continue http://b.test/app.js",
	]);

	const consoleErrors: string[] = [];
	page.onConsoleError((text) => consoleErrors.push(text));
	ppt.pageEvents.emit("console", { type: () => "log", text: () => "hello" });
	ppt.pageEvents.emit("console", { type: () => "error", text: () => "bad" });
	assertEquals(consoleErrors, ["bad"]);

	// Puppeteer reports a page crash as "error", not "crash"
	const crashes: Error[] = [];
	page.onCrash((err) => crashes.push(err));
	ppt.pageEvents.emit("error", new Error("Page crashed!"));
	assertEquals(crashes.map((c) => c.message), ["Page crashed!"]);
});

Deno.test("normalizeHeaders lowercases keys and tolerates nothing at all", () => {
	assertEquals(normalizeHeaders({ "Content-Type": "text/html" }), {
		"content-type": "text/html",
	});
	assertEquals(normalizeHeaders(undefined), {});
	assertEquals(normalizeHeaders(null), {});
});

// ---------------------------------------------------------------------------
// the fake driver
// ---------------------------------------------------------------------------

const PAGE_URL = "http://fake.test/";

Deno.test("fakeDriver: a full round trip, logged and counted", async () => {
	const driver = fakeDriver({
		routes: {
			[PAGE_URL]: {
				html: "<html><body>hi</body></html>",
				title: "hi",
				status: 201,
				redirects: ["http://fake.test/old"],
				finalUrl: PAGE_URL,
				pageUrl: `${PAGE_URL}#spa`,
			},
		},
	});
	const browser = await driver.launch();
	const context = await browser.newContext({ userAgent: "fake/1" });
	const page = await context.newPage();
	await page.applyPageOptions({ locale: "sk-SK" });

	const nav = await page.goto(PAGE_URL, { waitUntil: "load", timeout: 1_000 });
	assertEquals(nav.status, 201);
	assertEquals(nav.redirects, ["http://fake.test/old"]);
	assertEquals(await page.content(), "<html><body>hi</body></html>");
	assertEquals(await page.title(), "hi");
	// client-side routing moved the page past the HTTP final URL
	assertEquals(page.url(), `${PAGE_URL}#spa`);

	await page.close();
	await context.close();
	await browser.close();
	assertEquals(driver.log, [
		"launch",
		"newContext",
		"newPage",
		`goto ${PAGE_URL}`,
		"close page",
		"close context",
		"close browser",
	]);
	assertEquals(driver.contextOptions, [{ userAgent: "fake/1" }]);
	assertEquals(driver.pageOptions, [{ locale: "sk-SK" }]);
	assertEquals(driver.stats.launches, 1);
	assertEquals(driver.stats.closedPages, 1);
	assertEquals(driver.browsers[0].alive, false);
});

Deno.test("fakeDriver: delays are fake-timer friendly and honor the timeout", async () => {
	using time = new FakeTime();
	const driver = fakeDriver({ fallback: { delay: 30_000 } });
	const page = await (await (await driver.launch()).newContext({})).newPage();

	const slow = page.goto(PAGE_URL, { waitUntil: "load", timeout: 60_000 });
	await time.tickAsync(29_999);
	await time.tickAsync(1);
	assertEquals((await slow).status, 200);

	const doomed = page.goto(PAGE_URL, { waitUntil: "load", timeout: 5_000 });
	const e = await assertRejects(() => settle(time, doomed), Error);
	assert(e.message.includes("Timeout 5000ms exceeded"), e.message);
});

Deno.test("fakeDriver: closing a page cancels the navigation in flight", async () => {
	using time = new FakeTime();
	const driver = fakeDriver({ fallback: { delay: 30_000 } });
	const page = await (await (await driver.launch()).newContext({})).newPage();

	const nav = page.goto(PAGE_URL, { waitUntil: "load", timeout: 60_000 });
	await time.tickAsync(10);
	await page.close();
	// this is exactly how the adapter will implement cancellation
	await assertRejects(() => settle(time, nav), Error, "closed");
});

Deno.test("fakeDriver: crashes — page, browser, and the whole fleet", async () => {
	const driver = fakeDriver({
		routes: {
			[PAGE_URL]: { crash: true },
			[`${PAGE_URL}kill`]: { killBrowser: true },
		},
	});
	const browser = await driver.launch();
	const context = await browser.newContext({});

	const page = await context.newPage();
	const crashes: Error[] = [];
	page.onCrash((e) => crashes.push(e));
	await assertRejects(
		() => page.goto(PAGE_URL, { waitUntil: "load", timeout: 100 }),
		Error,
		"crashed",
	);
	assertEquals(crashes.length, 1);

	let disconnected = 0;
	browser.onDisconnected(() => disconnected++);
	const second = await context.newPage();
	await assertRejects(
		() => second.goto(`${PAGE_URL}kill`, { waitUntil: "load", timeout: 100 }),
		Error,
		"not running",
	);
	assertEquals(disconnected, 1);
	// a dead browser refuses new work rather than hanging
	await assertRejects(() => context.newPage(), Error, "not running");

	const fleet = fakeDriver();
	await fleet.launch();
	await fleet.launch();
	fleet.crashAll();
	assertEquals(fleet.browsers.filter((b) => b.alive).length, 0);
});

Deno.test("fakeDriver: request filtering, capture and scripted launch failures", async () => {
	const driver = fakeDriver({
		fallback: {
			resources: [
				{ url: "http://fake.test/a.png", resourceType: "image" },
				{ url: "http://fake.test/a.js", resourceType: "script" },
			],
			consoleErrors: ["ReferenceError: x is not defined"],
			requestFailures: [{ url: "http://fake.test/gone", failure: "net::ERR" }],
		},
		failLaunches: 1,
	});

	await assertRejects(() => driver.launch(), Error, "Fake launch #1 failed");
	const page = await (await (await driver.launch()).newContext({})).newPage();

	const errors: string[] = [];
	const failures: { url: string }[] = [];
	page.onConsoleError((t) => errors.push(t));
	page.onRequestFailed((f) => failures.push(f));
	await page.setRequestFilter((r) => r.resourceType === "image" ? "abort" : "continue");
	await page.goto(PAGE_URL, { waitUntil: "load", timeout: 100 });

	assertEquals(driver.blocked, ["http://fake.test/a.png"]);
	assertEquals(driver.loaded, ["http://fake.test/a.js"]);
	assertEquals(errors, ["ReferenceError: x is not defined"]);
	assertEquals(failures.map((f) => f.url), ["http://fake.test/gone"]);
	assertEquals(driver.stats.launches, 2);
});

Deno.test("fakeDriver: crashAfterPages models a browser dying under load", async () => {
	const driver = fakeDriver({ crashAfterPages: 2 });
	const browser = await driver.launch();
	const context = await browser.newContext({});
	await context.newPage();
	await context.newPage();
	assertEquals(browser.alive, true);
	await context.newPage();
	assertEquals(browser.alive, false);
});

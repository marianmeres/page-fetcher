/**
 * Browser adapter unit tests — the whole orchestration against the in-memory fake
 * driver. No browser, no sockets, no real time except a couple of 5 ms nudges.
 *
 * This file is the reason the driver interface exists: wait strategies, resource
 * blocking, capture, cancellation, crash handling and result mapping are all covered in
 * the default (browserless) test run, leaving the flagged real-browser suite to prove
 * only the thin driver bindings.
 */
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import {
	compileRequestFilter,
	DEFAULT_BLOCKED_RESOURCES,
} from "../src/adapters/browser/blocking.ts";
import {
	createBrowserAdapter,
	DEFAULT_CAPTURE_LIMIT,
} from "../src/adapters/browser/browser-adapter.ts";
import { normalizeWait } from "../src/adapters/browser/wait.ts";
import { PageFetchError } from "../src/errors.ts";
import { timeoutGuard } from "../src/guards.ts";
import type { Adapter, FetchResult } from "../src/types.ts";
import { type FakeDriver, fakeDriver } from "./fixtures/fake-driver.ts";
import { recordingLogger, settleWithFakeTime } from "./helpers.ts";

const URL_A = "http://a.test/page";

/** Adapter + driver pair, built from a fake-driver options bag. */
function adapterOver(
	driverOptions: Parameters<typeof fakeDriver>[0] = {},
	adapterOptions: Partial<Parameters<typeof createBrowserAdapter>[0]> = {},
): { adapter: Adapter; driver: FakeDriver } {
	const driver = fakeDriver(driverOptions);
	const adapter = createBrowserAdapter({ ...adapterOptions, driver });
	return { adapter, driver };
}

/** The `kind` of the {@linkcode PageFetchError} `fn` rejects with. */
async function kindOf(fn: () => Promise<unknown>): Promise<string> {
	return (await assertRejects(fn, PageFetchError)).kind;
}

/** Let the runtime flush the cleanup a cancelled fetch schedules. */
const settle = () => new Promise<void>((r) => setTimeout(r, 5));

// ---------------------------------------------------------------------------
// blocking
// ---------------------------------------------------------------------------

Deno.test("blocking: the defaults drop the pixels and keep the DOM", () => {
	const filter = compileRequestFilter({});
	for (const resourceType of DEFAULT_BLOCKED_RESOURCES) {
		assertEquals(filter({ url: "http://x/a", resourceType }), "abort", resourceType);
	}
	for (const resourceType of ["script", "xhr", "fetch", "other"]) {
		assertEquals(
			filter({ url: "http://x/a", resourceType }),
			"continue",
			resourceType,
		);
	}
});

Deno.test("blocking: the navigation itself is never blocked", () => {
	const filter = compileRequestFilter({
		blockResources: ["document", "image"],
		allowUrls: [/never-matches/],
		blockUrls: [() => true],
	});
	assertEquals(filter({ url: URL_A, resourceType: "document" }), "continue");
	assertEquals(filter({ url: URL_A, resourceType: "script" }), "abort");
});

Deno.test("blocking: blockResources false lets everything through", () => {
	const filter = compileRequestFilter({ blockResources: false });
	assertEquals(filter({ url: "http://x/a.png", resourceType: "image" }), "continue");
});

Deno.test("blocking: blockUrls takes regexps and predicates", () => {
	const filter = compileRequestFilter({
		blockResources: false,
		blockUrls: [/doubleclick/, (u: string) => u.endsWith(".pdf")],
	});
	assertEquals(
		filter({ url: "http://doubleclick.net/x", resourceType: "script" }),
		"abort",
	);
	assertEquals(filter({ url: "http://x/a.pdf", resourceType: "other" }), "abort");
	assertEquals(filter({ url: "http://x/a.js", resourceType: "script" }), "continue");
});

Deno.test("blocking: allowUrls is an allow-list", () => {
	const filter = compileRequestFilter({
		blockResources: false,
		allowUrls: [/^http:\/\/a\.test\//],
	});
	assertEquals(
		filter({ url: "http://a.test/x.js", resourceType: "script" }),
		"continue",
	);
	assertEquals(filter({ url: "http://b.test/x.js", resourceType: "script" }), "abort");
});

Deno.test("blocking: a /g predicate answers the same twice (lastIndex is reset)", () => {
	const filter = compileRequestFilter({
		blockResources: false,
		blockUrls: [/track/g],
	});
	const req = { url: "http://x/track.js", resourceType: "script" };
	assertEquals(filter(req), "abort");
	assertEquals(filter(req), "abort");
});

// ---------------------------------------------------------------------------
// wait strategy validation
// ---------------------------------------------------------------------------

Deno.test("normalizeWait accepts the four shapes and rejects the rest", () => {
	assertEquals(normalizeWait("load"), "load");
	assertEquals(normalizeWait("domcontentloaded"), "domcontentloaded");
	assertEquals(normalizeWait("networkidle"), "networkidle");
	assertEquals(normalizeWait({ selector: "#app" }), { selector: "#app" });
	assertEquals(normalizeWait({ fn: "() => true" }), { fn: "() => true" });

	for (const bad of ["networkidle0", "", {}, { selector: "" }, { fn: 1 }, null, 42]) {
		assertThrows(() => normalizeWait(bad), TypeError, "Invalid wait strategy");
	}
});

// ---------------------------------------------------------------------------
// the happy path and result mapping
// ---------------------------------------------------------------------------

Deno.test("browser adapter: maps a navigation onto a FetchResult", async () => {
	const { adapter, driver } = adapterOver({
		routes: {
			[URL_A]: {
				html: "<html><head><title>Hi</title></head><body>ahoj</body></html>",
				title: "Hi",
				headers: { "Content-Type": "text/html; charset=windows-1250" },
				redirects: ["http://a.test/old"],
				finalUrl: URL_A,
			},
		},
	});

	const ok = await adapter.fetch({ url: URL_A });
	assertEquals(ok.ok, true);
	assertEquals(ok.status, 200);
	assertEquals(ok.statusText, "OK");
	assertEquals(ok.url, URL_A);
	assertEquals(ok.finalUrl, URL_A);
	assertEquals(ok.redirects, ["http://a.test/old"]);
	assertEquals(ok.adapter, "browser");
	assertEquals(ok.attempts, 1);
	assertEquals(ok.fromCache, false);
	assertEquals(ok.notModified, false);
	assert(ok.requestId);
	assertEquals(ok.contentType, "text/html");
	// the DOM was re-serialized — the wire charset is gone, whatever the header says
	assertEquals(ok.charset, "utf-8");
	assertEquals(ok.hasBody, true);
	assertEquals(
		await ok.text(),
		"<html><head><title>Hi</title></head><body>ahoj</body></html>",
	);
	assertEquals(ok.size, (await ok.bytes()).length);
	assertEquals(ok.extra?.title, "Hi");
	assertEquals(ok.headers.get("content-type"), "text/html; charset=windows-1250");
	assert(ok.timing.total >= 0);
	assertEquals(typeof ok.timing.render, "number");
	assert(driver.stats.launches === 1 && driver.stats.contexts === 1);
	await adapter.dispose?.();
});

Deno.test("browser adapter: client-side URL drift shows up as extra.pageUrl", async () => {
	const { adapter } = adapterOver({
		routes: {
			[URL_A]: { finalUrl: URL_A, pageUrl: "http://a.test/page#/spa/route" },
		},
	});
	const res = await adapter.fetch({ url: URL_A });
	assertEquals(res.finalUrl, URL_A);
	assertEquals(res.extra?.pageUrl, "http://a.test/page#/spa/route");
	await adapter.dispose?.();
});

Deno.test("browser adapter: a non-2xx is data, not an error", async () => {
	const { adapter } = adapterOver({
		routes: {
			[URL_A]: { status: 404, statusText: "Not Found", html: "<b>nope</b>" },
		},
	});
	const res = await adapter.fetch({ url: URL_A });
	assertEquals(res.ok, false);
	assertEquals(res.status, 404);
	assertEquals(await res.text(), "<b>nope</b>");
	await adapter.dispose?.();
});

Deno.test("browser adapter: default blocking is installed before the navigation", async () => {
	const { adapter, driver } = adapterOver({
		routes: {
			[URL_A]: {
				resources: [
					{ url: "http://a.test/hero.png", resourceType: "image" },
					{ url: "http://a.test/app.css", resourceType: "stylesheet" },
					{ url: "http://a.test/app.js", resourceType: "script" },
				],
			},
		},
	});
	await adapter.fetch({ url: URL_A });
	assertEquals(driver.blocked, ["http://a.test/hero.png", "http://a.test/app.css"]);
	assertEquals(driver.loaded, ["http://a.test/app.js"]);
	// installed before goto, not after
	const order = driver.log.filter((l) => l === "newPage" || l.startsWith("goto"));
	assertEquals(order, ["newPage", `goto ${URL_A}`]);
	await adapter.dispose?.();
});

Deno.test("browser adapter: per-request blocking replaces the adapter's", async () => {
	const { adapter, driver } = adapterOver({
		routes: {
			[URL_A]: {
				resources: [{ url: "http://a.test/hero.png", resourceType: "image" }],
			},
		},
	});
	await adapter.fetch({ url: URL_A, adapterOptions: { blockResources: false } });
	assertEquals(driver.blocked, []);
	assertEquals(driver.loaded, ["http://a.test/hero.png"]);
	await adapter.dispose?.();
});

Deno.test("browser adapter: maxRedirects is enforced after the fact", async () => {
	const { adapter } = adapterOver(
		{ routes: { [URL_A]: { redirects: ["a", "b", "c"] } } },
		{ maxRedirects: 2 },
	);
	const err = await assertRejects(() => adapter.fetch({ url: URL_A }), PageFetchError);
	assertEquals(err.kind, "too-many-redirects");
	assertEquals(err.retryable, false);
	assertEquals(err.attempts, 1);
	assertEquals(err.details?.maxRedirects, 2);
	await adapter.dispose?.();
});

Deno.test("browser adapter: retainBody false never serializes the DOM", async () => {
	const { adapter } = adapterOver({ routes: { [URL_A]: { title: "T" } } });
	const res = await adapter.fetch({ url: URL_A, retainBody: false });
	assertEquals(res.hasBody, false);
	assertEquals(res.size, undefined);
	assertEquals(res.charset, undefined);
	assertEquals(res.extra?.title, "T");
	const err = await assertRejects(() => res.text(), PageFetchError);
	assertEquals(err.kind, "no-body");
	assertEquals(err.details?.reason, "retain-body");
	await adapter.dispose?.();
});

Deno.test("browser adapter: the serialized DOM is bounded by maxBytes", async () => {
	const { adapter } = adapterOver(
		{ routes: { [URL_A]: { html: "x".repeat(64) } } },
		{ maxBytes: 16 },
	);
	const err = await assertRejects(() => adapter.fetch({ url: URL_A }), PageFetchError);
	assertEquals(err.kind, "too-large");
	assertEquals(err.retryable, false);
	assertEquals(err.details?.size, 64);
	await adapter.dispose?.();
});

Deno.test("browser adapter: only GET navigates; a bad URL never launches", async () => {
	const { adapter, driver } = adapterOver({});
	const post = await assertRejects(
		() => adapter.fetch({ url: URL_A, method: "POST" }),
		PageFetchError,
	);
	assertEquals(post.kind, "network");
	assertEquals(post.retryable, false);
	assert(post.message.includes("GET"));

	const bad = await assertRejects(
		() => adapter.fetch({ url: "not a url" }),
		PageFetchError,
	);
	assertEquals(bad.kind, "network");
	assertEquals(bad.retryable, false);
	assertEquals(driver.stats.launches, 0);
	await adapter.dispose?.();
});

// ---------------------------------------------------------------------------
// wait strategies
// ---------------------------------------------------------------------------

Deno.test("wait: networkidle proceeds when the page never goes quiet", async () => {
	using time = new FakeTime();
	const { adapter } = adapterOver(
		{ routes: { [URL_A]: { networkIdleAfter: 60_000, html: "<p>rendered</p>" } } },
		{ networkidle: { timeout: 1_000 } },
	);
	const res = await settleWithFakeTime(time, adapter.fetch({ url: URL_A }));
	assertEquals(res.status, 200);
	assertEquals(res.extra?.networkidleTimedOut, true);
	assertEquals(await res.text(), "<p>rendered</p>");
	await adapter.dispose?.();
});

Deno.test("wait: strict networkidle fails instead", async () => {
	using time = new FakeTime();
	const { adapter } = adapterOver(
		{ routes: { [URL_A]: { networkIdleAfter: 60_000 } } },
		{ networkidle: { timeout: 1_000, strict: true } },
	);
	const err = await assertRejects(
		() => settleWithFakeTime(time, adapter.fetch({ url: URL_A })),
		PageFetchError,
	);
	assertEquals(err.kind, "timeout");
	assertEquals(err.retryable, true);
	await adapter.dispose?.();
});

Deno.test("wait: a quiet page reports no networkidle timeout", async () => {
	const { adapter } = adapterOver({ routes: { [URL_A]: { networkIdleAfter: 0 } } });
	const res = await adapter.fetch({ url: URL_A });
	assertEquals(res.extra?.networkidleTimedOut, undefined);
	await adapter.dispose?.();
});

Deno.test("wait: a missing selector is a hard failure", async () => {
	using time = new FakeTime();
	const { adapter } = adapterOver({
		routes: { [URL_A]: { missingSelectors: ["#app"] } },
	});
	const err = await assertRejects(
		() =>
			settleWithFakeTime(
				time,
				adapter.fetch({
					url: URL_A,
					adapterOptions: { wait: { selector: "#app", timeout: 500 } },
				}),
			),
		PageFetchError,
	);
	assertEquals(err.kind, "timeout");
	assert(err.message.includes("#app"));
	await adapter.dispose?.();
});

Deno.test("wait: a present selector resolves, and { fn } is supported too", async () => {
	const { adapter } = adapterOver({ routes: { [URL_A]: { html: "<div id=app/>" } } });
	const bySelector = await adapter.fetch({
		url: URL_A,
		adapterOptions: { wait: { selector: "#app" } },
	});
	assertEquals(bySelector.ok, true);
	const byFn = await adapter.fetch({
		url: URL_A,
		adapterOptions: { wait: { fn: "() => !!document.querySelector('#app')" } },
	});
	assertEquals(byFn.ok, true);
	await adapter.dispose?.();
});

Deno.test("wait: the navigation budget is the request's timeout when it has one", async () => {
	using time = new FakeTime();
	const { adapter } = adapterOver({ routes: { [URL_A]: { delay: 60_000 } } });
	const err = await assertRejects(
		() => settleWithFakeTime(time, adapter.fetch({ url: URL_A, timeout: 1_000 })),
		PageFetchError,
	);
	assertEquals(err.kind, "timeout");
	await adapter.dispose?.();
});

// ---------------------------------------------------------------------------
// onPage + capture
// ---------------------------------------------------------------------------

Deno.test("onPage: sees the raw page, and its result wins in extra", async () => {
	const seen: unknown[] = [];
	const { adapter } = adapterOver({ routes: { [URL_A]: { title: "original" } } }, {
		onPage: (page, req) => {
			seen.push([page, req.url]);
			return { title: "overridden", custom: 42 };
		},
	});
	const res = await adapter.fetch({ url: URL_A });
	assertEquals(res.extra?.title, "overridden");
	assertEquals(res.extra?.custom, 42);
	assertEquals((seen[0] as [{ fake: string }, string])[0].fake, "page");
	assertEquals((seen[0] as [unknown, string])[1], URL_A);
	await adapter.dispose?.();
});

Deno.test("onPage: a throwing hook is reported, not fatal", async () => {
	const logger = recordingLogger();
	const { adapter } = adapterOver({ routes: { [URL_A]: {} } }, {
		logger,
		onPage: () => {
			throw new Error("banner click failed");
		},
	});
	const res = await adapter.fetch({ url: URL_A });
	assertEquals(res.ok, true);
	assertEquals(res.extra?.onPageError, "banner click failed");
	assert(logger.messages("warn").some((m) => m.includes("onPage hook threw")));
	await adapter.dispose?.();
});

Deno.test("capture: console errors and failed requests land in extra", async () => {
	const { adapter } = adapterOver({
		routes: {
			[URL_A]: {
				consoleErrors: ["boom", "bang"],
				requestFailures: [{
					url: "http://a.test/x.js",
					failure: "net::ERR_FAILED",
				}],
			},
		},
	});
	const res = await adapter.fetch({ url: URL_A });
	assertEquals(res.extra?.consoleErrors, ["boom", "bang"]);
	assertEquals(res.extra?.failedRequests, [
		{ url: "http://a.test/x.js", failure: "net::ERR_FAILED" },
	]);
	await adapter.dispose?.();
});

Deno.test("capture: lists are capped and say so", async () => {
	const { adapter } = adapterOver(
		{
			routes: {
				[URL_A]: {
					consoleErrors: Array.from({ length: 10 }, (_, i) => `e${i}`),
				},
			},
		},
		{ captureLimit: 3 },
	);
	const res = await adapter.fetch({ url: URL_A });
	assertEquals(res.extra?.consoleErrors, ["e0", "e1", "e2", "… truncated"]);
	await adapter.dispose?.();
});

Deno.test("capture: can be switched off", async () => {
	const { adapter } = adapterOver(
		{ routes: { [URL_A]: { consoleErrors: ["boom"] } } },
		{ captureConsoleErrors: false, captureFailedRequests: false },
	);
	const res = await adapter.fetch({ url: URL_A });
	assertEquals(res.extra?.consoleErrors, undefined);
	assertEquals(DEFAULT_CAPTURE_LIMIT, 50);
	await adapter.dispose?.();
});

// ---------------------------------------------------------------------------
// failure classification, cancellation, lifecycle
// ---------------------------------------------------------------------------

Deno.test("errors: driver messages are classified into kinds", async () => {
	const routes = {
		"http://x.test/dns": { error: "net::ERR_NAME_NOT_RESOLVED at http://x.test/dns" },
		"http://x.test/weird": {
			error: "Target page, context or browser has been closed",
		},
		"http://x.test/crash": { crash: true },
	};
	const { adapter } = adapterOver({ routes });
	assertEquals(
		await kindOf(() => adapter.fetch({ url: "http://x.test/dns" })),
		"network",
	);
	assertEquals(
		await kindOf(() => adapter.fetch({ url: "http://x.test/weird" })),
		"browser",
	);
	assertEquals(
		await kindOf(() => adapter.fetch({ url: "http://x.test/crash" })),
		"browser",
	);

	// all three say "try again" — none of them means the page is unfetchable
	const err = await assertRejects(
		() => adapter.fetch({ url: "http://x.test/crash" }),
		PageFetchError,
	);
	assertEquals(err.retryable, true);
	await adapter.dispose?.();
});

Deno.test("cancellation: an abort closes the page and reports kind aborted", async () => {
	const { adapter, driver } = adapterOver({ routes: { [URL_A]: { delay: 60_000 } } });
	const controller = new AbortController();
	const promise = adapter.fetch({ url: URL_A, signal: controller.signal });
	await settle();
	controller.abort();

	const err = await assertRejects(() => promise, PageFetchError);
	assertEquals(err.kind, "aborted");
	assertEquals(err.retryable, false);
	await settle();
	assertEquals(driver.stats.closedPages, 1);
	await adapter.dispose?.();
});

Deno.test("cancellation: a guard's abort keeps its own kind", async () => {
	const { adapter } = adapterOver({ routes: { [URL_A]: { delay: 60_000 } } });
	const guarded = timeoutGuard({ defaultTimeout: 20 })(adapter.fetch);
	const err = await assertRejects(() => guarded({ url: URL_A }), PageFetchError);
	assertEquals(err.kind, "timeout");
	await settle();
	await adapter.dispose?.();
});

Deno.test("lifecycle: a dead browser is relaunched on the next fetch", async () => {
	const { adapter, driver } = adapterOver({
		routes: {
			"http://x.test/kill": { killBrowser: true },
			[URL_A]: { html: "<p>back</p>" },
		},
	});
	assertEquals(
		await kindOf(() => adapter.fetch({ url: "http://x.test/kill" })),
		"browser",
	);
	assertEquals(driver.stats.launches, 1);

	const res = await adapter.fetch({ url: URL_A });
	assertEquals(await res.text(), "<p>back</p>");
	assertEquals(driver.stats.launches, 2);
	assertEquals(driver.stats.contexts, 2);
	await adapter.dispose?.();
});

Deno.test("lifecycle: the browser launches lazily, once, for concurrent requests", async () => {
	const { adapter, driver } = adapterOver({ routes: { [URL_A]: {} } });
	assertEquals(driver.stats.launches, 0);
	await Promise.all([
		adapter.fetch({ url: URL_A }),
		adapter.fetch({ url: URL_A }),
		adapter.fetch({ url: URL_A }),
	]);
	assertEquals(driver.stats.launches, 1);
	assertEquals(driver.stats.contexts, 1);
	assertEquals(driver.stats.pages, 3);
	assertEquals(driver.stats.closedPages, 3);
	await adapter.dispose?.();
});

Deno.test("lifecycle: dispose closes everything and is idempotent", async () => {
	const { adapter, driver } = adapterOver({ routes: { [URL_A]: {} } });
	await adapter.fetch({ url: URL_A });
	assertEquals(await adapter.health?.(), true);

	await adapter.dispose?.();
	await adapter.dispose?.();
	assertEquals(driver.stats.closedContexts, 1);
	assertEquals(driver.stats.closedBrowsers, 1);
	assertEquals(await adapter.health?.(), false);
});

Deno.test("context options: per-request headers get a dedicated context", async () => {
	const { adapter, driver } = adapterOver({ routes: { [URL_A]: {} } }, {
		headers: { "Accept-Language": "sk" },
	});
	await adapter.fetch({ url: URL_A });
	assertEquals(driver.contextOptions[0].extraHTTPHeaders, { "accept-language": "sk" });

	await adapter.fetch({
		url: URL_A,
		headers: { "X-Trace": "1", "User-Agent": "custom-ua" },
	});
	assertEquals(driver.stats.contexts, 2);
	assertEquals(driver.contextOptions[1], {
		userAgent: "custom-ua",
		extraHTTPHeaders: { "accept-language": "sk", "x-trace": "1" },
	});
	// a one-off context is closed with its request, never pooled
	assertEquals(driver.stats.closedContexts, 1);
	// and every driver gets the options per page too, for the ones that need it there
	assertEquals(driver.pageOptions.length, 2);
	await adapter.dispose?.();
});

Deno.test("context options: an unhonorable option is called out at wiring time", () => {
	const logger = recordingLogger();
	createBrowserAdapter({
		driver: fakeDriver({ capabilities: { locale: false, timezone: false } }),
		contextOptions: { locale: "sk-SK", timezoneId: "Europe/Bratislava" },
		logger,
	});
	const warnings = logger.messages("warn");
	assert(warnings.some((m) => m.includes("locale")));
	assert(warnings.some((m) => m.includes("timezone")));
});

Deno.test("createBrowserAdapter refuses to be built without a driver", () => {
	assertThrows(
		// deno-lint-ignore no-explicit-any
		() => createBrowserAdapter({} as any),
		TypeError,
		"`driver` is required",
	);
});

Deno.test("a browser result satisfies the FetchResult contract", async () => {
	const { adapter } = adapterOver({ routes: { [URL_A]: {} } });
	const res: FetchResult = await adapter.fetch({ url: URL_A, meta: { depth: 2 } });
	assertEquals(res.meta, { depth: 2 });
	assertEquals(res.requestId.length > 0, true);
	await adapter.dispose?.();
});

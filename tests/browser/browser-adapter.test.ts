/**
 * Real-browser smoke test — the only thing the flagged suite is for.
 *
 * Everything about the pool, the wait strategies, blocking, capture and crash recovery
 * is already covered against the fake driver in the default browserless run
 * (`tests/browser-adapter.test.ts`, `tests/browser-pool.test.ts`). What *cannot* be
 * proven there is the thin binding between our structural driver interface and the real
 * Playwright/Puppeteer APIs — method names, argument order, event names, the shape of a
 * navigation response. That is what this file checks, and deliberately nothing more.
 *
 * Gated twice over: see `harness.ts`. Run with `deno task test:browser`.
 */
import { assert, assertEquals } from "@std/assert";
import { createBrowserAdapter } from "../../src/adapters/browser/browser-adapter.ts";
import { PageFetchError } from "../../src/errors.ts";
import { startFixtureServer } from "../fixtures/server.ts";
import { gated, loadDriver } from "./harness.ts";

/** A token unique to one case, so its subresource hits are its own. */
const token = (name: string) => `browser-${name}-${Math.random().toString(36).slice(2)}`;

Deno.test({
	...gated,
	name: "real browser: renders a page that only JS completes",
	fn: async () => {
		const server = await startFixtureServer();
		const adapter = createBrowserAdapter({ driver: await loadDriver() });
		const tk = token("spa");
		try {
			const res = await adapter.fetch({ url: server.url(`/spa?token=${tk}`) });

			assertEquals(res.ok, true);
			assertEquals(res.status, 200);
			assertEquals(res.adapter, "browser");
			assertEquals(res.attempts, 1);
			assertEquals(res.charset, "utf-8");
			assertEquals(res.contentType, "text/html");

			const html = await res.text();
			// the point of the whole subsystem: the DOM we get back is post-script.
			// Asserted on the element, not on a bare substring — "hydrated" also
			// appears in the inline script source, which is serialized too
			assert(html.includes('id="app">hydrated'), html.slice(0, 300));
			assert(!html.includes('id="app">pre-hydration'), "pre-hydration DOM");
			assertEquals(res.extra?.title, "hydrated");
			assertEquals(res.size, (await res.bytes()).length);

			// blocking is on by default — the image and the stylesheet never load
			assertEquals(server.hits(tk, "/spa.png"), 0);
			assertEquals(server.hits(tk, "/spa.css"), 0);
		} finally {
			await adapter.dispose?.();
			await server.shutdown();
		}
	},
});

Deno.test({
	...gated,
	name: "real browser: blockResources false lets the subresources through",
	fn: async () => {
		const server = await startFixtureServer();
		const adapter = createBrowserAdapter({
			driver: await loadDriver(),
			blockResources: false,
		});
		const tk = token("assets");
		try {
			await adapter.fetch({ url: server.url(`/spa?token=${tk}`) });
			assertEquals(server.hits(tk, "/spa.png"), 1);
			assertEquals(server.hits(tk, "/spa.css"), 1);
		} finally {
			await adapter.dispose?.();
			await server.shutdown();
		}
	},
});

Deno.test({
	...gated,
	name: "real browser: reports the redirect chain and the final URL",
	fn: async () => {
		const server = await startFixtureServer();
		const adapter = createBrowserAdapter({ driver: await loadDriver() });
		try {
			const res = await adapter.fetch({ url: server.url("/redirect/2") });
			assertEquals(res.status, 200);
			assertEquals(res.finalUrl, server.url("/ok"));
			assertEquals(res.redirects.length, 2);
			assertEquals(res.redirects[0], server.url("/redirect/2"));
			assert((await res.text()).includes("ok"));
		} finally {
			await adapter.dispose?.();
			await server.shutdown();
		}
	},
});

Deno.test({
	...gated,
	name: "real browser: a non-2xx resolves with ok false, body intact",
	fn: async () => {
		const server = await startFixtureServer();
		const adapter = createBrowserAdapter({ driver: await loadDriver() });
		try {
			const res = await adapter.fetch({ url: server.url("/status/404") });
			assertEquals(res.ok, false);
			assertEquals(res.status, 404);
			assert((await res.text()).includes("status 404"));
		} finally {
			await adapter.dispose?.();
			await server.shutdown();
		}
	},
});

Deno.test({
	...gated,
	name: "real browser: the explicit selector and function waits run on the live page",
	fn: async () => {
		const server = await startFixtureServer();
		const adapter = createBrowserAdapter({ driver: await loadDriver() });
		try {
			// #app is in the served HTML, so this returns before hydration — which is
			// exactly the contract: you waited for what you asked for, nothing more
			const bySelector = await adapter.fetch({
				url: server.url("/spa?ms=5000"),
				adapterOptions: { wait: { selector: "#app", timeout: 10_000 } },
			});
			assert(
				(await bySelector.text()).includes('id="app">pre-hydration'),
				"the selector wait should not have waited for hydration",
			);

			// a function source, which both drivers would otherwise evaluate to a
			// truthy function object and resolve instantly
			const byFn = await adapter.fetch({
				url: server.url("/spa?ms=300"),
				adapterOptions: {
					wait: { fn: "() => document.title === 'hydrated'", timeout: 10_000 },
				},
			});
			assert((await byFn.text()).includes('id="app">hydrated'), "not hydrated");
			assert(byFn.timing.total >= 300, `total ${byFn.timing.total}`);
		} finally {
			await adapter.dispose?.();
			await server.shutdown();
		}
	},
});

Deno.test({
	...gated,
	name: "real browser: onPage sees the driver's own page object",
	fn: async () => {
		const server = await startFixtureServer();
		const adapter = createBrowserAdapter({
			driver: await loadDriver(),
			onPage: async (page) => {
				// the native Page of whichever driver is under test
				const title = await (page as { title(): Promise<string> }).title();
				return { seenTitle: title };
			},
		});
		try {
			const res = await adapter.fetch({ url: server.url("/spa") });
			assertEquals(res.extra?.seenTitle, "hydrated");
		} finally {
			await adapter.dispose?.();
			await server.shutdown();
		}
	},
});

Deno.test({
	...gated,
	name: "real browser: a navigation timeout is a retryable timeout",
	fn: async () => {
		const server = await startFixtureServer();
		const adapter = createBrowserAdapter({ driver: await loadDriver() });
		try {
			const error = await adapter
				.fetch({ url: server.url("/hang"), timeout: 1_000 })
				.then(() => null, (e: unknown) => e);
			assert(PageFetchError.is(error), `${error}`);
			assertEquals(error.kind, "timeout");
			assertEquals(error.retryable, true);
		} finally {
			await adapter.dispose?.();
			await server.shutdown();
		}
	},
});

Deno.test({
	...gated,
	name: "real browser: an unreachable host is a network error",
	fn: async () => {
		const adapter = createBrowserAdapter({ driver: await loadDriver() });
		try {
			// reserved TEST-NET-1, guaranteed not to answer
			const error = await adapter
				.fetch({ url: "http://192.0.2.1:9/", timeout: 5_000 })
				.then(() => null, (e: unknown) => e);
			assert(PageFetchError.is(error), `${error}`);
			assert(
				error.kind === "network" || error.kind === "timeout",
				`unexpected kind ${error.kind}: ${error.message}`,
			);
			assertEquals(error.retryable, true);
		} finally {
			await adapter.dispose?.();
		}
	},
});

Deno.test({
	...gated,
	name: "real browser: the pool serves concurrent fetches from one browser",
	fn: async () => {
		const server = await startFixtureServer();
		const adapter = createBrowserAdapter({
			driver: await loadDriver(),
			poolSize: 2,
			wait: "domcontentloaded",
		});
		try {
			const results = await Promise.all(
				["/ok", "/spa", "/ok", "/spa", "/ok"].map((path) =>
					adapter.fetch({ url: server.url(path) })
				),
			);
			assertEquals(results.map((r) => r.status), [200, 200, 200, 200, 200]);
		} finally {
			await adapter.dispose?.();
			await server.shutdown();
		}
	},
});

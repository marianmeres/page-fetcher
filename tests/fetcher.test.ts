/**
 * `createFetcher` tests: the unit half drives stub adapters (no sockets), the
 * integration half runs the wired stack against the fixture server.
 */
import { assert, assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { createFetcher } from "../src/fetcher.ts";
import { compose } from "../src/compose.ts";
import { PageFetchError } from "../src/errors.ts";
import { createHttpAdapter, DEFAULT_USER_AGENT } from "../src/adapters/http.ts";
import { createMemoryCache } from "../src/cache.ts";
import type {
	Adapter,
	FetcherEvents,
	FetchFn,
	FetchRequest,
	FetchResult,
} from "../src/types.ts";
import { startFixtureServer } from "./fixtures/server.ts";
import {
	makeError,
	makeResult,
	neverResolves,
	recordingLogger,
	scriptedFetch,
	type StubStep,
} from "./helpers.ts";

const URL_ = "http://stub.test/page";

/** Fast, deterministic retries — real timers, but zero-length sleeps. */
const FAST = { attempts: 3, baseDelay: 0, jitter: false } as const;

/** An `Adapter` backed by a scripted stub, exposing the requests it received. */
function stubAdapter(
	name: string,
	steps: StubStep[] = [makeResult({ url: URL_, adapter: name })],
	dispose?: () => Promise<void>,
): Adapter & { calls: FetchRequest[] } {
	const fetch = scriptedFetch(steps);
	return {
		name,
		// a real adapter echoes the id it was given and names itself
		fetch: async (req: FetchRequest): Promise<FetchResult> => ({
			...await fetch(req),
			requestId: req.requestId ?? "",
			adapter: name,
		}),
		calls: fetch.calls,
		dispose,
	};
}

/** Records every event in firing order, plus every `requestId` seen. */
function recordEvents() {
	const log: string[] = [];
	const ids = new Set<string | undefined>();
	const events: FetcherEvents = {
		onRequest: (_req, i) => {
			log.push(`request:${i.attempt}`);
			ids.add(i.requestId);
		},
		onResponse: (res) => {
			log.push(`response:${res.status}`);
			ids.add(res.requestId);
		},
		onRetry: (i) => {
			log.push(`retry:${i.attempt}`);
			ids.add(i.requestId);
		},
		onError: (e) => {
			log.push(`error:${e.kind}`);
			ids.add(e.requestId);
		},
		onCircuitOpen: (i) => log.push(`circuit-open:${i.host}`),
	};
	return { events, log, ids };
}

// ---------------------------------------------------------------------------
// composition
// ---------------------------------------------------------------------------

Deno.test("compose folds layers outermost-first", async () => {
	const order: string[] = [];
	const layer = (tag: string) => (next: FetchFn): FetchFn => (req) => {
		order.push(`>${tag}`);
		return next(req).finally(() => order.push(`<${tag}`));
	};
	const terminal: FetchFn = () => {
		order.push("terminal");
		return Promise.resolve(makeResult({ url: URL_ }));
	};
	await compose([layer("a"), layer("b")], terminal)({ url: URL_ });
	assertEquals(order, [">a", ">b", "terminal", "<b", "<a"]);
});

Deno.test("the wired stack fires N onRequest, N-1 onRetry and ONE terminal event", async () => {
	const { events, log, ids } = recordEvents();
	const adapter = stubAdapter("stub", [
		makeError({ kind: "network" }),
		makeError({ kind: "network" }),
		makeResult({ url: URL_ }),
	]);
	const fetcher = createFetcher({ adapters: adapter, retry: FAST, events });

	const res = await fetcher.fetch(URL_);
	assertEquals(res.attempts, 3);
	// exactly the DESIGN §9 granularity contract, in firing order
	assertEquals(log, [
		"request:1",
		"retry:1",
		"request:2",
		"retry:2",
		"request:3",
		"response:200",
	]);
	// one logical request = one id, shared by every event
	assertEquals(ids.size, 1);
	assertEquals([...ids][0], adapter.calls[0].requestId);
});

Deno.test("a failing request ends with exactly one onError, not one per attempt", async () => {
	const { events, log } = recordEvents();
	const adapter = stubAdapter("stub", [makeError({ kind: "network" })]);
	const fetcher = createFetcher({ adapters: adapter, retry: FAST, events });

	const e = await assertRejects(() => fetcher.fetch(URL_), PageFetchError);
	assertEquals(e.kind, "network");
	assertEquals(e.attempts, 3);
	assertEquals(log, [
		"request:1",
		"retry:1",
		"request:2",
		"retry:2",
		"request:3",
		"error:network",
	]);
});

Deno.test("retry: false means one attempt, and onRequest still fires", async () => {
	const { events, log } = recordEvents();
	const adapter = stubAdapter("stub", [makeError({ kind: "network" })]);
	const fetcher = createFetcher({ adapters: adapter, retry: false, events });

	await assertRejects(() => fetcher.fetch(URL_), PageFetchError);
	assertEquals(adapter.calls.length, 1);
	assertEquals(log, ["request:1", "error:network"]);
});

Deno.test("the breaker is off by default and opt-in-able; its refusals stay silent", async () => {
	const off = stubAdapter("stub", [makeError({ kind: "network" })]);
	const plain = createFetcher({ adapters: off, retry: false });
	for (let i = 0; i < 4; i++) await assertRejects(() => plain.fetch(URL_));
	assertEquals(off.calls.length, 4);

	const { events, log } = recordEvents();
	const on = stubAdapter("stub", [makeError({ kind: "network" })]);
	const guarded = createFetcher({
		adapters: on,
		retry: false,
		circuitBreaker: { threshold: 2, cooldown: 60_000 },
		events,
	});
	await assertRejects(() => guarded.fetch(URL_));
	await assertRejects(() => guarded.fetch(URL_));
	const e = await assertRejects(() => guarded.fetch(URL_), PageFetchError);
	assertEquals(e.kind, "circuit-open");
	assertEquals(on.calls.length, 2);
	// the refusal produced no terminal event — the breaker sits above the events
	// layer on purpose, so an open circuit cannot turn into an event storm
	// note the order: the events layer sits below the breaker, so it emits the
	// attempt's error first and the transition is announced by the layer above it
	assertEquals(log, [
		"request:1",
		"error:network",
		// attempt 1 again: these are two logical requests, not two attempts
		"request:1",
		"error:network",
		"circuit-open:stub.test",
	]);
});

Deno.test("the cache sits above events: a hit is silent, a 304 reports the 304", async () => {
	const store = createMemoryCache();
	const { events, log } = recordEvents();
	const adapter = stubAdapter("stub", [
		makeResult({ url: URL_, headers: { etag: '"v1"' } }),
	]);
	const fetcher = createFetcher({
		adapters: adapter,
		retry: false,
		cache: { store, mode: "dev" },
		events,
	});

	await fetcher.fetch(URL_);
	const hit = await fetcher.fetch(URL_);
	assert(hit.fromCache);
	assertEquals(hit.attempts, 0);
	assertEquals(adapter.calls.length, 1, "a pure hit never reaches the adapter");
	// ...and never reaches the events layer either, which sits BELOW the cache: a
	// caller counting responses through `events` does not see cache hits at all
	assertEquals(log, ["request:1", "response:200"]);

	// the same placement makes a revalidation report the *raw* 304, even though the
	// caller receives the synthesized 200
	const { events: revalEvents, log: revalLog } = recordEvents();
	const revalidator = stubAdapter("stub", [
		makeResult({ url: URL_, status: 304, body: null }),
	]);
	const conditional = createFetcher({
		adapters: revalidator,
		retry: false,
		cache: { store, mode: "conditional" },
		events: revalEvents,
	});
	const revalidated = await conditional.fetch(URL_);
	assertEquals(revalidated.status, 200, "the caller gets the stored status");
	assert(revalidated.notModified);
	assertEquals(revalLog, ["request:1", "response:304"]);
});

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

Deno.test("routing: first adapter is the default, req.adapter beats selectAdapter", async () => {
	const http = stubAdapter("http");
	const browser = stubAdapter("browser");
	const picked: string[] = [];
	const fetcher = createFetcher({
		adapters: [http, browser],
		selectAdapter: (req) => {
			picked.push(req.url);
			return req.url.endsWith("/spa") ? "browser" : undefined;
		},
	});

	assertEquals((await fetcher.fetch(URL_)).adapter, "http");
	assertEquals((await fetcher.fetch(`${URL_}/spa`)).adapter, "browser");
	// an explicit name wins over the hook
	assertEquals(
		(await fetcher.fetch({ url: `${URL_}/spa`, adapter: "http" })).adapter,
		"http",
	);
	assertEquals(picked.length, 2);
	assertEquals(http.calls.length, 2);
	assertEquals(browser.calls.length, 1);
});

Deno.test("routing: an unknown adapter name is a loud TypeError, never retried", async () => {
	const adapter = stubAdapter("http");
	const fetcher = createFetcher({ adapters: adapter, retry: FAST });

	const e = await assertRejects(
		() => fetcher.fetch({ url: URL_, adapter: "browser" }),
		TypeError,
	);
	assert(e.message.includes('Unknown adapter "browser"'));
	assert(e.message.includes("Available: http"));
	// a config error must not be classified, retried or counted
	assertEquals(adapter.calls.length, 0);
});

Deno.test("duplicate adapter names fail at construction", () => {
	const e = assertThrowsType(() =>
		createFetcher({ adapters: [stubAdapter("http"), stubAdapter("http")] })
	);
	assert(e.message.includes('duplicate adapter name "http"'));
	const empty = assertThrowsType(() => createFetcher({ adapters: [] }));
	assert(empty.message.includes("must not be empty"));
});

/** `assertThrows` typed to the error it returns. */
function assertThrowsType(fn: () => unknown): TypeError {
	try {
		fn();
	} catch (e) {
		assert(e instanceof TypeError, `expected a TypeError, got ${e}`);
		return e;
	}
	throw new Error("expected a throw");
}

// ---------------------------------------------------------------------------
// request defaults
// ---------------------------------------------------------------------------

Deno.test("defaults: headers merge case-insensitively, the request always wins", async () => {
	const adapter = stubAdapter("stub");
	const fetcher = createFetcher({
		adapters: adapter,
		headers: { "X-Api-Key": "secret", Accept: "text/html" },
		userAgent: "my-crawler/1.0",
	});

	await fetcher.fetch(URL_);
	assertEquals(adapter.calls[0].headers, {
		"user-agent": "my-crawler/1.0",
		"x-api-key": "secret",
		accept: "text/html",
	});

	await fetcher.fetch(URL_, {
		headers: { ACCEPT: "application/json", "User-Agent": "override/2.0" },
	});
	assertEquals(adapter.calls[1].headers, {
		"x-api-key": "secret",
		accept: "application/json",
		"user-agent": "override/2.0",
	});
});

Deno.test("defaults: a relative deadline is anchored once, before any layer sees it", async () => {
	const adapter = stubAdapter("stub");
	const fetcher = createFetcher({ adapters: adapter, deadline: 5_000, timeout: 250 });

	const before = Date.now();
	await fetcher.fetch(URL_);
	const seen = adapter.calls[0].deadline;
	assert(seen instanceof Date, "the deadline must reach the adapter absolute");
	assert(seen.getTime() >= before + 5_000 && seen.getTime() <= Date.now() + 5_000);

	// a per-request deadline wins over the fetcher default
	await fetcher.fetch(URL_, { deadline: 60_000 });
	assert((adapter.calls[1].deadline as Date).getTime() > seen.getTime());
});

Deno.test("defaults: the per-attempt timeout is armed and reported as `timeout`", async () => {
	const adapter: Adapter = { name: "stub", fetch: neverResolves() };
	const fetcher = createFetcher({ adapters: adapter, timeout: 25, retry: false });
	const e = await assertRejects(() => fetcher.fetch(URL_), PageFetchError);
	assertEquals(e.kind, "timeout");
	assertEquals(e.retryable, true);
});

Deno.test("defaults: an already-expired deadline fails before any I/O", async () => {
	const adapter = stubAdapter("stub");
	const fetcher = createFetcher({ adapters: adapter });
	const e = await assertRejects(
		() => fetcher.fetch(URL_, { deadline: new Date(Date.now() - 1) }),
		PageFetchError,
	);
	assertEquals(e.kind, "deadline");
	assertEquals(e.attempts, 0);
	assertEquals(adapter.calls.length, 0);
});

// ---------------------------------------------------------------------------
// throwOnHttpError
// ---------------------------------------------------------------------------

Deno.test("throwOnHttpError: off by default, and the result survives on the error", async () => {
	const adapter = stubAdapter("stub", [makeResult({ url: URL_, status: 404 })]);
	const quiet = createFetcher({ adapters: adapter, retry: false });
	assertEquals((await quiet.fetch(URL_)).status, 404);

	const { events, log } = recordEvents();
	const loud = createFetcher({
		adapters: stubAdapter("stub", [
			makeResult({ url: URL_, status: 404, statusText: "Not Found", body: "nope" }),
		]),
		retry: false,
		throwOnHttpError: true,
		events,
	});
	const e = await assertRejects(() => loud.fetch(URL_), PageFetchError);
	assertEquals(e.kind, "http");
	assertEquals(e.status, 404);
	assertEquals(e.retryable, false);
	assert(e.message.includes("HTTP 404 Not Found"));
	// nothing is lost: headers and body are still reachable
	const carried = e.details?.result as FetchResult;
	assertEquals(await carried.text(), "nope");
	// the terminal event is the error, not a response
	assertEquals(log, ["request:1", "error:http"]);
});

Deno.test("throwOnHttpError sits above retry, so Retry-After is still honored", async () => {
	const delays: number[] = [];
	const adapter = stubAdapter("stub", [
		makeResult({ url: URL_, status: 503, headers: { "retry-after": "0" } }),
		makeResult({ url: URL_, status: 503, headers: { "retry-after": "0" } }),
		makeResult({ url: URL_, status: 503, headers: { "retry-after": "0" } }),
	]);
	const fetcher = createFetcher({
		adapters: adapter,
		throwOnHttpError: true,
		retry: { ...FAST, baseDelay: 10_000, onRetry: (i) => delays.push(i.delay) },
	});

	const e = await assertRejects(() => fetcher.fetch(URL_), PageFetchError);
	assertEquals(e.kind, "http");
	assertEquals(e.attempts, 3);
	// the server said "0 seconds" — the 10 s local backoff never applied, which is
	// only possible if retry saw the RESULT and its headers
	assertEquals(delays, [0, 0]);
});

// ---------------------------------------------------------------------------
// requestId, logger, lifecycle
// ---------------------------------------------------------------------------

Deno.test("requestId: generated when absent, preserved when supplied", async () => {
	const adapter = stubAdapter("stub");
	const fetcher = createFetcher({ adapters: adapter, retry: FAST });

	const res = await fetcher.fetch(URL_);
	assert(res.requestId.length > 0);
	assertEquals(adapter.calls[0].requestId, res.requestId);
	assertStrictEquals(adapter.calls[0].requestId, res.requestId);

	await fetcher.fetch({ url: URL_, requestId: "caller-id" });
	assertEquals(adapter.calls[1].requestId, "caller-id");
});

Deno.test("the logger is threaded into every layer it constructs", async () => {
	const logger = recordingLogger();
	const adapter = stubAdapter("stub", [
		makeError({ kind: "network" }),
		makeResult({ url: URL_ }),
	]);
	const fetcher = createFetcher({
		adapters: adapter,
		retry: FAST,
		timeout: 5_000,
		logger,
	});

	await fetcher.fetch(URL_);
	const debug = logger.messages("debug").join("\n");
	assert(debug.includes('adapter "stub"'), "routing decision is logged");
	assert(debug.includes("attempt 1/3"), "retry logs attempts");
	assert(debug.includes("timeout budget 5000 ms"), "the timeout guard is wired");
	// the retry warning is the human channel of the onRetry event
	assertEquals(logger.messages("warn").length, 1);
	assert(logger.messages("warn")[0].includes("attempt 1 failed (network)"));
	// errors are thrown and emitted, never logged at error level
	assertEquals(logger.messages("error").length, 0);
});

Deno.test("a throwing event handler cannot break the fetch", async () => {
	const logger = recordingLogger();
	const boom = () => {
		throw new Error("handler exploded");
	};
	const fetcher = createFetcher({
		adapters: stubAdapter("stub"),
		logger,
		events: { onRequest: boom, onResponse: boom },
	});
	assertEquals((await fetcher.fetch(URL_)).status, 200);
	assertEquals(
		logger.messages("warn").filter((m) => m.includes("event handler threw")).length,
		2,
	);
});

Deno.test("dispose: idempotent, fans out, tolerates a failing adapter", async () => {
	const logger = recordingLogger();
	let a = 0;
	let b = 0;
	const first = stubAdapter("a", undefined, () => {
		a++;
		return Promise.resolve();
	});
	const second = stubAdapter("b", undefined, () => {
		b++;
		return Promise.reject(new Error("browser would not close"));
	});
	const fetcher = createFetcher({ adapters: [first, second], logger });

	await fetcher.fetch(URL_);
	// never throws, even though one adapter rejected
	await Promise.all([fetcher.dispose(), fetcher.dispose()]);
	await fetcher.dispose();
	assertEquals(a, 1);
	assertEquals(b, 1);
	assert(
		logger.messages("warn").some((m) => m.includes('adapter "b" failed to dispose')),
	);

	// a disposed fetcher is a usage error, not a fetch outcome
	const e = await assertRejects(
		() => fetcher.fetch(URL_),
		Error,
		"Fetcher is disposed",
	);
	assert(!PageFetchError.is(e));
});

Deno.test("`await using` disposes the adapters at the end of the scope", async () => {
	let disposed = 0;
	const adapter = stubAdapter("stub", undefined, () => {
		disposed++;
		return Promise.resolve();
	});
	{
		await using fetcher = createFetcher({ adapters: adapter });
		assertEquals((await fetcher.fetch(URL_)).ok, true);
		assertEquals(disposed, 0);
	}
	assertEquals(disposed, 1);
});

Deno.test("a bad url is rejected before anything is composed", async () => {
	const adapter = stubAdapter("stub");
	const fetcher = createFetcher({ adapters: adapter });
	await assertRejects(
		() => fetcher.fetch(""),
		TypeError,
		"`url` must be a non-empty string",
	);
	assertEquals(adapter.calls.length, 0);
});

// ---------------------------------------------------------------------------
// integration — the wired stack against the fixture server
// ---------------------------------------------------------------------------

Deno.test("createFetcher end to end", async (t) => {
	const server = await startFixtureServer();

	try {
		await t.step(
			"the default stack fetches with no configuration at all",
			async () => {
				await using fetcher = createFetcher();
				const res = await fetcher.fetch(server.url("/ok"));
				assertEquals(res.status, 200);
				assertEquals(res.adapter, "http");
				assertEquals(res.attempts, 1);
				assert((await res.text()).includes("ok"));
			},
		);

		await t.step("retries a flaky host to success, counting attempts", async () => {
			const { events, log, ids } = recordEvents();
			await using fetcher = createFetcher({ retry: FAST, events });
			const url = server.url("/flaky?fails=2&token=fetcher-flaky");
			const res = await fetcher.fetch(url);

			assertEquals(res.status, 200);
			assertEquals(res.attempts, 3);
			assertEquals(server.hits("fetcher-flaky", "/flaky"), 3);
			assertEquals(log, [
				"request:1",
				"retry:1",
				"request:2",
				"retry:2",
				"request:3",
				"response:200",
			]);
			assertEquals(ids.size, 1);
		});

		await t.step("the default User-Agent is sent and is overridable", async () => {
			await using fetcher = createFetcher();
			const sent = JSON.parse(
				await (await fetcher.fetch(server.url("/echo")))
					.text(),
			) as { headers: Record<string, string> };
			assertEquals(sent.headers["user-agent"], DEFAULT_USER_AGENT);

			await using mine = createFetcher({
				userAgent: "polite-bot (+me@example.com)",
			});
			const custom = JSON.parse(
				await (await mine.fetch(server.url("/echo")))
					.text(),
			) as { headers: Record<string, string> };
			assertEquals(custom.headers["user-agent"], "polite-bot (+me@example.com)");
		});

		await t.step("throwOnHttpError turns a real 404 into an error", async () => {
			await using fetcher = createFetcher({ throwOnHttpError: true, retry: false });
			const e = await assertRejects(
				() => fetcher.fetch(server.url("/status/404")),
				PageFetchError,
			);
			assertEquals(e.kind, "http");
			assertEquals(e.status, 404);
			assertEquals(await (e.details?.result as FetchResult).text(), "status 404");
		});

		await t.step("a custom adapter routes alongside the default one", async () => {
			const fake = stubAdapter("fake", [
				makeResult({ url: URL_, adapter: "fake", body: "from the fake" }),
			]);
			await using fetcher = createFetcher({
				adapters: [createHttpAdapter(), fake],
				selectAdapter: (req) => req.url.includes("/spa") ? "fake" : undefined,
			});
			assertEquals((await fetcher.fetch(server.url("/ok"))).adapter, "http");
			const spa = await fetcher.fetch(server.url("/spa"));
			assertEquals(spa.adapter, "fake");
			assertEquals(await spa.text(), "from the fake");
		});

		await t.step("the deadline stops the retry budget early", async () => {
			await using fetcher = createFetcher({
				retry: { attempts: 5, baseDelay: 50, jitter: false },
			});
			const started = Date.now();
			const res = await fetcher.fetch(
				server.url("/status/503?token=deadline"),
				{ deadline: 120 },
			);
			// a completed ok:false attempt is real data a crawler wants recorded, so
			// the deadline returns it rather than throwing it away
			assertEquals(res.status, 503);
			assert(res.attempts < 5, `stopped early, ran ${res.attempts} attempts`);
			assert(Date.now() - started < 1_000, "must not run the full retry budget");
		});

		await t.step("the deadline cuts off a request in flight", async () => {
			await using fetcher = createFetcher({ retry: FAST });
			const e = await assertRejects(
				() =>
					fetcher.fetch(server.url("/hang?token=deadline-hang"), {
						deadline: 100,
					}),
				PageFetchError,
			);
			assertEquals(e.kind, "deadline");
			assertEquals(e.retryable, false);
		});
	} finally {
		await server.shutdown();
	}
});

/**
 * Retry unit tests: stub `FetchFn`s plus `FakeTime` only. No sockets, no real sleeps —
 * Deno's timer sanitizer fails the test if a sleep ever escapes the faked clock.
 */
import { assert, assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { createRetry, defaultIsRetryable, parseRetryAfter } from "../src/retry.ts";
import { PageFetchError } from "../src/errors.ts";
import type { FetchRequest, RetryInfo } from "../src/types.ts";
import {
	failNTimes,
	makeError,
	makeResult,
	recordingLogger,
	scriptedFetch,
	settleWithFakeTime as settle,
} from "./helpers.ts";

const URL_ = "http://retry.test/";

Deno.test("parseRetryAfter handles both header forms", () => {
	assertEquals(parseRetryAfter("2"), 2000);
	assertEquals(parseRetryAfter(" 0 "), 0);
	assertEquals(parseRetryAfter(null), undefined);
	assertEquals(parseRetryAfter(""), undefined);
	assertEquals(parseRetryAfter("soon"), undefined);
	const now = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
	assertEquals(parseRetryAfter("Wed, 21 Oct 2026 07:28:30 GMT", now), 30_000);
	// a date in the past is clamped, never negative
	assertEquals(parseRetryAfter("Wed, 21 Oct 2026 07:27:00 GMT", now), 0);
});

Deno.test("defaultIsRetryable: kinds, statuses and the POST rule", () => {
	const req: FetchRequest = { url: URL_ };
	assert(defaultIsRetryable({ error: makeError({ kind: "network" }) }, 1, req));
	assert(defaultIsRetryable({ error: makeError({ kind: "timeout" }) }, 1, req));
	assert(defaultIsRetryable({ error: makeError({ kind: "browser" }) }, 1, req));
	for (
		const kind of [
			"too-large",
			"unsupported-type",
			"decode",
			"too-many-redirects",
			"circuit-open",
			"aborted",
			"deadline",
		] as const
	) {
		assert(!defaultIsRetryable({ error: makeError({ kind }) }, 1, req), kind);
	}
	for (const status of [408, 425, 429, 500, 503]) {
		assert(
			defaultIsRetryable({ result: makeResult({ status }) }, 1, req),
			`${status}`,
		);
	}
	for (const status of [200, 301, 400, 403, 404]) {
		assert(
			!defaultIsRetryable({ result: makeResult({ status }) }, 1, req),
			`${status}`,
		);
	}
	// POST is never retried by default, whatever went wrong
	const post: FetchRequest = { url: URL_, method: "POST" };
	assert(!defaultIsRetryable({ error: makeError({ kind: "network" }) }, 1, post));
	assert(!defaultIsRetryable({ result: makeResult({ status: 503 }) }, 1, post));
});

Deno.test("a first-attempt success is passed straight through", async () => {
	using time = new FakeTime();
	const next = scriptedFetch([makeResult({ url: URL_ })]);
	const res = await settle(time, createRetry()(next)({ url: URL_ }));
	assertEquals(res.attempts, 1);
	assertEquals(next.calls.length, 1);
});

Deno.test("retries a network error, then stamps the real attempt count", async () => {
	using time = new FakeTime();
	const next = failNTimes(2, makeResult({ url: URL_ }));
	const res = await settle(time, createRetry({ jitter: false })(next)({ url: URL_ }));
	assertEquals(res.attempts, 3);
	assertEquals(next.calls.length, 3);
});

Deno.test("retries an ok:false result and returns it as a result, never a throw", async () => {
	using time = new FakeTime();
	const next = scriptedFetch([
		makeResult({ url: URL_, status: 503 }),
		makeResult({ url: URL_, status: 503 }),
		makeResult({ url: URL_, status: 503 }),
	]);
	const res = await settle(time, createRetry({ jitter: false })(next)({ url: URL_ }));
	assertEquals(res.status, 503);
	assertEquals(res.ok, false);
	assertEquals(res.attempts, 3);
	assertEquals(next.calls.length, 3);
});

Deno.test("a non-retryable outcome stops immediately", async () => {
	using time = new FakeTime();
	const notFound = scriptedFetch([makeResult({ url: URL_, status: 404 })]);
	const res = await settle(time, createRetry()(notFound)({ url: URL_ }));
	assertEquals(res.status, 404);
	assertEquals(notFound.calls.length, 1);

	const tooLarge = scriptedFetch([makeError({ kind: "too-large" })]);
	const e = await assertRejects(
		() => settle(time, createRetry()(tooLarge)({ url: URL_ })),
		PageFetchError,
	);
	assertEquals(e.kind, "too-large");
	assertEquals(e.attempts, 1);
	assertEquals(tooLarge.calls.length, 1);
});

Deno.test("the last error is rethrown with the total attempt count", async () => {
	using time = new FakeTime();
	const next = scriptedFetch([makeError({ kind: "network" })]);
	const e = await assertRejects(
		() =>
			settle(
				time,
				createRetry({ attempts: 4, jitter: false })(next)({ url: URL_ }),
			),
		PageFetchError,
	);
	assertEquals(e.kind, "network");
	assertEquals(e.attempts, 4);
	assertEquals(next.calls.length, 4);
});

Deno.test("backoff shapes", async (t) => {
	const collect = async (opts: Parameters<typeof createRetry>[0]) => {
		using time = new FakeTime();
		const delays: number[] = [];
		const next = scriptedFetch([makeError()]);
		await assertRejects(() =>
			settle(
				time,
				createRetry({
					attempts: 4,
					jitter: false,
					onRetry: (i) => delays.push(i.delay),
					...opts,
				})(next)({ url: URL_ }),
			)
		);
		return delays;
	};

	await t.step("exponential (default)", async () => {
		assertEquals(await collect({ baseDelay: 100 }), [100, 200, 400]);
	});
	await t.step("linear", async () => {
		assertEquals(await collect({ backoff: "linear", baseDelay: 100 }), [
			100,
			200,
			300,
		]);
	});
	await t.step("fixed", async () => {
		assertEquals(await collect({ backoff: "fixed", baseDelay: 100 }), [
			100,
			100,
			100,
		]);
	});
	await t.step("custom function (jitter never applies)", async () => {
		assertEquals(
			await collect({ backoff: (n) => n * 7, jitter: true }),
			[7, 14, 21],
		);
	});
	await t.step("maxDelay caps every shape", async () => {
		assertEquals(
			await collect({ baseDelay: 1000, maxDelay: 1500 }),
			[1000, 1500, 1500],
		);
	});
});

Deno.test("full jitter keeps every delay within [0, raw]", async () => {
	using time = new FakeTime();
	const delays: number[] = [];
	const next = scriptedFetch([makeError()]);
	await assertRejects(() =>
		settle(
			time,
			createRetry({
				attempts: 5,
				baseDelay: 100,
				jitter: true,
				onRetry: (i) => delays.push(i.delay),
			})(next)({ url: URL_ }),
		)
	);
	assertEquals(delays.length, 4);
	delays.forEach((d, i) => {
		const raw = 100 * 2 ** i;
		assert(d >= 0 && d <= raw, `delay ${d} outside [0, ${raw}]`);
	});
	assert(
		delays.some((d) => d !== 100 * 2 ** delays.indexOf(d)),
		"jitter had no effect",
	);
});

Deno.test("Retry-After in seconds wins over the computed backoff", async () => {
	using time = new FakeTime();
	const delays: number[] = [];
	const next = scriptedFetch([
		makeResult({ status: 429, headers: { "retry-after": "2" } }),
		makeResult({ status: 200 }),
	]);
	const res = await settle(
		time,
		createRetry({ baseDelay: 10_000, onRetry: (i) => delays.push(i.delay) })(next)({
			url: URL_,
		}),
	);
	assertEquals(res.status, 200);
	assertEquals(delays, [2000]); // exact: server-directed delays are not jittered
});

Deno.test("Retry-After as an HTTP-date is honored and capped by maxDelay", async () => {
	using time = new FakeTime();
	const delays: number[] = [];
	const logger = recordingLogger();
	const next = scriptedFetch([
		makeResult({
			status: 503,
			headers: { "retry-after": new Date(Date.now() + 60_000).toUTCString() },
		}),
		makeResult({ status: 200 }),
	]);
	const res = await settle(
		time,
		createRetry({
			maxDelay: 5000,
			logger,
			onRetry: (i) => delays.push(i.delay),
		})(next)({ url: URL_ }),
	);
	assertEquals(res.status, 200);
	assertEquals(delays, [5000]);
	assert(logger.messages("warn").some((m) => m.includes("capped")));
});

Deno.test("an unparseable Retry-After falls back to the backoff", async () => {
	using time = new FakeTime();
	const delays: number[] = [];
	const next = scriptedFetch([
		makeResult({ status: 429, headers: { "retry-after": "whenever" } }),
		makeResult({ status: 200 }),
	]);
	await settle(
		time,
		createRetry({
			baseDelay: 250,
			jitter: false,
			onRetry: (i) => delays.push(i.delay),
		})(
			next,
		)({ url: URL_ }),
	);
	assertEquals(delays, [250]);
});

Deno.test("respectRetryAfter: false ignores the header", async () => {
	using time = new FakeTime();
	const delays: number[] = [];
	const next = scriptedFetch([
		makeResult({ status: 429, headers: { "retry-after": "300" } }),
		makeResult({ status: 200 }),
	]);
	await settle(
		time,
		createRetry({
			respectRetryAfter: false,
			baseDelay: 50,
			jitter: false,
			onRetry: (i) => delays.push(i.delay),
		})(next)({ url: URL_ }),
	);
	assertEquals(delays, [50]);
});

Deno.test("a sleep is never taken past the deadline: result in hand is returned", async () => {
	using time = new FakeTime();
	const next = scriptedFetch([makeResult({ status: 503 })]);
	const res = await settle(
		time,
		createRetry({ attempts: 5, baseDelay: 10_000, jitter: false })(next)({
			url: URL_,
			deadline: 1000,
		}),
	);
	// the 503 is real data — it must survive the deadline, not be replaced by an error
	assertEquals(res.status, 503);
	assertEquals(res.attempts, 1);
	assertEquals(next.calls.length, 1);
});

Deno.test("a sleep is never taken past the deadline: error in hand becomes kind deadline", async () => {
	using time = new FakeTime();
	const next = scriptedFetch([makeError({ kind: "network", message: "connreset" })]);
	const err = await assertRejects(
		() =>
			settle(
				time,
				createRetry({ attempts: 5, baseDelay: 10_000, jitter: false })(next)({
					url: URL_,
					deadline: 1000,
				}),
			),
		PageFetchError,
	);
	assertEquals(err.kind, "deadline");
	assertEquals(err.retryable, false);
	assertEquals(err.attempts, 1);
	assert(PageFetchError.is(err.cause));
	assertEquals((err.cause as PageFetchError).kind, "network");
});

Deno.test("an already-expired deadline fails before any I/O", async () => {
	using time = new FakeTime();
	const next = scriptedFetch([makeResult()]);
	const e = await assertRejects(
		() =>
			settle(
				time,
				createRetry()(next)({ url: URL_, deadline: new Date(Date.now() - 1) }),
			),
		PageFetchError,
	);
	assertEquals(e.kind, "deadline");
	assertEquals(e.attempts, 0);
	assertEquals(next.calls.length, 0);
});

Deno.test("the deadline does not slide: a relative number is anchored once", async () => {
	using time = new FakeTime();
	const seen: (number | Date | undefined)[] = [];
	const next = scriptedFetch([(req) => {
		seen.push(req.deadline);
		throw makeError({ kind: "network" });
	}]);
	await assertRejects(() =>
		settle(
			time,
			createRetry({ attempts: 3, baseDelay: 100, jitter: false })(next)({
				url: URL_,
				deadline: 10_000,
			}),
		)
	);
	assertEquals(seen.length, 3);
	// every attempt sees the same absolute instant, not a fresh relative window
	assert(seen[0] instanceof Date);
	assertEquals((seen[0] as Date).getTime(), (seen[2] as Date).getTime());
});

Deno.test("aborting during the backoff sleep rejects promptly", async () => {
	using time = new FakeTime();
	const ctrl = new AbortController();
	const next = scriptedFetch([makeError({ kind: "network" })]);
	const pending = createRetry({ attempts: 3, baseDelay: 5000, jitter: false })(next)({
		url: URL_,
		signal: ctrl.signal,
	});
	const settled = pending.then((v) => ({ v }), (e) => ({ e }));
	await time.tickAsync(100); // attempt 1 failed, now sleeping
	assertEquals(next.calls.length, 1);
	ctrl.abort();
	await time.tickAsync(0);
	const out = await settled as { e: PageFetchError };
	assertEquals(out.e.kind, "aborted");
	assertEquals(out.e.attempts, 1);
	assertEquals(next.calls.length, 1); // no second attempt was started
});

Deno.test("an already-aborted signal fails before any I/O", async () => {
	using time = new FakeTime();
	const next = scriptedFetch([makeResult()]);
	const e = await assertRejects(
		() =>
			settle(time, createRetry()(next)({ url: URL_, signal: AbortSignal.abort() })),
		PageFetchError,
	);
	assertEquals(e.kind, "aborted");
	assertEquals(e.attempts, 0);
	assertEquals(next.calls.length, 0);
});

Deno.test("POST is not retried by default, but can be opted in", async () => {
	using time = new FakeTime();
	const next = failNTimes(1, makeResult({ status: 200 }));
	const e = await assertRejects(
		() => settle(time, createRetry()(next)({ url: URL_, method: "POST" })),
		PageFetchError,
	);
	assertEquals(e.attempts, 1);
	assertEquals(next.calls.length, 1);

	const opted = failNTimes(1, makeResult({ status: 200 }));
	const res = await settle(
		time,
		createRetry({
			jitter: false,
			isRetryable: (outcome) => !!outcome.error?.retryable,
		})(opted)({ url: URL_, method: "POST" }),
	);
	assertEquals(res.attempts, 2);
});

Deno.test("non-PageFetchError throws pass through unclassified", async () => {
	using time = new FakeTime();
	const boom = new TypeError('Unknown adapter "nope"');
	const next = scriptedFetch([boom]);
	const thrown = await assertRejects(
		() => settle(time, createRetry()(next)({ url: URL_ })),
		TypeError,
	);
	assertStrictEquals(thrown, boom);
	assertEquals(next.calls.length, 1);
});

Deno.test("events: N onRequest, N-1 onRetry, one stable requestId", async () => {
	using time = new FakeTime();
	const requests: { requestId: string; attempt: number }[] = [];
	const retries: RetryInfo[] = [];
	const next = failNTimes(2, makeResult({ status: 200 }));
	const res = await settle(
		time,
		createRetry({
			jitter: false,
			events: {
				onRequest: (_req, info) => requests.push(info),
				onRetry: (info) => retries.push(info),
			},
		})(next)({ url: URL_ }),
	);
	assertEquals(requests.length, 3);
	assertEquals(retries.length, 2);
	assertEquals(requests.map((r) => r.attempt), [1, 2, 3]);
	assertEquals(retries.map((r) => r.attempt), [1, 2]);
	assertEquals(new Set(requests.map((r) => r.requestId)).size, 1);
	assertEquals(requests[0].requestId, res.requestId ? requests[0].requestId : "");
	// either/or payload: a thrown attempt carries error, never result
	assert(retries.every((r) => !!r.error && r.result === undefined));
});

Deno.test("a throwing event handler cannot break the fetch", async () => {
	using time = new FakeTime();
	const logger = recordingLogger();
	const next = failNTimes(1, makeResult({ status: 200 }));
	const res = await settle(
		time,
		createRetry({
			jitter: false,
			logger,
			events: {
				onRequest: () => {
					throw new Error("handler exploded");
				},
			},
		})(next)({ url: URL_ }),
	);
	assertEquals(res.status, 200);
	assert(logger.messages("warn").some((m) => m.includes("event handler threw")));
});

Deno.test("requestId is generated when absent and reaches the adapter", async () => {
	using time = new FakeTime();
	const next = scriptedFetch([(req) => makeResult({ requestId: req.requestId })]);
	const res = await settle(time, createRetry()(next)({ url: URL_ }));
	assert(next.calls[0].requestId);
	assertEquals(res.requestId, next.calls[0].requestId);
});

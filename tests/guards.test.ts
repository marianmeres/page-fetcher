/**
 * Guard tests: the unit half runs on `FakeTime` with stub `FetchFn`s, the integration
 * half runs against the fixture server on the real clock.
 */
import { assert, assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { composeSignal, deadlineGuard, timeoutGuard } from "../src/guards.ts";
import { createRetry } from "../src/retry.ts";
import { resolveDeadline, sleep } from "../src/utils.ts";
import { PageFetchError } from "../src/errors.ts";
import { createHttpAdapter } from "../src/adapters/http.ts";
import { startFixtureServer } from "./fixtures/server.ts";
import {
	delayedFetch,
	makeResult,
	neverResolves,
	scriptedFetch,
	settleWithFakeTime as settle,
} from "./helpers.ts";

const URL_ = "http://guards.test/";

Deno.test("composeSignal drops empty slots and adopts abort reasons", () => {
	assertEquals(composeSignal([]), undefined);
	assertEquals(composeSignal([undefined, null]), undefined);

	const only = new AbortController().signal;
	assertStrictEquals(composeSignal([undefined, only, null]), only);

	const a = new AbortController();
	const b = new AbortController();
	const composed = composeSignal([a.signal, b.signal])!;
	assert(composed !== a.signal);
	const reason = new PageFetchError({ kind: "timeout", url: URL_ });
	b.abort(reason);
	assert(composed.aborted);
	// the reason survives the composition — this is what lets the catch side tell a
	// timeout from a deadline from a caller cancellation
	assertStrictEquals(composed.reason, reason);
});

Deno.test("resolveDeadline: number is relative, Date is absolute", () => {
	assertEquals(resolveDeadline(undefined), undefined);
	assertEquals(resolveDeadline(1000, 5_000), 6_000);
	assertEquals(resolveDeadline(new Date(9_000), 5_000), 9_000);
});

Deno.test("sleep resolves, and rejects immediately with the abort reason", async () => {
	using time = new FakeTime();
	let resolved = false;
	const p = sleep(100).then(() => {
		resolved = true;
	});
	await time.tickAsync(100);
	await p;
	assert(resolved);

	const ctrl = new AbortController();
	const reason = new PageFetchError({ kind: "deadline", url: URL_ });
	const pending = sleep(60_000, ctrl.signal);
	const settled = pending.then(() => "resolved", (e) => e);
	ctrl.abort(reason);
	assertStrictEquals(await settled, reason);

	// an already-aborted signal never even arms a timer
	assertStrictEquals(
		await sleep(50, AbortSignal.abort(reason)).then(() => "resolved", (e) => e),
		reason,
	);
});

Deno.test("timeoutGuard is a pass-through when nothing is configured", async () => {
	const next = scriptedFetch([makeResult({ url: URL_ })]);
	const res = await timeoutGuard()(next)({ url: URL_ });
	assertEquals(res.status, 200);
	assertEquals(next.calls[0].signal, undefined);
});

Deno.test("timeoutGuard aborts a slow attempt with kind timeout", async () => {
	using time = new FakeTime();
	const next = neverResolves();
	const e = await assertRejects(
		() => settle(time, timeoutGuard()(next)({ url: URL_, timeout: 1000 })),
		PageFetchError,
	);
	assertEquals(e.kind, "timeout");
	assertEquals(e.retryable, true); // a slow attempt is worth another try
	assert(e.message.includes("1000 ms"));
});

Deno.test("timeoutGuard: defaultTimeout applies, the request overrides it", async () => {
	using time = new FakeTime();
	const seen: number[] = [];
	const guard = timeoutGuard({ defaultTimeout: 500 });

	for (const [timeout, expected] of [[undefined, 500], [2000, 2000]] as const) {
		const start = Date.now();
		const next = neverResolves();
		await assertRejects(
			() => settle(time, guard(next)({ url: URL_, timeout })),
			PageFetchError,
		);
		seen.push(Date.now() - start);
		assertEquals(seen.at(-1), expected);
	}
});

Deno.test("timeoutGuard re-arms per call and leaves no timer behind", async () => {
	using time = new FakeTime();
	const next = delayedFetch(10, makeResult({ url: URL_ }));
	// the fast path must clear its timer — Deno's timer sanitizer fails this test
	// otherwise, which is exactly the assertion we want
	for (let i = 0; i < 3; i++) {
		const res = await settle(
			time,
			timeoutGuard()(next)({ url: URL_, timeout: 1000 }),
		);
		assertEquals(res.status, 200);
	}
	assertEquals(next.calls.length, 3);
});

Deno.test("timeoutGuard: whichever constraint binds first names the failure", async () => {
	using time = new FakeTime();

	// deadline shorter than the per-attempt timeout -> deadline, not retryable
	const byDeadline = await assertRejects(
		() =>
			settle(
				time,
				timeoutGuard()(neverResolves())({
					url: URL_,
					timeout: 10_000,
					deadline: new Date(Date.now() + 1000),
				}),
			),
		PageFetchError,
	);
	assertEquals(byDeadline.kind, "deadline");
	assertEquals(byDeadline.retryable, false);

	// timeout shorter than the deadline -> timeout, retryable
	const byTimeout = await assertRejects(
		() =>
			settle(
				time,
				timeoutGuard()(neverResolves())({
					url: URL_,
					timeout: 500,
					deadline: new Date(Date.now() + 30_000),
				}),
			),
		PageFetchError,
	);
	assertEquals(byTimeout.kind, "timeout");
	assertEquals(byTimeout.retryable, true);
});

Deno.test("a caller abort beats the guard's own timer", async () => {
	using time = new FakeTime();
	const ctrl = new AbortController();
	const pending = timeoutGuard()(neverResolves())({
		url: URL_,
		timeout: 60_000,
		signal: ctrl.signal,
	});
	const settled = pending.then(() => "resolved", (e) => e);
	await time.tickAsync(10);
	ctrl.abort();
	const out = await settled;
	// the guard's reason was not adopted — the caller's plain abort came first
	assert(!PageFetchError.is(out));
});

Deno.test("deadlineGuard fails fast when the deadline already passed", async () => {
	const next = scriptedFetch([makeResult()]);
	const e = await assertRejects(
		() => deadlineGuard()(next)({ url: URL_, deadline: new Date(Date.now() - 1) }),
		PageFetchError,
	);
	assertEquals(e.kind, "deadline");
	assertEquals(e.retryable, false);
	assertEquals(e.attempts, 0);
	assertEquals(next.calls.length, 0);
});

Deno.test("deadlineGuard anchors a relative deadline to an absolute Date", async () => {
	const next = scriptedFetch([makeResult()]);
	const before = Date.now();
	await deadlineGuard()(next)({ url: URL_, deadline: 5000 });
	const anchored = next.calls[0].deadline;
	assert(anchored instanceof Date);
	const at = (anchored as Date).getTime();
	assert(at >= before + 5000 && at <= Date.now() + 5000);
});

Deno.test("deadlineGuard passes through when no deadline is configured", async () => {
	const next = scriptedFetch([makeResult()]);
	await deadlineGuard()(next)({ url: URL_ });
	assertEquals(next.calls[0].deadline, undefined);
	assertEquals(next.calls[0].signal, undefined);

	// ... and applies its own default when one is set
	const withDefault = scriptedFetch([makeResult()]);
	await deadlineGuard({ defaultDeadline: 5000 })(withDefault)({ url: URL_ });
	assert(withDefault.calls[0].deadline instanceof Date);
});

Deno.test("deadlineGuard cuts off an attempt that is still in flight", async () => {
	using time = new FakeTime();
	const e = await assertRejects(
		() =>
			settle(time, deadlineGuard()(neverResolves())({ url: URL_, deadline: 1000 })),
		PageFetchError,
	);
	assertEquals(e.kind, "deadline");
	assertEquals(e.retryable, false);
});

Deno.test("wired stack: the deadline bounds the whole retry loop, not each attempt", async () => {
	using time = new FakeTime();
	const start = Date.now();
	const next = neverResolves();
	// deadline(1500) over retry(3 attempts) over timeout(1000 per attempt):
	// without the deadline this would run 3 × 1000 ms plus backoff
	const stack = deadlineGuard()(
		createRetry({ attempts: 3, baseDelay: 100, jitter: false })(
			timeoutGuard()(next),
		),
	);
	const e = await assertRejects(
		() => settle(time, stack({ url: URL_, timeout: 1000, deadline: 1500 })),
		PageFetchError,
	);
	assertEquals(e.kind, "deadline");
	const elapsed = Date.now() - start;
	assert(elapsed <= 1600, `took ${elapsed} ms of virtual time`);
	// attempt 1 timed out (retryable), attempt 2 ran into the deadline
	assertEquals(next.calls.length, 2);
});

Deno.test("guards over the real adapter", async (t) => {
	const server = await startFixtureServer();
	const http = createHttpAdapter();

	try {
		await t.step("a per-attempt timeout stops a hanging request", async () => {
			const guarded = timeoutGuard()(http.fetch);
			const e = await assertRejects(
				() => guarded({ url: server.url("/hang?token=g1"), timeout: 50 }),
				PageFetchError,
			);
			assertEquals(e.kind, "timeout");
			assertEquals(e.retryable, true);
			assertEquals(e.attempts, 1);
		});

		await t.step(
			"a deadline stops a hanging request and is not retryable",
			async () => {
				const guarded = deadlineGuard()(
					createRetry({ attempts: 3 })(timeoutGuard()(http.fetch)),
				);
				const e = await assertRejects(
					() => guarded({ url: server.url("/hang?token=g2"), deadline: 60 }),
					PageFetchError,
				);
				assertEquals(e.kind, "deadline");
				assertEquals(e.retryable, false);
			},
		);

		await t.step("a slow-but-finishing request survives its timeout", async () => {
			const guarded = timeoutGuard()(http.fetch);
			const res = await guarded({
				url: server.url("/slow?ms=10&token=g3"),
				timeout: 2000,
			});
			assertEquals(res.status, 200);
			assertEquals(await res.text(), "slow");
		});

		await t.step(
			"a caller abort mid-body reaches the adapter as kind aborted",
			async () => {
				const ctrl = new AbortController();
				const guarded = timeoutGuard()(http.fetch);
				const pending = guarded({
					url: server.url("/trickle?chunks=20&ms=25"),
					timeout: 10_000,
					signal: ctrl.signal,
				});
				const timer = setTimeout(() => ctrl.abort(), 40);
				const e = await assertRejects(() => pending, PageFetchError);
				clearTimeout(timer);
				assertEquals(e.kind, "aborted");
				assertEquals(e.retryable, false);
			},
		);

		await t.step("retry integration: a flaky host recovers", async () => {
			const stack = createRetry({ baseDelay: 1, jitter: false })(http.fetch);
			const res = await stack({ url: server.url("/flaky?fails=2&token=g4") });
			assertEquals(res.status, 200);
			assertEquals(res.attempts, 3);
			assertEquals(server.hits("g4", "/flaky"), 3);
		});

		await t.step("retry integration: Retry-After from a real 429", async () => {
			const stack = createRetry({ baseDelay: 5_000 })(http.fetch);
			const started = Date.now();
			const res = await stack({
				url: server.url("/rate-limited?fails=1&token=g5"),
			});
			assertEquals(res.status, 200);
			assertEquals(res.attempts, 2);
			// Retry-After: 0 wins over the 5 s backoff
			assert(Date.now() - started < 1000, "Retry-After was ignored");
		});
	} finally {
		await server.shutdown();
	}
});

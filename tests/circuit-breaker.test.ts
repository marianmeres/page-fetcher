/**
 * Circuit-breaker unit tests: stub `FetchFn`s plus `FakeTime` only. No sockets — a
 * failure here is always a logic failure.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import {
	type CircuitStateChange,
	createCircuitBreaker,
	defaultIsFailure,
} from "../src/circuit-breaker.ts";
import { PageFetchError } from "../src/errors.ts";
import type { FetchFn, FetchResult } from "../src/types.ts";
import { makeError, makeResult, recordingLogger, scriptedFetch } from "./helpers.ts";

const URL_A = "http://a.test/page";
const URL_B = "http://b.test/page";

/** Drive `n` requests through `fn`, keeping whatever each one produced. */
async function drive(fn: FetchFn, url: string, n: number): Promise<unknown[]> {
	const out: unknown[] = [];
	for (let i = 0; i < n; i++) {
		try {
			out.push(await fn({ url }));
		} catch (e) {
			out.push(e);
		}
	}
	return out;
}

/** The network error every "host is down" test fails with. */
const down = () => makeError({ kind: "network" });

/** The `kind` of the {@linkcode PageFetchError} `fn` rejects with. */
async function kindOf(fn: () => Promise<unknown>): Promise<string> {
	return (await assertRejects(fn, PageFetchError)).kind;
}

Deno.test("defaultIsFailure asks 'is the host down?', not 'did this go well?'", () => {
	for (const kind of ["network", "timeout", "browser"] as const) {
		assert(defaultIsFailure({ error: makeError({ kind }) }), kind);
	}
	// server-side breakage, whichever shape it arrived in
	assert(defaultIsFailure({ result: makeResult({ status: 500 }) }));
	assert(defaultIsFailure({ result: makeResult({ status: 503 }) }));
	assert(defaultIsFailure({ error: makeError({ kind: "http", status: 503 }) }));

	// the host is up and answering — including when it is rate limiting us
	for (const status of [200, 301, 404, 429]) {
		assert(!defaultIsFailure({ result: makeResult({ status }) }), `${status}`);
	}
	// our policy or our cancellation, not their health
	for (
		const kind of [
			"too-large",
			"unsupported-type",
			"decode",
			"too-many-redirects",
			"aborted",
			"deadline",
			"circuit-open",
		] as const
	) {
		assert(!defaultIsFailure({ error: makeError({ kind }) }), kind);
	}
	assertEquals(defaultIsFailure({}), false);
});

Deno.test("a healthy host is passed through untouched", async () => {
	const next = scriptedFetch([makeResult({ url: URL_A })]);
	const fn = createCircuitBreaker({ threshold: 2 })(next);
	const results = await drive(fn, URL_A, 5) as FetchResult[];
	assertEquals(next.calls.length, 5);
	assert(results.every((r) => r.ok));
});

Deno.test("opens after `threshold` consecutive failures and then refuses locally", async () => {
	using _time = new FakeTime();
	const next = scriptedFetch([down()]);
	const fn = createCircuitBreaker({ threshold: 3, cooldown: 10_000 })(next);

	await drive(fn, URL_A, 3);
	assertEquals(next.calls.length, 3);

	const e = await assertRejects(() => fn({ url: URL_A }), PageFetchError);
	assertEquals(e.kind, "circuit-open");
	assertEquals(e.attempts, 0);
	assertEquals(e.retryable, false);
	assertEquals(e.url, URL_A);
	assertEquals(e.details?.host, "a.test");
	assertEquals(e.details?.state, "open");
	assertEquals(e.details?.until, Date.now() + 10_000);
	// the whole point: no I/O happened
	assertEquals(next.calls.length, 3);
});

Deno.test("any answer from the host resets the consecutive-failure count", async () => {
	const next = scriptedFetch([
		down(),
		down(),
		// a 404 is the host answering — it is up
		makeResult({ url: URL_A, status: 404 }),
		down(),
		down(),
		makeResult({ url: URL_A }),
	]);
	const fn = createCircuitBreaker({ threshold: 3 })(next);

	const out = await drive(fn, URL_A, 6);
	// 4 failures in total, but never 3 in a row — the circuit never opened
	assertEquals(next.calls.length, 6);
	assertEquals((out[5] as FetchResult).ok, true);
});

Deno.test("state is per host, and the port is part of the host", async () => {
	const next = scriptedFetch([down()]);
	const fn = createCircuitBreaker({ threshold: 2 })(next);

	await drive(fn, URL_A, 2);
	assertEquals(await kindOf(() => fn({ url: URL_A })), "circuit-open");

	// a different host is untouched: the request reaches the (failing) next
	assertEquals(await kindOf(() => fn({ url: URL_B })), "network");
	// so is the same name on a different port — two ports are two servers
	const other = "http://a.test:8080/page";
	assertEquals(await kindOf(() => fn({ url: other })), "network");
	assertEquals(next.calls.length, 4);
});

Deno.test("half-open: one probe is let through after the cooldown; success closes", async () => {
	using time = new FakeTime();
	const states: CircuitStateChange[] = [];
	const next = scriptedFetch([down(), down(), makeResult({ url: URL_A })]);
	const fn = createCircuitBreaker({
		threshold: 2,
		cooldown: 10_000,
		onStateChange: (i) => states.push(i),
	})(next);

	await drive(fn, URL_A, 2);
	assertEquals(await kindOf(() => fn({ url: URL_A })), "circuit-open");

	// one millisecond short of the cooldown is still open
	await time.tickAsync(9_999);
	assertEquals(await kindOf(() => fn({ url: URL_A })), "circuit-open");
	assertEquals(next.calls.length, 2);

	await time.tickAsync(1);
	const res = await fn({ url: URL_A });
	assertEquals(res.ok, true);
	assertEquals(next.calls.length, 3);

	// closed again — and the entry is gone, so the counter starts from zero
	const after = await drive(fn, URL_A, 3) as FetchResult[];
	assert(after.every((r) => r.ok));
	assertEquals(states.map((s) => s.state), ["open", "half-open", "closed"]);
	assertEquals(states[0].failures, 2);
	assertEquals(states[2].failures, 0);
});

Deno.test("half-open: a failing probe re-opens with a fresh cooldown", async () => {
	using time = new FakeTime();
	const states: CircuitStateChange[] = [];
	const next = scriptedFetch([down()]);
	const fn = createCircuitBreaker({
		threshold: 2,
		cooldown: 10_000,
		onStateChange: (i) => states.push(i),
	})(next);

	await drive(fn, URL_A, 2);
	await time.tickAsync(10_000);

	// the probe reaches the host and fails — the caller sees the real error
	assertEquals(await kindOf(() => fn({ url: URL_A })), "network");
	assertEquals(next.calls.length, 3);

	const e = await assertRejects(() => fn({ url: URL_A }), PageFetchError);
	assertEquals(e.kind, "circuit-open");
	assertEquals(e.details?.until, Date.now() + 10_000);
	assertEquals(states.map((s) => s.state), ["open", "half-open", "open"]);
});

Deno.test("half-open: concurrent requests are refused while the probe is in flight", async () => {
	using time = new FakeTime();
	let release!: (r: FetchResult) => void;
	const next = scriptedFetch([
		down(),
		down(),
		() => new Promise<FetchResult>((resolve) => (release = resolve)),
		makeResult({ url: URL_A }),
	]);
	const fn = createCircuitBreaker({ threshold: 2, cooldown: 10_000 })(next);

	await drive(fn, URL_A, 2);
	await time.tickAsync(10_000);

	const probe = fn({ url: URL_A });
	const e = await assertRejects(() => fn({ url: URL_A }), PageFetchError);
	assertEquals(e.kind, "circuit-open");
	assertEquals(e.details?.state, "half-open");
	assertEquals(e.details?.until, undefined);
	assertEquals(next.calls.length, 3);

	release(makeResult({ url: URL_A }));
	assertEquals((await probe).ok, true);
	// the probe closed the circuit — traffic flows again
	assertEquals((await fn({ url: URL_A })).ok, true);
});

Deno.test("aborts and deadlines are inconclusive: they neither trip nor clear", async () => {
	const aborted = scriptedFetch([makeError({ kind: "aborted" })]);
	const never = createCircuitBreaker({ threshold: 2 })(aborted);
	await drive(never, URL_A, 4);
	// four failed requests, still closed — we learned nothing about the host
	assertEquals(aborted.calls.length, 4);

	const mixed = scriptedFetch([
		down(),
		makeError({ kind: "deadline" }),
		down(),
	]);
	const fn = createCircuitBreaker({ threshold: 2 })(mixed);
	await drive(fn, URL_A, 3);
	// the deadline in the middle did not reset the count: 2 real failures = open
	assertEquals(await kindOf(() => fn({ url: URL_A })), "circuit-open");
	assertEquals(mixed.calls.length, 3);
});

Deno.test("a non-PageFetchError is passed through and never counted", async () => {
	const next = scriptedFetch([new TypeError("bad adapter config")]);
	const fn = createCircuitBreaker({ threshold: 1 })(next);
	for (let i = 0; i < 3; i++) {
		await assertRejects(() => fn({ url: URL_A }), TypeError, "bad adapter config");
	}
	assertEquals(next.calls.length, 3);
});

Deno.test("an unparseable URL bypasses the breaker entirely", async () => {
	const next = scriptedFetch([down()]);
	const fn = createCircuitBreaker({ threshold: 1 })(next);
	await assertRejects(() => fn({ url: "not a url" }), PageFetchError);
	await assertRejects(() => fn({ url: "not a url" }), PageFetchError);
	assertEquals(next.calls.length, 2);
});

Deno.test("the open transition is announced once, not once per refusal", async () => {
	using _time = new FakeTime();
	const opens: { host: string; until: number; requestId?: string }[] = [];
	const next = scriptedFetch([down()]);
	const fn = createCircuitBreaker({
		threshold: 2,
		cooldown: 10_000,
		events: { onCircuitOpen: (i) => opens.push(i) },
	})(next);

	await drive(fn, URL_A, 2);
	await drive(fn, URL_A, 5);
	assertEquals(opens.length, 1);
	assertEquals(opens[0].host, "a.test");
	assertEquals(opens[0].until, Date.now() + 10_000);
	assert(typeof opens[0].requestId === "string");
});

Deno.test("requestId is stamped when missing and threaded everywhere", async () => {
	const opens: { requestId?: string }[] = [];
	const next = scriptedFetch([down()]);
	const fn = createCircuitBreaker({
		threshold: 1,
		events: { onCircuitOpen: (i) => opens.push(i) },
	})(next);

	await assertRejects(() => fn({ url: URL_A }));
	const stamped = next.calls[0].requestId;
	assert(typeof stamped === "string" && stamped.length > 0);
	assertEquals(opens[0].requestId, stamped);

	// a caller-supplied id is preserved and lands on the refusal
	const e = await assertRejects(
		() => fn({ url: URL_A, requestId: "caller-id" }),
		PageFetchError,
	);
	assertEquals(e.requestId, "caller-id");
});

Deno.test("a throwing event handler never breaks the pipeline", async () => {
	const logger = recordingLogger();
	const next = scriptedFetch([down()]);
	const fn = createCircuitBreaker({
		threshold: 1,
		logger,
		onStateChange: () => {
			throw new Error("boom");
		},
		events: {
			onCircuitOpen: () => {
				throw new Error("bang");
			},
		},
	})(next);

	// the outcome is the adapter's error, not the handler's
	assertEquals(await kindOf(() => fn({ url: URL_A })), "network");
	assertEquals(
		logger.messages("warn").filter((m) => m.includes("event handler threw")).length,
		2,
	);
	// and the circuit still opened
	assertEquals(await kindOf(() => fn({ url: URL_A })), "circuit-open");
});

Deno.test("a custom isFailure replaces the built-in table", async () => {
	const next = scriptedFetch([makeResult({ url: URL_A, status: 404 })]);
	const fn = createCircuitBreaker({
		threshold: 2,
		isFailure: (o) => (o.result?.status ?? 0) === 404,
	})(next);
	await drive(fn, URL_A, 2);
	assertEquals(await kindOf(() => fn({ url: URL_A })), "circuit-open");
	assertEquals(next.calls.length, 2);
});

/**
 * Context pool + exit hook unit tests, against the in-memory fake driver.
 *
 * This is the design win the driver interface was built for: recycling, crash recovery
 * and the waiter queue — the hardest and flakiest part of any browser tooling — are
 * covered in the default, browserless test run, instead of being tested only through a
 * real Chromium where a hang looks like slowness.
 *
 * The invariant every "never wedge" test below pins: no waiter promise stays pending
 * after (a) its timeout, (b) its signal, (c) dispose, or (d) a failed relaunch.
 */
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
	createContextPool,
	DEFAULT_MAX_PAGES_PER_CONTEXT,
	DEFAULT_POOL_SIZE,
	poolShapeFor,
} from "../src/adapters/browser/pool.ts";
import {
	type ExitEvent,
	type ExitHookHost,
	registerExitHook,
} from "../src/adapters/browser/exit-hook.ts";
import type { BrowserDriver } from "../src/adapters/browser/driver.ts";
import { type FakeDriver, fakeDriver } from "./fixtures/fake-driver.ts";
import { recordingLogger } from "./helpers.ts";

/** A pool over a fresh fake driver, with the exit hook off (tests never touch signals). */
function poolOver(
	options: Partial<Parameters<typeof createContextPool>[0]> = {},
	driverOptions: Parameters<typeof fakeDriver>[0] = {},
) {
	const driver = options.driver as FakeDriver ?? fakeDriver(driverOptions);
	const pool = createContextPool({ exitHooks: false, ...options, driver });
	return { pool, driver };
}

/** Wrap a driver so launch number `n + 1` and beyond fail. */
function launchesOnce(driver: FakeDriver, n: number): BrowserDriver {
	let seen = 0;
	return {
		name: driver.name,
		capabilities: driver.capabilities,
		launch: () =>
			++seen > n
				? Promise.reject(new Error("Chromium is not installed"))
				: driver.launch(),
	};
}

/** Has this promise settled yet? */
async function isPending(promise: Promise<unknown>): Promise<boolean> {
	const marker = Symbol("pending");
	promise.catch(() => {});
	const first = await Promise.race([
		promise.then(() => "settled", () => "settled"),
		new Promise((r) => setTimeout(() => r(marker), 10)),
	]);
	return first === marker;
}

// ---------------------------------------------------------------------------
// shape
// ---------------------------------------------------------------------------

Deno.test("poolShapeFor maps the three strategies onto two numbers", () => {
	assertEquals(poolShapeFor("pooled"), {
		size: DEFAULT_POOL_SIZE,
		maxPagesPerContext: DEFAULT_MAX_PAGES_PER_CONTEXT,
	});
	assertEquals(poolShapeFor("pooled", { size: 8, maxPagesPerContext: 2 }), {
		size: 8,
		maxPagesPerContext: 2,
	});
	// one context forever
	assertEquals(poolShapeFor("shared", { size: 8 }), {
		size: 1,
		maxPagesPerContext: Infinity,
	});
	// a fresh context every time, but concurrency still capped
	assertEquals(poolShapeFor("per-request", { size: 4 }), {
		size: 4,
		maxPagesPerContext: 1,
	});
});

Deno.test("createContextPool refuses a size below one", () => {
	assertThrows(
		() => createContextPool({ driver: fakeDriver(), size: 0 }),
		TypeError,
		"`size` must be >= 1",
	);
});

// ---------------------------------------------------------------------------
// the happy path
// ---------------------------------------------------------------------------

Deno.test("pool: launches lazily and only once, however many acquires race", async () => {
	const { pool, driver } = poolOver({ size: 3 });
	assertEquals(driver.stats.launches, 0);

	const leases = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()]);
	assertEquals(driver.stats.launches, 1);
	assertEquals(driver.stats.contexts, 3);
	assertEquals(pool.stats.busy, 3);
	assertEquals(pool.stats.idle, 0);

	for (const lease of leases) lease.release();
	assertEquals(pool.stats.idle, 3);
	assertEquals(pool.stats.busy, 0);
	await pool.dispose();
});

Deno.test("pool: a released context is reused, not recreated", async () => {
	const { pool, driver } = poolOver({ size: 2 });
	const first = await pool.acquire();
	first.release();
	const second = await pool.acquire();
	assertEquals(second.context, first.context);
	assertEquals(driver.stats.contexts, 1);
	second.release();
	await pool.dispose();
});

Deno.test("pool: a context is recycled after maxPagesPerContext pages", async () => {
	const { pool, driver } = poolOver({ size: 1, maxPagesPerContext: 2 });
	for (let i = 0; i < 3; i++) (await pool.acquire()).release();
	// two pages served on the first context, then a replacement
	assertEquals(driver.stats.contexts, 2);
	assertEquals(driver.stats.closedContexts, 1);
	await pool.dispose();
});

Deno.test('pool: "per-request" recycles every time', async () => {
	const { pool, driver } = poolOver({ ...poolShapeFor("per-request", { size: 2 }) });
	for (let i = 0; i < 3; i++) (await pool.acquire()).release();
	assertEquals(driver.stats.contexts, 3);
	await pool.dispose();
});

Deno.test("pool: a broken context is dropped and replaced on demand", async () => {
	const { pool, driver } = poolOver({ size: 1 });
	const lease = await pool.acquire();
	lease.release({ broken: true });
	assertEquals(pool.stats.size, 0);
	assertEquals(driver.stats.closedContexts, 1);

	const next = await pool.acquire();
	assertEquals(driver.stats.contexts, 2);
	next.release();
	await pool.dispose();
});

Deno.test("pool: releasing twice does not double-count the slot", async () => {
	const { pool } = poolOver({ size: 2 });
	const lease = await pool.acquire();
	lease.release();
	lease.release();
	assertEquals(pool.stats.idle, 1);
	assertEquals(pool.stats.size, 1);
	await pool.dispose();
});

Deno.test("pool: beyond size, callers queue and are served on release", async () => {
	const { pool, driver } = poolOver({ size: 1 });
	const held = await pool.acquire();
	const queued = pool.acquire();
	assert(await isPending(queued), "the second acquire must wait");
	assertEquals(pool.stats.waiting, 1);

	held.release();
	const served = await queued;
	assertEquals(served.context, held.context);
	assertEquals(driver.stats.contexts, 1);
	assertEquals(pool.stats.waiting, 0);
	served.release();
	await pool.dispose();
});

Deno.test("pool: waiters are served in order", async () => {
	const { pool } = poolOver({ size: 1 });
	const held = await pool.acquire();
	const order: number[] = [];
	const queued = [1, 2, 3].map((n) =>
		pool.acquire().then((lease) => {
			order.push(n);
			return lease;
		})
	);
	held.release();
	for (const promise of queued) (await promise).release();
	assertEquals(order, [1, 2, 3]);
	await pool.dispose();
});

// ---------------------------------------------------------------------------
// never wedge
// ---------------------------------------------------------------------------

Deno.test("never wedge (a): a waiter gives up after acquireTimeout", async () => {
	const { pool } = poolOver({ size: 1, acquireTimeout: 20 });
	const held = await pool.acquire();
	const error = await assertRejects(() => pool.acquire(), Error);
	assert(error.message.includes("Timed out"), error.message);
	assertEquals(pool.stats.waiting, 0);
	held.release();
	await pool.dispose();
});

Deno.test("never wedge (b): a waiter's signal rejects it with its own reason", async () => {
	const { pool } = poolOver({ size: 1 });
	const held = await pool.acquire();
	const controller = new AbortController();
	const queued = pool.acquire(controller.signal);
	assert(await isPending(queued));

	const reason = new Error("the caller changed their mind");
	controller.abort(reason);
	assertEquals(await queued.catch((e) => e), reason);
	assertEquals(pool.stats.waiting, 0);
	held.release();
	await pool.dispose();
});

Deno.test("never wedge (b'): an already-aborted signal never queues at all", async () => {
	const { pool, driver } = poolOver({ size: 1 });
	const error = await assertRejects(
		() => pool.acquire(AbortSignal.abort(new Error("gone"))),
		Error,
	);
	assertEquals(error.message, "gone");
	assertEquals(driver.stats.launches, 0);
	await pool.dispose();
});

Deno.test("never wedge (c): dispose rejects every queued waiter", async () => {
	const { pool } = poolOver({ size: 1 });
	await pool.acquire();
	const queued = [pool.acquire(), pool.acquire()];
	assert(await isPending(queued[0]));

	await pool.dispose();
	for (const promise of queued) {
		const error = await assertRejects(() => promise, DOMException);
		assertEquals(error.name, "AbortError");
	}
	// and nothing new gets in
	await assertRejects(() => pool.acquire(), DOMException);
});

Deno.test("never wedge (d): a failed relaunch fails the waiters, retryably", async () => {
	const fake = fakeDriver();
	const { pool } = poolOver({ size: 1, driver: launchesOnce(fake, 1) as FakeDriver });
	const held = await pool.acquire();
	const queued = pool.acquire();
	assert(await isPending(queued));

	fake.crashAll();
	const error = await assertRejects(() => queued, Error);
	assert(error.message.includes("Chromium is not installed"), error.message);
	// the crash itself did not reject it — the failed relaunch did
	assertEquals(pool.stats.waiting, 0);
	held.release();
	await pool.dispose();
});

// ---------------------------------------------------------------------------
// crash recovery
// ---------------------------------------------------------------------------

Deno.test("crash: the epoch bumps and stale leases release into nothing", async () => {
	const { pool, driver } = poolOver({ size: 2 });
	const stale = await pool.acquire();
	assertEquals(stale.epoch, 0);
	assertEquals(pool.stats.epoch, 0);

	driver.crashAll();
	assertEquals(pool.stats.epoch, 1);
	assertEquals(pool.stats.size, 0);

	// the in-flight fetch that still holds it finishes and gives it back — into nothing
	stale.release();
	assertEquals(pool.stats.idle, 0);

	const fresh = await pool.acquire();
	assertEquals(fresh.epoch, 1);
	assertEquals(driver.stats.launches, 2);
	assert(fresh.context !== stale.context);
	fresh.release();
	assertEquals(pool.stats.idle, 1);
	await pool.dispose();
});

Deno.test("crash: queued waiters are relaunched into, not rejected", async () => {
	const { pool, driver } = poolOver({ size: 1 });
	const held = await pool.acquire();
	const queued = pool.acquire();
	assert(await isPending(queued));

	driver.crashAll();
	const served = await queued;
	assertEquals(served.epoch, 1);
	assertEquals(driver.stats.launches, 2);
	// the old lease is inert, so releasing it cannot corrupt the new generation
	held.release();
	assertEquals(pool.stats.busy, 1);
	served.release();
	assertEquals(pool.stats.idle, 1);
	await pool.dispose();
});

Deno.test("crash: a lease whose browser died mid-use never re-enters the pool", async () => {
	const driver = fakeDriver({ crashAfterPages: 0 });
	const { pool } = poolOver({ size: 1, driver });
	const lease = await pool.acquire();
	// this fake kills its browser the moment a page is opened — exactly what a crash
	// in the middle of somebody's fetch looks like from here
	await lease.context.newPage();
	assertEquals(pool.stats.epoch, 1);

	lease.release();
	assertEquals(pool.stats.idle, 0);
	assertEquals(pool.stats.size, 0);
	await pool.dispose();
});

// ---------------------------------------------------------------------------
// dedicated contexts + teardown
// ---------------------------------------------------------------------------

Deno.test("pool: per-request options get a one-off context, closed on release", async () => {
	const { pool, driver } = poolOver({ size: 1 });
	const pooled = await pool.acquire();
	const dedicated = await pool.acquire(undefined, { userAgent: "custom" });
	assertEquals(driver.contextOptions[1], { userAgent: "custom" });
	assertEquals(pool.stats.dedicated, 1);
	// it does not consume a pool slot
	assertEquals(pool.stats.size, 1);

	dedicated.release();
	assertEquals(pool.stats.dedicated, 0);
	assertEquals(driver.stats.closedContexts, 1);
	pooled.release();
	await pool.dispose();
});

Deno.test("pool: dispose closes contexts and the browser, and is idempotent", async () => {
	const { pool, driver } = poolOver({ size: 2 });
	const first = await pool.acquire();
	const second = await pool.acquire();
	first.release();
	const outstanding = await pool.acquire(undefined, { locale: "sk" });

	await Promise.all([pool.dispose(), pool.dispose()]);
	await pool.dispose();
	// idle, busy and dedicated alike
	assertEquals(driver.stats.closedContexts, 3);
	assertEquals(driver.stats.closedBrowsers, 1);
	second.release();
	outstanding.release();
});

Deno.test("pool: dispose while a launch is in flight still closes that browser", async () => {
	const { pool, driver } = poolOver({ size: 1 }, { launchDelay: 10 });
	const acquiring = pool.acquire();
	acquiring.catch(() => {});
	await pool.dispose();
	assertEquals(driver.stats.launches, 1);
	assertEquals(driver.stats.closedBrowsers, 1);
});

Deno.test("pool: the exit hook is registered and unregistered with the pool", async () => {
	// the real host is used here on purpose: a leaked signal listener would show up as
	// a leaking op in this very test
	const { pool } = poolOver({ size: 1, exitHooks: undefined });
	(await pool.acquire()).release();
	await pool.dispose();
});

Deno.test("pool: logs the launch, the recycle and the crash", async () => {
	const logger = recordingLogger();
	const { pool, driver } = poolOver({ size: 1, maxPagesPerContext: 1, logger });
	(await pool.acquire()).release();
	(await pool.acquire()).release();
	driver.crashAll();
	await pool.dispose();

	const all = logger.messages().join("\n");
	assert(all.includes("launching"), all);
	assert(all.includes("recycling"), all);
	assert(all.includes("died"), all);
});

// ---------------------------------------------------------------------------
// exit hook
// ---------------------------------------------------------------------------

/** A host that records instead of touching the process. */
function fakeHost(events: ExitEvent[], failOn?: ExitEvent) {
	const handlers = new Map<ExitEvent, () => void>();
	const raised: { signal: string; code: number }[] = [];
	const host: ExitHookHost = {
		name: "fake",
		events,
		on(event, handler): void {
			if (event === failOn) throw new Error(`${event} is not supported here`);
			handlers.set(event, handler);
		},
		off: (event) => void handlers.delete(event),
		reraise: (signal, code) => void raised.push({ signal, code }),
	};
	return { host, handlers, raised };
}

Deno.test("exit hook: attaches to every event the host offers, and detaches them all", () => {
	const { host, handlers } = fakeHost(["SIGINT", "SIGTERM", "exit"]);
	const unregister = registerExitHook(() => {}, host);
	assertEquals([...handlers.keys()], ["SIGINT", "SIGTERM", "exit"]);
	unregister();
	assertEquals(handlers.size, 0);
});

Deno.test("exit hook: a signal runs the hook, detaches, then re-raises", () => {
	let ran = 0;
	const { host, handlers, raised } = fakeHost(["SIGINT", "SIGTERM", "exit"]);
	registerExitHook(() => ran++, host);

	handlers.get("SIGINT")!();
	assertEquals(ran, 1);
	// detached before re-raising, or the re-raise would land back on us
	assertEquals(handlers.size, 0);
	assertEquals(raised, [{ signal: "SIGINT", code: 130 }]);
});

Deno.test("exit hook: SIGTERM re-raises with its own conventional code", () => {
	const { host, handlers, raised } = fakeHost(["SIGTERM"]);
	registerExitHook(() => {}, host);
	handlers.get("SIGTERM")!();
	assertEquals(raised, [{ signal: "SIGTERM", code: 143 }]);
});

Deno.test("exit hook: exit/unload run the hook without re-raising", () => {
	let ran = 0;
	const { host, handlers, raised } = fakeHost(["exit", "unload"]);
	registerExitHook(() => ran++, host);
	handlers.get("exit")!();
	handlers.get("unload")!();
	// at most once, however many events fire
	assertEquals(ran, 1);
	assertEquals(raised, []);
});

Deno.test("exit hook: a throwing hook never breaks the exit path", () => {
	const { host, handlers, raised } = fakeHost(["SIGINT"]);
	registerExitHook(() => {
		throw new Error("close failed");
	}, host);
	handlers.get("SIGINT")!();
	assertEquals(raised, [{ signal: "SIGINT", code: 130 }]);
});

Deno.test("exit hook: an unsupported event does not cost us the others", () => {
	const { host, handlers } = fakeHost(["SIGINT", "SIGTERM"], "SIGTERM");
	const unregister = registerExitHook(() => {}, host);
	assertEquals([...handlers.keys()], ["SIGINT"]);
	unregister();
});

Deno.test("exit hook: no host at all is a no-op, not a crash", () => {
	const unregister = registerExitHook(() => {}, undefined);
	unregister();
});

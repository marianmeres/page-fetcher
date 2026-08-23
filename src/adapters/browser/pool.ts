/**
 * The context pool: N browsing contexts over one browser process, with recycling and
 * crash recovery.
 *
 * Launching a browser costs 1–3 seconds; creating a context costs milliseconds and
 * still gives full isolation (its own cookie jar, cache and storage). So the pool
 * launches **one** browser lazily and hands out contexts from it. Contexts are recycled
 * after a bounded number of pages, because a long-lived one accumulates memory in the
 * browser process.
 *
 * The hard part is not the happy path, it is the crash. The invariant this module is
 * built around, and the one its tests pin:
 *
 * > **No waiter promise stays pending** — not after its timeout, not after its signal,
 * > not after `dispose()`, and not after a failed relaunch.
 *
 * A dead browser bumps an **epoch**. Everything from the old generation becomes inert:
 * leases still held by in-flight fetches release into nothing (their epoch no longer
 * matches), so a context belonging to a dead process can never re-enter the live pool.
 * Waiters are *not* rejected by the crash itself — they are woken to re-try, which
 * relaunches the browser. Only if that relaunch fails do they fail, with a retryable
 * error, so the layer above backs off and a permanently broken environment surfaces as
 * failing fetches rather than a hung process.
 *
 * @module
 */

import type { Logger } from "../../types.ts";
import type {
	BrowserDriver,
	DriverBrowser,
	DriverContext,
	DriverContextOptions,
} from "./driver.ts";
import { killProcess, registerExitHook } from "./exit-hook.ts";

/** A borrowed browsing context. */
export interface ContextLease {
	/** The context to open pages on. */
	context: DriverContext;
	/**
	 * Give it back. `broken: true` means the context may be compromised (its page
	 * crashed, its browser died) and must not be handed to anyone else.
	 */
	release(opts?: { broken?: boolean }): void;
}

/**
 * Where the browser adapter gets its contexts.
 *
 * The seam exists so the adapter never knows whether it is talking to a real pool or to
 * a test double.
 */
export interface ContextProvider {
	/**
	 * Borrow a context. `contextOptions`, when given, asks for a **dedicated** context
	 * created with exactly those options — a request whose headers differ cannot ride
	 * along on a shared one.
	 */
	acquire(
		signal?: AbortSignal,
		contextOptions?: DriverContextOptions,
	): Promise<ContextLease>;
	/** Close everything. Idempotent. */
	dispose(): Promise<void>;
}

/** Default number of pooled contexts. */
export const DEFAULT_POOL_SIZE = 3;

/** Default number of pages a context serves before it is recycled. */
export const DEFAULT_MAX_PAGES_PER_CONTEXT = 50;

/** Default wait for a free context. */
export const DEFAULT_ACQUIRE_TIMEOUT = 30_000;

/**
 * How contexts are shared between requests.
 *
 * - `"pooled"` — up to `size` contexts, each recycled after `maxPagesPerContext`
 *   pages. The default, and the right answer for a crawler.
 * - `"shared"` — one context for everything, never recycled. Cheapest, and the only
 *   mode where cookies set by one page are visible to the next.
 * - `"per-request"` — a fresh context per request, still capped at `size` concurrent
 *   ones. Maximum isolation; an uncapped variant would be a footgun, not a feature.
 */
export type ContextStrategy = "pooled" | "shared" | "per-request";

/** Options of {@linkcode createContextPool}. */
export interface PoolOptions {
	/** The injected driver. */
	driver: BrowserDriver;
	/** Concurrent contexts. Default {@linkcode DEFAULT_POOL_SIZE}. */
	size?: number;
	/**
	 * Pages a context serves before being replaced. Default
	 * {@linkcode DEFAULT_MAX_PAGES_PER_CONTEXT}; `Infinity` never recycles.
	 */
	maxPagesPerContext?: number;
	/** How long an acquire waits for a free context. Default {@linkcode DEFAULT_ACQUIRE_TIMEOUT}. */
	acquireTimeout?: number;
	/** Options every pooled context is created with. */
	contextOptions?: DriverContextOptions;
	/** Register a process-exit hook that tears the browser down. Default `true`. */
	exitHooks?: boolean;
	/** Silent by default. */
	logger?: Logger;
}

/** A pooled context, plus the generation it belongs to. */
export interface PoolLease extends ContextLease {
	/** Pool generation. A lease from a dead generation releases into nothing. */
	epoch: number;
}

/** Live pool counters — for tests, and for a crawler's introspection. */
export interface PoolStats {
	/** Contexts that exist right now (idle + busy). */
	size: number;
	/** Contexts available immediately. */
	idle: number;
	/** Contexts currently leased out. */
	busy: number;
	/** Callers queued for a context. */
	waiting: number;
	/** Current generation; increments on every browser crash. */
	epoch: number;
	/** Browsers launched, including relaunches after a crash. */
	launches: number;
	/** One-off contexts currently out for per-request options. */
	dedicated: number;
}

/** What {@linkcode createContextPool} returns. */
export interface ContextPool extends ContextProvider {
	/**
	 * Lease a context, waiting for a free slot when the pool is saturated.
	 *
	 * Passing `contextOptions` asks for a **dedicated** one-off context, created and
	 * closed with this lease and accounted outside the pool's size (see the module note
	 * on why per-request options cannot share a pooled context).
	 *
	 * @param signal Cancels the wait. The returned promise never stays pending past an
	 * abort, an acquire timeout, `dispose()`, or a failed relaunch.
	 * @param contextOptions Context-affecting options for a dedicated context.
	 */
	acquire(
		signal?: AbortSignal,
		contextOptions?: DriverContextOptions,
	): Promise<PoolLease>;
	/** Live counters. */
	readonly stats: PoolStats;
}

/** One pooled context and its bookkeeping. */
interface Slot {
	context: DriverContext;
	pagesServed: number;
	epoch: number;
}

/** A queued acquire, waiting for the pool state to change. */
interface Waiter {
	resolve(): void;
	reject(error: unknown): void;
}

/** Turn a strategy into the two numbers that actually implement it. */
export function poolShapeFor(
	strategy: ContextStrategy,
	opts: { size?: number; maxPagesPerContext?: number } = {},
): { size: number; maxPagesPerContext: number } {
	const size = opts.size ?? DEFAULT_POOL_SIZE;
	switch (strategy) {
		case "shared":
			return { size: 1, maxPagesPerContext: Infinity };
		case "per-request":
			return { size, maxPagesPerContext: 1 };
		default:
			return {
				size,
				maxPagesPerContext: opts.maxPagesPerContext ??
					DEFAULT_MAX_PAGES_PER_CONTEXT,
			};
	}
}

/** The rejection every "we are shutting down" path uses — maps to `kind: "aborted"`. */
function disposedError(): DOMException {
	return new DOMException("Browser context pool is disposed", "AbortError");
}

/**
 * Create the pool.
 *
 * @example
 * ```ts
 * import { createContextPool } from "@marianmeres/page-fetcher/adapters";
 * import type { BrowserDriver } from "@marianmeres/page-fetcher/adapters";
 *
 * declare const driver: BrowserDriver;
 *
 * const pool = createContextPool({ driver, size: 3, maxPagesPerContext: 50 });
 * const lease = await pool.acquire();
 * try {
 * 	const page = await lease.context.newPage();
 * 	await page.close();
 * } finally {
 * 	lease.release();
 * }
 * await pool.dispose();
 * ```
 */
export function createContextPool(options: PoolOptions): ContextPool {
	const {
		driver,
		size = DEFAULT_POOL_SIZE,
		maxPagesPerContext = DEFAULT_MAX_PAGES_PER_CONTEXT,
		acquireTimeout = DEFAULT_ACQUIRE_TIMEOUT,
		contextOptions,
		exitHooks = true,
		logger,
	} = options;

	if (!(size >= 1)) throw new TypeError("createContextPool: `size` must be >= 1");

	const idle: Slot[] = [];
	const busy = new Set<Slot>();
	const dedicated = new Set<DriverContext>();
	const waiters: Waiter[] = [];

	let epoch = 0;
	let launches = 0;
	/** Contexts being created right now — counted so concurrency cannot overshoot `size`. */
	let pending = 0;
	let browser: DriverBrowser | undefined;
	let launching: Promise<DriverBrowser> | undefined;
	let unregisterExit: (() => void) | undefined;
	let disposed = false;

	// ---- waiters -------------------------------------------------------------

	/** Wake the next waiter (or everyone, after a state change that affects all). */
	function notify(all = false): void {
		if (!all) {
			waiters.shift()?.resolve();
			return;
		}
		for (const waiter of waiters.splice(0)) waiter.resolve();
	}

	/** Fail every queued caller — used only when the pool itself cannot go on. */
	function rejectAll(error: unknown): void {
		for (const waiter of waiters.splice(0)) waiter.reject(error);
	}

	/**
	 * Wait for the pool state to change.
	 *
	 * `front` re-queues a caller that was already woken once, so a caller that loses a
	 * race for the slot it was woken for does not drift to the back of the queue behind
	 * arrivals that showed up after it.
	 */
	function waitForTurn(
		signal: AbortSignal | undefined,
		ms: number,
		front: boolean,
	): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (done: () => void): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				const at = waiters.indexOf(waiter);
				if (at >= 0) waiters.splice(at, 1);
				done();
			};
			const waiter: Waiter = {
				resolve: () => finish(resolve),
				reject: (error) => finish(() => reject(error)),
			};
			const timer = setTimeout(
				() =>
					waiter.reject(
						new Error(
							`Timed out after ${acquireTimeout} ms waiting for a ` +
								`browser context (pool size ${size})`,
						),
					),
				Math.max(0, ms),
			);
			const onAbort = (): void =>
				waiter.reject(
					signal?.reason ?? new DOMException("Aborted", "AbortError"),
				);

			if (signal?.aborted) return onAbort();
			signal?.addEventListener("abort", onAbort, { once: true });
			if (front) waiters.unshift(waiter);
			else waiters.push(waiter);
		});
	}

	// ---- browser lifecycle ---------------------------------------------------

	/** Everything from the dead generation is inert; nothing of it may come back. */
	function onDisconnected(dead: DriverBrowser): void {
		if (browser !== dead) return;
		logger?.warn(
			`[pool] ${driver.name} browser died — starting generation ${epoch + 1}`,
		);
		epoch++;
		idle.length = 0;
		busy.clear();
		dedicated.clear();
		browser = undefined;
		launching = undefined;
		// deliberately NOT rejecting waiters: they are woken to try again, which
		// relaunches. Only a failed relaunch fails them.
		notify(true);
	}

	function ensureBrowser(): Promise<DriverBrowser> {
		return (launching ??= (async () => {
			logger?.debug(`[pool] launching ${driver.name}`);
			const launched = await driver.launch();
			launches++;
			browser = launched;
			launched.onDisconnected(() => onDisconnected(launched));
			if (exitHooks && !unregisterExit) {
				unregisterExit = registerExitHook(killBrowser);
			}
			return launched;
		})().catch((error: unknown) => {
			// never memoize a failed launch as the answer
			launching = undefined;
			logger?.error(`[pool] launch failed: ${error}`);
			throw error;
		}));
	}

	/** Synchronous best effort, for the exit hook: nothing can be awaited at exit. */
	function killBrowser(): void {
		const live = browser;
		if (!live) return;
		logger?.debug("[pool] exit hook: tearing the browser down");
		if (!killProcess(live.pid)) void live.close().catch(() => {});
	}

	// ---- slots ---------------------------------------------------------------

	async function createSlot(): Promise<Slot> {
		const live = await ensureBrowser();
		const context = await live.newContext(contextOptions ?? {});
		// read the epoch AFTER the awaits: the browser may have died meanwhile
		return { context, pagesServed: 0, epoch };
	}

	/** Replace a worn-out context in place. */
	async function recycle(slot: Slot): Promise<Slot> {
		logger?.debug(`[pool] recycling a context after ${slot.pagesServed} pages`);
		await slot.context.close().catch(() => {});
		const live = await ensureBrowser();
		slot.context = await live.newContext(contextOptions ?? {});
		slot.pagesServed = 0;
		slot.epoch = epoch;
		return slot;
	}

	function leaseFor(slot: Slot): PoolLease {
		const leaseEpoch = slot.epoch;
		let released = false;
		return {
			context: slot.context,
			epoch: leaseEpoch,
			release: (opts): void => {
				if (released) return;
				released = true;
				// a lease from a dead generation has nothing to give back
				if (leaseEpoch !== epoch || !busy.delete(slot)) return;
				slot.pagesServed++;
				if (opts?.broken || disposed) {
					logger?.debug("[pool] dropping a context returned as broken");
					void slot.context.close().catch(() => {});
				} else {
					idle.push(slot);
				}
				notify();
			},
		};
	}

	// ---- acquire -------------------------------------------------------------

	async function acquireDedicated(
		requestOptions: DriverContextOptions,
	): Promise<PoolLease> {
		const live = await ensureBrowser();
		const context = await live.newContext(requestOptions);
		dedicated.add(context);
		const leaseEpoch = epoch;
		let released = false;
		return {
			context,
			epoch: leaseEpoch,
			release: (): void => {
				if (released) return;
				released = true;
				dedicated.delete(context);
				void context.close().catch(() => {});
			},
		};
	}

	async function acquire(
		signal?: AbortSignal,
		requestOptions?: DriverContextOptions,
	): Promise<PoolLease> {
		if (disposed) throw disposedError();
		if (signal?.aborted) {
			throw signal.reason ?? new DOMException("Aborted", "AbortError");
		}
		// per-request context options cannot ride along on a shared context; those get
		// their own, outside the pool and closed with the request
		if (requestOptions) return await acquireDedicated(requestOptions);

		const until = Date.now() + acquireTimeout;
		let queued = false;

		for (;;) {
			if (disposed) throw disposedError();
			if (signal?.aborted) {
				throw signal.reason ?? new DOMException("Aborted", "AbortError");
			}

			// fresh arrivals never jump an existing queue
			if (queued || !waiters.length) {
				const slot = idle.pop();
				if (slot) {
					busy.add(slot);
					try {
						const ready = slot.pagesServed >= maxPagesPerContext
							? await recycle(slot)
							: slot;
						if (ready.epoch !== epoch) {
							// the browser died while we were recycling
							busy.delete(ready);
							continue;
						}
						return leaseFor(ready);
					} catch (error) {
						busy.delete(slot);
						notify();
						throw error;
					}
				}

				if (idle.length + busy.size + pending < size) {
					pending++;
					try {
						const created = await createSlot();
						if (created.epoch !== epoch) continue;
						busy.add(created);
						return leaseFor(created);
					} catch (error) {
						// a relaunch that cannot succeed must fail the callers, not
						// leave them queued forever
						notify();
						throw error;
					} finally {
						pending--;
					}
				}
			}

			await waitForTurn(signal, until - Date.now(), queued);
			queued = true;
		}
	}

	// ---- teardown ------------------------------------------------------------

	let disposal: Promise<void> | undefined;

	async function runDispose(): Promise<void> {
		logger?.debug("[pool] disposing");
		unregisterExit?.();
		unregisterExit = undefined;
		rejectAll(disposedError());
		// let a launch in flight land, or we leak the browser it is about to produce
		await Promise.allSettled([launching]);
		const contexts = [...idle, ...busy].map((slot) => slot.context);
		idle.length = 0;
		busy.clear();
		await Promise.allSettled(
			[...contexts, ...dedicated].map((context) => context.close()),
		);
		dedicated.clear();
		await browser?.close().catch(() => {});
		browser = undefined;
		launching = undefined;
	}

	return {
		acquire,
		dispose(): Promise<void> {
			disposed = true;
			// memoized, not just flagged: a second caller must await real completion
			return (disposal ??= runDispose());
		},
		get stats(): PoolStats {
			return {
				size: idle.length + busy.size,
				idle: idle.length,
				busy: busy.size,
				waiting: waiters.length,
				epoch,
				launches,
				dedicated: dedicated.size,
			};
		},
	};
}

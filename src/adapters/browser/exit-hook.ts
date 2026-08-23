/**
 * A cross-runtime process-exit hook — the second line of defense against orphaned
 * browser processes, which are the number one operational complaint about any tool that
 * drives one.
 *
 * Second line, not first: both Playwright and Puppeteer install their own
 * SIGINT/SIGTERM/SIGHUP handlers by default. This hook is what covers the paths they do
 * not — plain `exit`/`unload`, a driver launched with `handleSIGINT: false`, and custom
 * drivers — so it is deliberately small and completely optional.
 *
 * Everything is feature-detected at call time and nothing is touched at module load, so
 * importing this module is safe on any runtime, with any permission set.
 *
 * @module
 */

/** Process events this hook can attach to. */
export type ExitEvent = "SIGINT" | "SIGTERM" | "exit" | "unload";

/**
 * The slice of a host runtime the hook needs.
 *
 * A seam, not an abstraction for its own sake: it is what lets the unit tests assert the
 * register/unregister/re-raise protocol without ever sending a real signal.
 */
export interface ExitHookHost {
	/** `"deno"`, `"node"`, or whatever a test calls itself. */
	readonly name: string;
	/** Events this host can actually deliver, in registration order. */
	readonly events: readonly ExitEvent[];
	/** Attach a handler. */
	on(event: ExitEvent, handler: () => void): void;
	/** Detach a handler. */
	off(event: ExitEvent, handler: () => void): void;
	/**
	 * Terminate as the signal would have, now that our handler has run and detached.
	 *
	 * Re-raising the real signal is the ideal — it preserves other handlers and the
	 * conventional exit code — but it is not always permitted, hence the `code`
	 * fallback (128 + signal number).
	 */
	reraise(signal: "SIGINT" | "SIGTERM", code: number): void;
}

/** Exit code convention: 128 + signal number. */
const EXIT_CODE: Record<"SIGINT" | "SIGTERM", number> = { SIGINT: 130, SIGTERM: 143 };

/** Minimal shape of `Deno`, probed rather than imported. */
interface DenoLike {
	addSignalListener?(signal: string, handler: () => void): void;
	removeSignalListener?(signal: string, handler: () => void): void;
	kill?(pid: number, signal?: string): void;
	exit?(code?: number): never;
	pid?: number;
	build?: { os?: string };
}

/** Minimal shape of Node's `process`, probed rather than imported. */
interface ProcessLike {
	on?(event: string, handler: () => void): unknown;
	off?(event: string, handler: () => void): unknown;
	removeListener?(event: string, handler: () => void): unknown;
	kill?(pid: number, signal?: string): unknown;
	exit?(code?: number): never;
	pid?: number;
	platform?: string;
}

/** Deno first: under Deno the `node:process` shim also exists, and the native API is better. */
function denoHost(): ExitHookHost | undefined {
	const deno = (globalThis as { Deno?: DenoLike }).Deno;
	if (typeof deno?.addSignalListener !== "function") return undefined;

	// a SIGTERM listener throws on Windows; `unload` is the portable last resort
	const events: ExitEvent[] = deno.build?.os === "windows"
		? ["SIGINT", "unload"]
		: ["SIGINT", "SIGTERM", "unload"];

	return {
		name: "deno",
		events,
		on(event, handler): void {
			if (event === "unload") globalThis.addEventListener(event, handler);
			else deno.addSignalListener!(event, handler);
		},
		off(event, handler): void {
			if (event === "unload") globalThis.removeEventListener(event, handler);
			else deno.removeSignalListener?.(event, handler);
		},
		reraise(signal, code): void {
			try {
				// the faithful path — but `Deno.kill` needs --allow-run, and a
				// transport library has no business demanding that
				deno.kill!(deno.pid!, signal);
			} catch {
				deno.exit?.(code);
			}
		},
	};
}

/** Node/Bun. */
function nodeHost(): ExitHookHost | undefined {
	const process = (globalThis as { process?: ProcessLike }).process;
	if (typeof process?.on !== "function") return undefined;

	const events: ExitEvent[] = process.platform === "win32"
		? ["SIGINT", "exit"]
		: ["SIGINT", "SIGTERM", "exit"];

	return {
		name: "node",
		events,
		on: (event, handler) => void process.on!(event, handler),
		off: (event, handler) =>
			void (process.off ?? process.removeListener)?.call(process, event, handler),
		reraise(signal, code): void {
			try {
				process.kill!(process.pid!, signal);
			} catch {
				process.exit?.(code);
			}
		},
	};
}

/** Probe the current runtime. Returns `undefined` where no hook can be installed. */
export function detectExitHookHost(): ExitHookHost | undefined {
	try {
		return denoHost() ?? nodeHost();
	} catch {
		return undefined;
	}
}

/**
 * Run `fn` when the process is going away. Returns the unregister function.
 *
 * `fn` must be **synchronous**: `exit` and `unload` cannot await anything, so the best
 * a caller can do is fire off a close and, where a pid is known, kill the child
 * outright. It runs at most once, however many of the hooked events fire.
 *
 * On a signal the protocol is: run `fn`, unregister, then re-raise the signal — so
 * other handlers still see it and the process still dies with the conventional code.
 * Skipping the re-raise would be a bug, not an optimization: installing a SIGINT
 * listener suppresses default termination on both runtimes, so Ctrl-C would stop
 * working.
 *
 * Never throws, and no-ops where no host is detectable.
 *
 * @example
 * ```ts
 * const unregister = registerExitHook(() => void browser.close().catch(() => {}));
 * // …later
 * unregister();
 * ```
 */
export function registerExitHook(
	fn: () => void,
	host: ExitHookHost | undefined = detectExitHookHost(),
): () => void {
	if (!host) return () => {};

	const attached = new Map<ExitEvent, () => void>();
	let ran = false;

	const unregister = (): void => {
		for (const [event, handler] of attached) {
			try {
				host.off(event, handler);
			} catch { /* going away anyway */ }
		}
		attached.clear();
	};

	const run = (): void => {
		if (ran) return;
		ran = true;
		try {
			fn();
		} catch { /* a cleanup hook must never be the reason a process fails to exit */ }
	};

	for (const event of host.events) {
		const handler = event === "SIGINT" || event === "SIGTERM"
			? (): void => {
				run();
				unregister();
				host.reraise(event, EXIT_CODE[event]);
			}
			: run;
		try {
			host.on(event, handler);
			attached.set(event, handler);
		} catch { /* this runtime cannot deliver that one; the others still stand */ }
	}

	return unregister;
}

/**
 * Kill a process by pid, best effort.
 *
 * Only Puppeteer exposes the browser's child process (`DriverBrowser.pid`), and only a
 * pid makes a *synchronous* kill possible at exit time — an async `close()` started from
 * an `exit` handler may never get a turn.
 */
export function killProcess(pid: number | undefined): boolean {
	if (!pid) return false;
	const deno = (globalThis as { Deno?: DenoLike }).Deno;
	const process = (globalThis as { process?: ProcessLike }).process;
	try {
		if (typeof deno?.kill === "function") deno.kill(pid, "SIGKILL");
		else if (typeof process?.kill === "function") process.kill(pid, "SIGKILL");
		else return false;
		return true;
	} catch {
		return false;
	}
}

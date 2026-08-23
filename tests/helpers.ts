/**
 * Test helpers shared by unit and integration test files.
 *
 * Deliberately free of any fixture-server import: unit files (retry, breaker, guards)
 * must stay socket-free so a failure bisects instantly to "logic vs I/O".
 */

import type { FakeTime } from "@std/testing/time";
import { PageFetchError, type PageFetchErrorInit } from "../src/errors.ts";
import { createBodyResult } from "../src/internal.ts";
import type { FetchFn, FetchRequest, FetchResult, Logger } from "../src/types.ts";

const enc = (s: string) => new TextEncoder().encode(s);

/** Everything {@linkcode makeResult} lets a test override. */
export interface MakeResultInit
	extends Partial<Omit<FetchResult, "text" | "bytes" | "headers" | "hasBody">> {
	headers?: HeadersInit;
	/** Body bytes; `null` produces a result whose body accessors reject. */
	body?: string | Uint8Array | null;
}

/** Build a complete {@linkcode FetchResult} without touching the network. */
export function makeResult(init: MakeResultInit = {}): FetchResult {
	const url = init.url ?? "http://stub.test/";
	const status = init.status ?? 200;
	const raw = init.body === undefined
		? enc("ok")
		: typeof init.body === "string"
		? enc(init.body)
		: init.body;
	const body = createBodyResult(raw, { url, charset: init.charset });
	const now = Date.now();
	return {
		ok: init.ok ?? (status >= 200 && status < 300),
		url,
		finalUrl: init.finalUrl ?? url,
		status,
		statusText: init.statusText,
		headers: new Headers(init.headers),
		redirects: init.redirects ?? [],
		requestId: init.requestId ?? "stub-request-id",
		hasBody: body.hasBody,
		text: body.text,
		bytes: body.bytes,
		contentType: init.contentType,
		charset: init.charset,
		size: raw?.length,
		fromCache: init.fromCache ?? false,
		notModified: init.notModified ?? false,
		timing: init.timing ?? { startedAt: now, endedAt: now, total: 0 },
		attempts: init.attempts ?? 1,
		adapter: init.adapter ?? "stub",
		meta: init.meta,
		extra: init.extra,
	};
}

/** Build a {@linkcode PageFetchError} with test-friendly defaults. */
export function makeError(init: Partial<PageFetchErrorInit> = {}): PageFetchError {
	return new PageFetchError({
		kind: "network",
		url: "http://stub.test/",
		...init,
	} as PageFetchErrorInit);
}

/** One scripted answer of a stub {@linkcode FetchFn}. */
export type StubStep =
	| FetchResult
	| Error
	| ((req: FetchRequest, attempt: number) => FetchResult | Promise<FetchResult>);

/** A stub `FetchFn` that also records the requests it received. */
export type StubFetch = FetchFn & {
	/** Every request this stub was called with, in order. */
	calls: FetchRequest[];
};

/**
 * A `FetchFn` that answers with `steps[n]` on the n-th call. Errors are thrown,
 * results are resolved, functions are invoked. When the script runs out, the last
 * step repeats.
 */
export function scriptedFetch(steps: StubStep[]): StubFetch {
	if (!steps.length) throw new TypeError("scriptedFetch needs at least one step");
	const calls: FetchRequest[] = [];
	const fn = async (req: FetchRequest): Promise<FetchResult> => {
		calls.push(req);
		const step = steps[Math.min(calls.length - 1, steps.length - 1)];
		if (step instanceof Error) throw step;
		if (typeof step === "function") return await step(req, calls.length);
		return step;
	};
	return Object.assign(fn, { calls });
}

/** Fails `n` times with `error`, then answers with `then` forever. */
export function failNTimes(
	n: number,
	then: FetchResult = makeResult(),
	error: Error = makeError(),
): StubFetch {
	return scriptedFetch([...Array(n).fill(error), then]);
}

/**
 * A `FetchFn` that never resolves on its own — it only settles when the request's
 * signal aborts, rejecting with that signal's reason (exactly what a real adapter does
 * when a timeout/deadline guard aborts it).
 */
export function neverResolves(): StubFetch {
	return scriptedFetch([
		(req: FetchRequest) =>
			new Promise<FetchResult>((_resolve, reject) => {
				const signal = req.signal;
				if (!signal) return; // hangs forever — the caller must pass a signal
				const onAbort = () =>
					reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}),
	]);
}

/** A `FetchFn` that answers after `ms` (fake-timer friendly), abortable. */
export function delayedFetch(ms: number, result: FetchResult = makeResult()): StubFetch {
	return scriptedFetch([
		(req: FetchRequest) =>
			new Promise<FetchResult>((resolve, reject) => {
				const timer = setTimeout(() => {
					req.signal?.removeEventListener("abort", onAbort);
					resolve(result);
				}, ms);
				function onAbort() {
					clearTimeout(timer);
					reject(
						req.signal?.reason ?? new DOMException("Aborted", "AbortError"),
					);
				}
				if (req.signal?.aborted) onAbort();
				else req.signal?.addEventListener("abort", onAbort, { once: true });
			}),
	]);
}

/** Log levels of the clog `Logger` interface. */
export type LogLevel = "debug" | "log" | "warn" | "error";

/** A `Logger` that records instead of printing. */
export interface RecordingLogger extends Logger {
	/** Everything logged, in order. */
	records: { level: LogLevel; args: unknown[] }[];
	/** First argument of every record (optionally of one level only), stringified. */
	messages(level?: LogLevel): string[];
}

/** Build a {@linkcode RecordingLogger}. */
export function recordingLogger(): RecordingLogger {
	const records: { level: LogLevel; args: unknown[] }[] = [];
	const at = (level: LogLevel) => (...args: unknown[]) => {
		records.push({ level, args });
		return args[0];
	};
	return {
		records,
		debug: at("debug"),
		log: at("log"),
		warn: at("warn"),
		error: at("error"),
		messages: (level?: LogLevel) =>
			records
				.filter((r) => !level || r.level === level)
				.map((r) => String(r.args[0])),
	};
}

/**
 * Run a pending promise to completion under `FakeTime`.
 *
 * Advances timer by timer (`nextAsync`) rather than jumping the clock: a big
 * `tickAsync` moves `Date.now()` to the far end *before* the callbacks run, which would
 * make every deadline under test look expired.
 */
export async function settleWithFakeTime<T>(
	time: FakeTime,
	promise: Promise<T>,
): Promise<T> {
	let done = false;
	const settled = promise.then(
		(v) => {
			done = true;
			return { v };
		},
		(e) => {
			done = true;
			return { e };
		},
	);
	for (let i = 0; i < 500 && !done; i++) {
		if (!(await time.nextAsync())) await time.tickAsync(0);
	}
	const out = await settled;
	if ("e" in out) throw out.e;
	return out.v as T;
}

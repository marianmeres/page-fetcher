/**
 * The example app's server: static files, a set of deliberately misbehaving demo
 * pages, and one endpoint that runs the library.
 *
 * Why a server at all — the library is transport code and would technically bundle for
 * the browser, but a browser cannot demo it honestly: cross-origin `fetch` is blocked
 * by CORS, and `redirect: "manual"` yields an *opaque* response there, so the redirect
 * chain this package records could never be observed. So the browser holds the controls
 * and the fetch itself runs here, where a real `fetch` behaves like a real `fetch`.
 *
 * Routes:
 *
 *   GET  /                     the app (example/index.html and its assets)
 *   POST /api/fetch            run one fetch with the posted options, return the
 *                              normalized result + the events the stack emitted
 *   POST /api/reset            drop cached responses, breaker state and demo counters
 *   ANY  /demo/*               the demo pages (redirect chains, flaky, slow, charsets…)
 *
 * ⚠️ Local demo only. `/api/fetch` fetches whatever URL it is handed — do not deploy
 * it anywhere reachable by anyone else.
 *
 * Run with: `deno task example` (then open http://127.0.0.1:8000).
 */

import { createFetcher, type Fetcher, PageFetchError } from "@marianmeres/page-fetcher";
import { createHttpAdapter } from "@marianmeres/page-fetcher/adapters";
import { createMemoryCache } from "@marianmeres/page-fetcher/cache";
import type { FetcherEvents, FetchResult } from "@marianmeres/page-fetcher";
import { extname, fromFileUrl, join, normalize } from "@std/path";

const HTML = "text/html; charset=utf-8";
const PORT = Number(Deno.env.get("PORT") ?? 8000);
const STATIC_ROOT = fromFileUrl(new URL("./", import.meta.url));

/** The handful of types this example actually serves. */
const MIME: Record<string, string> = {
	".html": HTML,
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
};

/** Longest body slice sent back to the browser. Enough to see, small enough to send. */
const BODY_PREVIEW_LIMIT = 4_000;

/* ---- demo pages ------------------------------------------------------------ */

/**
 * Per-token attempt counters for the stateful demo routes (`/demo/flaky`,
 * `/demo/rate-limited`). The app sends a fresh token per click, so "fails twice, then
 * succeeds" is reproducible instead of a one-shot.
 */
const counters = new Map<string, number>();

/** Previous hit count for `key`, then increments. */
function bump(key: string): number {
	const n = counters.get(key) ?? 0;
	counters.set(key, n + 1);
	return n;
}

function redirect(status: number, location: string): Response {
	// a real body, so the adapter has something it must explicitly cancel
	return new Response(`<html><body>redirecting → ${location}</body></html>`, {
		status,
		headers: { location, "content-type": HTML },
	});
}

/** Resolves after `ms`, or as soon as the client goes away. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
	});
}

/** A page in windows-1250, so charset resolution has something real to do. */
function cp1250Page(declareInMeta: boolean): Uint8Array {
	const text = "Příliš žluťoučký kůň úpěl ďábelské ódy.";
	// hand-encoded: windows-1250 is not a TextEncoder target
	const map: Record<string, number> = {
		"í": 0xed,
		"ř": 0xf8,
		"š": 0x9a,
		"ž": 0x9e,
		"ť": 0x9d,
		"ů": 0xf9,
		"ě": 0xec,
		"á": 0xe1,
		"é": 0xe9,
		"ó": 0xf3,
		"ň": 0xf2,
		"ú": 0xfa,
		"ď": 0xef,
		"č": 0xe8,
		"ý": 0xfd,
	};
	const meta = declareInMeta ? `<meta charset="windows-1250">` : "";
	const head =
		`<!doctype html><html><head>${meta}<title>windows-1250</title></head><body><p>`;
	const tail = `</p></body></html>`;
	const bytes: number[] = [];
	for (const s of head + text + tail) {
		bytes.push(map[s] ?? s.charCodeAt(0));
	}
	return Uint8Array.from(bytes);
}

async function demo(req: Request, url: URL, origin: string): Promise<Response> {
	const path = url.pathname.slice("/demo".length) || "/";
	const q = url.searchParams;
	// stateful routes are keyed by the caller's token, so each run starts fresh
	const key = `${q.get("token") ?? ""} ${path}`;

	switch (true) {
		case path === "/" || path === "/ok":
			return new Response(
				`<!doctype html><html><head><title>a perfectly ordinary page</title></head>` +
					`<body><h1>200 OK</h1><p>Nothing surprising here.</p></body></html>`,
				{ headers: { "content-type": HTML } },
			);

		case path.startsWith("/redirect/"): {
			const n = Number(path.slice("/redirect/".length));
			if (!Number.isFinite(n) || n <= 0) return redirect(302, "/demo/ok");
			const next = n === 1 ? "/demo/ok" : `/demo/redirect/${n - 1}`;
			// alternate absolute and relative Location values along the chain
			return redirect(302, n % 2 === 0 ? `${origin}${next}` : next);
		}

		case path === "/redirect-loop":
			return redirect(302, "/demo/redirect-loop-b");
		case path === "/redirect-loop-b":
			return redirect(302, "/demo/redirect-loop");

		case path.startsWith("/status/"): {
			const status = Number(path.slice("/status/".length)) || 500;
			return new Response(
				`<!doctype html><html><body><h1>${status}</h1></body></html>`,
				{ status, headers: { "content-type": HTML } },
			);
		}

		case path === "/slow":
			await delay(Number(q.get("ms") ?? 3000), req.signal);
			return new Response(
				`<!doctype html><html><body>…finally</body></html>`,
				{ headers: { "content-type": HTML } },
			);

		case path === "/big": {
			const total = Number(q.get("bytes") ?? 5_000_000);
			const chunk = 64 * 1024;
			let sent = 0;
			const body = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (sent >= total || req.signal.aborted) return controller.close();
					const size = Math.min(chunk, total - sent);
					controller.enqueue(new Uint8Array(size).fill(0x61));
					sent += size;
				},
			});
			// streamed on purpose: chunked, no content-length to short-circuit on
			return new Response(body, { headers: { "content-type": "text/plain" } });
		}

		case path === "/flaky": {
			const fails = Number(q.get("fails") ?? 2);
			return bump(key) < fails
				? new Response("boom", { status: 500, headers: { "content-type": HTML } })
				: new Response(
					`<!doctype html><html><body>ok, after ${fails} failure(s)</body></html>`,
					{ headers: { "content-type": HTML } },
				);
		}

		case path === "/rate-limited": {
			const fails = Number(q.get("fails") ?? 1);
			return bump(key) < fails
				? new Response("slow down", {
					status: 429,
					headers: {
						"retry-after": q.get("after") ?? "2",
						"content-type": "text/plain",
					},
				})
				: new Response(
					`<!doctype html><html><body>rate limit lifted</body></html>`,
					{ headers: { "content-type": HTML } },
				);
		}

		case path === "/cp1250":
			return new Response(cp1250Page(false) as BodyInit, {
				headers: { "content-type": "text/html; charset=windows-1250" },
			});

		case path === "/cp1250-meta":
			// no charset in the header — only the <meta> in the first bytes tells
			return new Response(cp1250Page(true) as BodyInit, {
				headers: { "content-type": "text/html" },
			});

		case path === "/etag": {
			const etag = '"v1"';
			if (req.headers.get("if-none-match") === etag) {
				return new Response(null, { status: 304, headers: { etag } });
			}
			return new Response(
				`<!doctype html><html><body>etagged content</body></html>`,
				{ headers: { etag, "content-type": HTML } },
			);
		}

		case path === "/image":
			// image/gif is not in the adapter's allow list → `unsupported-type`
			return new Response(
				Uint8Array.from([
					0x47,
					0x49,
					0x46,
					0x38,
					0x39,
					0x61,
					0x01,
					0x00,
					0x01,
					0x00,
					0x80,
					0x00,
					0x00,
					0x00,
					0x00,
					0x00,
					0x00,
					0x00,
					0x00,
					0x21,
					0xf9,
					0x04,
					0x01,
					0x00,
					0x00,
					0x00,
					0x00,
					0x2c,
					0x00,
					0x00,
					0x00,
					0x00,
					0x01,
					0x00,
					0x01,
					0x00,
					0x00,
					0x02,
					0x02,
					0x44,
					0x01,
					0x00,
					0x3b,
				]) as BodyInit,
				{ headers: { "content-type": "image/gif" } },
			);

		default:
			return new Response("no such demo page", {
				status: 404,
				headers: { "content-type": "text/plain" },
			});
	}
}

/* ---- the fetch endpoint ---------------------------------------------------- */

/** What the browser posts to `/api/fetch`. Everything is optional but `url`. */
interface FetchPayload {
	url?: string;
	method?: "GET" | "HEAD";
	retainBody?: boolean;
	timeout?: number | null;
	deadline?: number | null;
	attempts?: number;
	maxBytes?: number;
	cache?: "off" | "conditional" | "dev";
	circuitBreaker?: boolean;
	throwOnHttpError?: boolean;
}

/** One line of the event timeline the app renders. */
interface EventRecord {
	/** Ms since the request was accepted here. */
	at: number;
	type: "request" | "retry" | "response" | "error" | "circuit-open";
	text: string;
}

/**
 * The cache store is shared by every fetcher instance, so flipping modes (or attempt
 * counts) in the UI does not silently empty it.
 */
const cacheStore = createMemoryCache({ maxEntries: 100 });

/**
 * Fetchers, keyed by the options that are fetcher-level rather than per-request.
 *
 * Reusing the instance is what makes the circuit breaker demoable at all: its per-host
 * state lives in the layer, so a fetcher built fresh per request would never open.
 */
const fetchers = new Map<string, Fetcher>();

/**
 * Event sinks by `requestId`. The event handlers are fetcher-level (and the fetcher is
 * shared), so they route by the correlation id every event carries.
 */
const sinks = new Map<string, (rec: EventRecord) => void>();

const events: FetcherEvents = {
	onRequest: (req, info) =>
		sinks.get(info.requestId)?.({
			at: 0,
			type: "request",
			text: `attempt ${info.attempt} → ${req.url}`,
		}),
	onRetry: (info) =>
		sinks.get(info.requestId ?? "")?.({
			at: 0,
			type: "retry",
			text: `attempt ${info.attempt} failed (${
				info.error ? info.error.kind : `status ${info.result?.status}`
			}) — sleeping ${Math.round(info.delay)} ms`,
		}),
	onResponse: (res) =>
		sinks.get(res.requestId)?.({
			at: 0,
			type: "response",
			text: `${res.status} ${res.statusText ?? ""} in ${
				Math.round(res.timing.total)
			} ms`.trim(),
		}),
	onError: (err) =>
		sinks.get(err.requestId ?? "")?.({
			at: 0,
			type: "error",
			text: `${err.kind}: ${err.message}`,
		}),
	onCircuitOpen: (info) =>
		sinks.get(info.requestId ?? "")?.({
			at: 0,
			type: "circuit-open",
			text: `circuit opened for ${info.host} until ${
				new Date(info.until).toLocaleTimeString()
			}`,
		}),
};

/** Get (or build) the fetcher for this combination of fetcher-level options. */
function fetcherFor(p: FetchPayload): Fetcher {
	const attempts = Math.max(1, Math.min(5, Number(p.attempts ?? 3)));
	const maxBytes = Math.max(1024, Number(p.maxBytes ?? 1_000_000));
	const mode = p.cache ?? "off";
	const breaker = !!p.circuitBreaker;
	const thrower = !!p.throwOnHttpError;
	const key = JSON.stringify([attempts, maxBytes, mode, breaker, thrower]);

	let fetcher = fetchers.get(key);
	if (!fetcher) {
		fetcher = createFetcher({
			adapters: createHttpAdapter({ maxBytes, events }),
			retry: attempts > 1 ? { attempts } : false,
			// a low threshold and a short cooldown, so the demo is watchable
			circuitBreaker: breaker ? { threshold: 3, cooldown: 15_000 } : false,
			cache: mode === "off" ? undefined : { store: cacheStore, mode },
			throwOnHttpError: thrower,
			userAgent: "page-fetcher-example/1.0 (+local demo)",
			events,
		});
		fetchers.set(key, fetcher);
	}
	return fetcher;
}

/** The parts of a result the app displays. `text()` is resolved here, not there. */
async function serializeResult(res: FetchResult): Promise<Record<string, unknown>> {
	let preview: string | null = null;
	let truncated = false;
	if (res.hasBody) {
		const text = await res.text();
		preview = text.slice(0, BODY_PREVIEW_LIMIT);
		truncated = text.length > BODY_PREVIEW_LIMIT;
	}
	return {
		ok: res.ok,
		status: res.status,
		statusText: res.statusText ?? "",
		url: res.url,
		finalUrl: res.finalUrl,
		redirects: res.redirects,
		contentType: res.contentType ?? null,
		charset: res.charset ?? null,
		size: res.size ?? null,
		hasBody: res.hasBody,
		fromCache: res.fromCache,
		notModified: res.notModified,
		attempts: res.attempts,
		adapter: res.adapter,
		requestId: res.requestId,
		timing: res.timing,
		headers: [...res.headers].map(([k, v]) => [k, v]),
		bodyPreview: preview,
		bodyTruncated: truncated,
	};
}

/**
 * Run one fetch and answer with the outcome — *always* 200 at the transport level. A
 * 404 upstream, a timeout, an open circuit: all of them are results to render, not
 * failures of this endpoint.
 */
async function apiFetch(req: Request): Promise<Response> {
	let payload: FetchPayload;
	try {
		payload = await req.json();
	} catch {
		return json(
			{ error: { kind: "bad-request", message: "invalid JSON body" } },
			400,
		);
	}

	let target: URL;
	try {
		target = new URL(String(payload.url ?? ""));
		if (target.protocol !== "http:" && target.protocol !== "https:") {
			throw new Error("only http(s) URLs");
		}
	} catch {
		return json({
			error: { kind: "bad-request", message: "not an absolute http(s) URL" },
		}, 400);
	}

	const requestId = crypto.randomUUID();
	const startedAt = performance.now();
	const timeline: EventRecord[] = [];
	sinks.set(requestId, (rec) => {
		timeline.push({ ...rec, at: Math.round(performance.now() - startedAt) });
	});

	try {
		const fetcher = fetcherFor(payload);
		const res = await fetcher.fetch({
			url: target.href,
			requestId,
			method: payload.method === "HEAD" ? "HEAD" : "GET",
			retainBody: payload.retainBody !== false,
			timeout: payload.timeout ?? undefined,
			deadline: payload.deadline ?? undefined,
		});
		return json({ result: await serializeResult(res), events: timeline });
	} catch (e) {
		if (!PageFetchError.is(e)) throw e; // a real bug here, not a fetch outcome
		return json({
			error: {
				kind: e.kind,
				message: e.message,
				status: e.status ?? null,
				url: e.url,
				finalUrl: e.finalUrl ?? null,
				attempts: e.attempts,
				retryable: e.retryable,
				details: e.details ?? null,
				// `throwOnHttpError` carries the whole result on the error
				result: e.details?.result
					? await serializeResult(e.details.result as FetchResult)
					: null,
			},
			events: timeline,
		});
	} finally {
		sinks.delete(requestId);
	}
}

/** Forget everything stateful: cached bodies, breaker state, demo attempt counters. */
async function apiReset(): Promise<Response> {
	cacheStore.clear();
	counters.clear();
	// breaker state lives inside the layer, so the instances have to go
	await Promise.all([...fetchers.values()].map((f) => f.dispose()));
	fetchers.clear();
	return json({ ok: true });
}

/* ---- static files ---------------------------------------------------------- */

async function serveStatic(url: URL): Promise<Response> {
	const rel = url.pathname === "/" ? "/index.html" : url.pathname;
	// normalize first, then confine: no `..` climbing out of example/
	const path = join(STATIC_ROOT, normalize(rel));
	if (!path.startsWith(STATIC_ROOT)) return notFound();
	try {
		const body = await Deno.readFile(path);
		return new Response(body as BodyInit, {
			headers: {
				"content-type": MIME[extname(path)] ?? "application/octet-stream",
				"cache-control": "no-store",
			},
		});
	} catch {
		return notFound();
	}
}

/* ---- plumbing -------------------------------------------------------------- */

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

function notFound(): Response {
	return new Response("not found", {
		status: 404,
		headers: { "content-type": "text/plain" },
	});
}

Deno.serve({
	port: PORT,
	hostname: "127.0.0.1",
	onListen: ({ hostname, port }) => {
		console.log(`\n  @marianmeres/page-fetcher example\n`);
		console.log(`  → http://${hostname}:${port}\n`);
	},
}, (req) => {
	const url = new URL(req.url);
	if (url.pathname === "/api/fetch" && req.method === "POST") return apiFetch(req);
	if (url.pathname === "/api/reset" && req.method === "POST") return apiReset();
	if (url.pathname === "/demo" || url.pathname.startsWith("/demo/")) {
		return demo(req, url, url.origin);
	}
	if (req.method !== "GET") return notFound();
	return serveStatic(url);
});

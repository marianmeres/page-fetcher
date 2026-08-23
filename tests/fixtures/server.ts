/**
 * The local fixture HTTP server every I/O test runs against. No external network is
 * ever touched.
 *
 * Two servers are started on random ports (`port: 0`) so cross-origin behavior
 * (credential dropping on redirect) is testable; both share one handler, so every route
 * exists on both origins. All artificial delays hang off one kill switch, because
 * `Deno.serve().shutdown()` waits for in-flight handlers — without it a single `/hang`
 * request would deadlock teardown.
 *
 * Stateful routes key their counters by a caller-supplied `token` query param, so
 * parallel test cases never share state.
 */

import { bomPage, cp1250Page, gzipBytes, metaCharsetPage } from "./bytes.ts";

/** Handle to the running fixture servers. */
export interface FixtureServer {
	/** Primary origin, e.g. `http://127.0.0.1:54321`. */
	origin: string;
	/** Absolute URL on the primary origin. */
	url(path: string): string;
	/** Secondary origin — a different port, therefore a different origin. */
	origin2: string;
	/** Absolute URL on the secondary origin. */
	url2(path: string): string;
	/** How many times `path` was requested with `?token=<token>`. */
	hits(token: string, path: string): number;
	/** Aborts hanging/slow handlers, then shuts both servers down. */
	shutdown(): Promise<void>;
}

const HTML = "text/html; charset=utf-8";
const enc = (s: string) => new TextEncoder().encode(s);

/** Resolves (never rejects) after `ms`, or immediately when any signal fires. */
function abortableDelay(ms: number, ...signals: AbortSignal[]): Promise<void> {
	return new Promise<void>((resolve) => {
		if (signals.some((s) => s.aborted)) return resolve();
		const done = () => {
			clearTimeout(timer);
			for (const s of signals) s.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		for (const s of signals) s.addEventListener("abort", done, { once: true });
	});
}

interface Ctx {
	origin: string;
	other: string;
	kill: AbortSignal;
	counts: Map<string, number>;
}

/** Number of previous hits on `key`, then increments. */
function bump(counts: Map<string, number>, key: string): number {
	const n = counts.get(key) ?? 0;
	counts.set(key, n + 1);
	return n;
}

function json(data: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(data), {
		...init,
		headers: { "content-type": "application/json", ...(init.headers ?? {}) },
	});
}

function redirect(status: number, location: string, note = "redirecting"): Response {
	// a real body, so the adapter has something it must explicitly cancel
	return new Response(`<html><body>${note} -> ${location}</body></html>`, {
		status,
		headers: { location, "content-type": HTML },
	});
}

async function handle(req: Request, ctx: Ctx): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname;
	const q = url.searchParams;
	const token = q.get("token") ?? "";
	const key = `${token} ${path}`;

	if (token) bump(ctx.counts, key);

	switch (true) {
		case path === "/ok":
			return new Response("<html><body>ok</body></html>", {
				headers: { "content-type": HTML },
			});

		case path === "/counter":
			return json(
				Object.fromEntries(
					[...ctx.counts].filter(([k]) => k.startsWith(`${token} `)),
				),
			);

		case path.startsWith("/status/"): {
			const status = Number(path.slice("/status/".length)) || 500;
			return new Response(`status ${status}`, {
				status,
				headers: { "content-type": "text/plain" },
			});
		}

		case path === "/echo" || path === "/echo-headers":
			return json({
				method: req.method,
				url: req.url,
				origin: ctx.origin,
				headers: Object.fromEntries(req.headers),
				body: req.body ? await req.text() : null,
			});

		case path.startsWith("/redirect/"): {
			const n = Number(path.slice("/redirect/".length));
			if (!Number.isFinite(n) || n <= 0) return redirect(302, "/ok");
			// mix absolute and relative Location values across the chain
			const next = n === 1 ? "/ok" : `/redirect/${n - 1}`;
			return redirect(302, n % 2 === 0 ? `${ctx.origin}${next}` : next);
		}

		case path === "/redirect-loop":
			return redirect(302, "/redirect-loop/a");
		case path === "/redirect-loop/a":
			return redirect(302, "/redirect-loop/b");
		case path === "/redirect-loop/b":
			return redirect(302, "/redirect-loop/a");

		case path === "/redirect-cross":
			return redirect(302, `${ctx.other}/echo-headers`);

		case path.startsWith("/redirect-status/"): {
			// /redirect-status/307?to=/echo — for method-rewrite / body-replay tests
			const status = Number(path.slice("/redirect-status/".length)) || 302;
			return redirect(status, q.get("to") ?? "/echo");
		}

		case path === "/redirect-bad-location":
			// a Location that `new URL(location, base)` cannot parse (no host)
			return redirect(302, "http://[bad", "bad location");

		case path === "/slow":
			await abortableDelay(Number(q.get("ms") ?? 100), ctx.kill, req.signal);
			return new Response("slow", { headers: { "content-type": "text/plain" } });

		case path === "/hang":
			// never answers on its own; only the kill switch or a client disconnect ends it
			await abortableDelay(24 * 3600_000, ctx.kill, req.signal);
			return new Response("released", { status: 503 });

		case path === "/trickle": {
			const chunks = Number(q.get("chunks") ?? 5);
			const ms = Number(q.get("ms") ?? 50);
			const body = new ReadableStream<Uint8Array>({
				async pull(controller) {
					for (let i = 0; i < chunks; i++) {
						await abortableDelay(ms, ctx.kill, req.signal);
						if (ctx.kill.aborted || req.signal.aborted) break;
						controller.enqueue(enc(`chunk-${i};`));
					}
					controller.close();
				},
			});
			return new Response(body, { headers: { "content-type": "text/plain" } });
		}

		case path === "/big": {
			const total = Number(q.get("bytes") ?? 1_000_000);
			const chunk = Number(q.get("chunk") ?? 16_384);
			let sent = 0;
			const body = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (sent >= total || ctx.kill.aborted || req.signal.aborted) {
						controller.close();
						return;
					}
					const size = Math.min(chunk, total - sent);
					controller.enqueue(new Uint8Array(size).fill(0x61));
					sent += size;
				},
			});
			// streamed: chunked, no content-length
			return new Response(body, { headers: { "content-type": "text/plain" } });
		}

		case path === "/cp1250":
			return new Response(cp1250Page() as BodyInit, {
				headers: { "content-type": "text/html; charset=windows-1250" },
			});

		case path === "/cp1250-meta":
			return new Response(cp1250Page({ meta: true }) as BodyInit, {
				headers: { "content-type": "text/html" },
			});

		case path === "/meta-charset":
			return new Response(metaCharsetPage() as BodyInit, {
				headers: { "content-type": "text/html" },
			});

		case path === "/bom":
			return new Response(bomPage() as BodyInit, {
				// deliberately wrong: the BOM must win over this header
				headers: { "content-type": "text/html; charset=iso-8859-2" },
			});

		case path === "/gzip": {
			const raw = enc(`<html><body>${"gzipped ".repeat(125)}</body></html>`);
			const gz = await gzipBytes(raw);
			return new Response(gz as BodyInit, {
				headers: {
					"content-type": HTML,
					"content-encoding": "gzip",
					"content-length": String(gz.length),
					"x-raw-length": String(raw.length),
				},
			});
		}

		// A page that is only complete after its scripts have run, plus two
		// subresources on token-carrying URLs — so the browser suite can prove both
		// "the DOM was rendered" and "the blocked resource was never requested".
		case path === "/spa": {
			const asset = (name: string) => `${name}?token=${encodeURIComponent(token)}`;
			return new Response(
				`<!doctype html><html><head><title>loading…</title>` +
					`<link rel="stylesheet" href="/spa.css${
						token ? `?token=${encodeURIComponent(token)}` : ""
					}">` +
					`</head><body><div id="app">pre-hydration</div>` +
					`<img id="pixel" alt="" src="/${asset("spa.png")}">` +
					`<script>setTimeout(function () {` +
					`document.getElementById("app").textContent = "hydrated";` +
					`document.title = "hydrated";` +
					`}, ${Number(q.get("ms") ?? 50)});</script>` +
					`</body></html>`,
				{ headers: { "content-type": HTML } },
			);
		}

		case path === "/spa.css":
			return new Response("#app { color: rebeccapurple }", {
				headers: { "content-type": "text/css" },
			});

		case path === "/spa.png":
			// a 1x1 transparent gif is enough; the browser only has to request it
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

		case path === "/json":
			return json({ hello: "world" });

		case path === "/binary":
			return new Response(new Uint8Array([0, 1, 2, 3]) as BodyInit, {
				headers: { "content-type": "application/octet-stream" },
			});

		case path === "/rate-limited": {
			const fails = Number(q.get("fails") ?? 1);
			return bump(ctx.counts, `${key} attempt`) < fails
				? new Response("slow down", {
					status: 429,
					headers: {
						"retry-after": q.get("after") ?? "0",
						"content-type": "text/plain",
					},
				})
				: new Response("ok", { headers: { "content-type": "text/plain" } });
		}

		case path === "/retry-after-date": {
			return bump(ctx.counts, `${key} attempt`) < 1
				? new Response("slow down", {
					status: 429,
					headers: {
						"retry-after": new Date(Date.now() + 2000).toUTCString(),
						"content-type": "text/plain",
					},
				})
				: new Response("ok", { headers: { "content-type": "text/plain" } });
		}

		case path === "/flaky": {
			const fails = Number(q.get("fails") ?? 1);
			return bump(ctx.counts, `${key} attempt`) < fails
				? new Response("boom", {
					status: 500,
					headers: { "content-type": "text/plain" },
				})
				: new Response("ok", { headers: { "content-type": "text/plain" } });
		}

		case path === "/etag": {
			const etag = '"v1"';
			if (req.headers.get("if-none-match") === etag) {
				return new Response(null, { status: 304, headers: { etag } });
			}
			return new Response("<html><body>etagged</body></html>", {
				headers: { etag, "content-type": HTML },
			});
		}

		case path === "/last-modified": {
			const lastModified = "Wed, 21 Oct 2026 07:28:00 GMT";
			const since = req.headers.get("if-modified-since");
			if (since && Date.parse(since) >= Date.parse(lastModified)) {
				return new Response(null, {
					status: 304,
					headers: { "last-modified": lastModified },
				});
			}
			return new Response("<html><body>dated</body></html>", {
				headers: { "last-modified": lastModified, "content-type": HTML },
			});
		}

		default:
			return new Response("not found", {
				status: 404,
				headers: { "content-type": "text/plain" },
			});
	}
}

/** Strip the body from HEAD responses, keeping the headers a GET would have sent. */
async function stripHeadBody(req: Request, res: Response): Promise<Response> {
	if (req.method !== "HEAD") return res;
	const buf = await res.arrayBuffer();
	const headers = new Headers(res.headers);
	if (!headers.has("content-length")) {
		headers.set("content-length", String(buf.byteLength));
	}
	return new Response(null, {
		status: res.status,
		statusText: res.statusText,
		headers,
	});
}

/**
 * Start both fixture servers on random loopback ports.
 *
 * `Deno.serve` is ready synchronously (its `addr` carries the assigned port), but the
 * signature stays promise-shaped so callers do not have to change if that ever needs
 * to await something.
 */
export function startFixtureServer(): Promise<FixtureServer> {
	const kill = new AbortController();
	const counts = new Map<string, number>();
	const ctx = { origin: "", other: "", kill: kill.signal, counts };
	const ctx2 = { origin: "", other: "", kill: kill.signal, counts };

	const serve = (self: Ctx) =>
		Deno.serve({
			port: 0,
			hostname: "127.0.0.1",
			onListen: () => {},
			onError: (e) => new Response(`fixture handler failed: ${e}`, { status: 500 }),
		}, async (req) => stripHeadBody(req, await handle(req, self)));

	const a = serve(ctx);
	const b = serve(ctx2);

	const origin = `http://127.0.0.1:${a.addr.port}`;
	const origin2 = `http://127.0.0.1:${b.addr.port}`;
	Object.assign(ctx, { origin, other: origin2 });
	Object.assign(ctx2, { origin: origin2, other: origin });

	return Promise.resolve({
		origin,
		origin2,
		url: (path: string) => `${origin}${path}`,
		url2: (path: string) => `${origin2}${path}`,
		hits: (token: string, path: string) => counts.get(`${token} ${path}`) ?? 0,
		shutdown: async () => {
			kill.abort();
			await Promise.all([a.shutdown(), b.shutdown()]);
		},
	});
}

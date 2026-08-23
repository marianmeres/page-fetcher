/**
 * Cache layer: key derivation & bypass matrix, the dev/conditional state machine, the
 * 304 freshen + synthesis flag matrix, LRU eviction, serialization round-trip.
 *
 * Mostly socket-free (stub `FetchFn`s), with a small integration section against the
 * fixture server's real `/etag` and `/last-modified` routes — the two places where the
 * conditional dance has to survive a real HTTP client.
 */

import { assert, assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import {
	CACHE_ENTRY_VERSION,
	cacheKey,
	createCacheLayer,
	createMemoryCache,
	defaultIsCacheable,
	deserializeCachedEntry,
	serializeCachedEntry,
} from "../src/cache.ts";
import type { CachedEntry, CacheStore } from "../src/cache.ts";
import { createHttpAdapter } from "../src/adapters/http.ts";
import { PageFetchError } from "../src/errors.ts";
import { createFetcher } from "../src/fetcher.ts";
import type { FetchRequest, FetchResult } from "../src/types.ts";
import { startFixtureServer } from "./fixtures/server.ts";
import { makeResult, recordingLogger, scriptedFetch } from "./helpers.ts";

const enc = (s: string) => new TextEncoder().encode(s);

/** A minimal entry, overridable field by field. */
function makeEntry(init: Partial<CachedEntry> = {}): CachedEntry {
	const body = init.body ?? enc("cached");
	return {
		v: CACHE_ENTRY_VERSION,
		url: "http://stub.test/",
		finalUrl: "http://stub.test/",
		redirects: [],
		status: 200,
		headers: { "content-type": "text/html" },
		size: body.length,
		adapter: "stub",
		storedAt: Date.now(),
		...init,
		body,
	};
}

// ---------------------------------------------------------------------------
Deno.test("cacheKey", async (t) => {
	await t.step("GET keys on requested adapter + method + verbatim url", () => {
		assertEquals(cacheKey({ url: "http://a/" }), "*:GET:http://a/");
		assertEquals(
			cacheKey({ url: "http://a/", adapter: "browser" }),
			"browser:GET:http://a/",
		);
		assertEquals(cacheKey({ url: "http://a/", method: "GET" }), "*:GET:http://a/");
	});

	await t.step("query order is not normalized — two keys", () => {
		assert(
			cacheKey({ url: "http://a/?a=1&b=2" }) !==
				cacheKey({ url: "http://a/?b=2&a=1" }),
		);
	});

	await t.step("non-GET is uncacheable", () => {
		assertEquals(cacheKey({ url: "http://a/", method: "POST" }), undefined);
		assertEquals(cacheKey({ url: "http://a/", method: "HEAD" }), undefined);
	});
});

// ---------------------------------------------------------------------------
Deno.test("cache layer — bypass matrix", async (t) => {
	const bypasses = async (req: Omit<FetchRequest, "url">, why: string) => {
		const store = createMemoryCache();
		const next = scriptedFetch([makeResult({ body: "live" })]);
		const fn = createCacheLayer({ store })(next);
		await fn({ url: "http://stub.test/", ...req });
		assertEquals(store.size, 0, `${why}: nothing may be stored`);
		assertEquals(next.calls.length, 1);
		// the request must reach the adapter untouched
		assertEquals(next.calls[0].headers?.["if-none-match"], undefined);
	};

	await t.step("POST", () => bypasses({ method: "POST" }, "POST"));
	await t.step("HEAD", () => bypasses({ method: "HEAD" }, "HEAD"));
	await t.step("retainBody: false", () => bypasses({ retainBody: false }, "no body"));

	for (const header of ["If-None-Match", "if-modified-since", "RANGE"]) {
		await t.step(
			`caller's own ${header}`,
			() => bypasses({ headers: { [header]: "x" } }, header),
		);
	}

	await t.step("a key override returning undefined", async () => {
		const store = createMemoryCache();
		const next = scriptedFetch([makeResult()]);
		await createCacheLayer({ store, key: () => undefined })(next)({
			url: "http://stub.test/",
		});
		assertEquals(store.size, 0);
	});

	await t.step("bypass reasons are logged", async () => {
		const logger = recordingLogger();
		await createCacheLayer({ store: createMemoryCache(), logger })(
			scriptedFetch([makeResult()]),
		)({ url: "http://stub.test/", method: "POST" });
		assert(logger.messages("debug").some((m) => m.includes("bypass")));
	});
});

// ---------------------------------------------------------------------------
Deno.test("cache layer — dev mode", async (t) => {
	await t.step("second request never reaches the network", async () => {
		const store = createMemoryCache();
		const next = scriptedFetch([
			makeResult({ body: "first" }),
			makeResult({ body: "second" }),
		]);
		const fn = createCacheLayer({ store, mode: "dev" })(next);

		const a = await fn({ url: "http://stub.test/" });
		assertEquals(await a.text(), "first");
		assertEquals(a.fromCache, false);

		const b = await fn({ url: "http://stub.test/" });
		assertEquals(await b.text(), "first");
		assertEquals(next.calls.length, 1, "no second network call");
	});

	await t.step(
		"pure hit: fromCache, attempts 0, entry's adapter, no dns/ttfb",
		async () => {
			const store = createMemoryCache();
			const next = scriptedFetch([makeResult({ adapter: "http", attempts: 3 })]);
			const fn = createCacheLayer({ store, mode: "dev" })(next);
			await fn({ url: "http://stub.test/" });

			const hit = await fn({ url: "http://stub.test/", meta: { depth: 2 } });
			assertEquals(hit.fromCache, true);
			assertEquals(hit.notModified, false);
			assertEquals(hit.attempts, 0);
			assertEquals(hit.adapter, "http", "provenance, not a 'cache' sentinel");
			assertEquals(hit.ok, true);
			assertEquals(hit.status, 200);
			assertEquals(hit.timing.ttfb, undefined);
			assertEquals(hit.timing.dns, undefined);
			assertEquals(hit.meta, { depth: 2 }, "meta is echoed from the LIVE request");
			assertEquals(hit.extra, undefined);
		},
	);

	await t.step("an expired entry is refetched, not revalidated", async () => {
		using time = new FakeTime(0);
		const store = createMemoryCache();
		const next = scriptedFetch([
			makeResult({ body: "old", headers: { etag: '"v1"' } }),
			makeResult({ body: "new", headers: { etag: '"v2"' } }),
		]);
		const fn = createCacheLayer({ store, mode: "dev", ttl: 1000 })(next);

		await fn({ url: "http://stub.test/" });
		time.tick(500);
		assertEquals(await (await fn({ url: "http://stub.test/" })).text(), "old");
		assertEquals(next.calls.length, 1);

		time.tick(600);
		assertEquals(await (await fn({ url: "http://stub.test/" })).text(), "new");
		assertEquals(next.calls.length, 2);
		assertEquals(
			next.calls[1].headers?.["if-none-match"],
			undefined,
			"dev mode never revalidates",
		);
	});
});

// ---------------------------------------------------------------------------
Deno.test("cache layer — conditional mode", async (t) => {
	await t.step("sends both validators when both are stored", async () => {
		const store = createMemoryCache();
		const next = scriptedFetch([
			makeResult({
				headers: {
					etag: '"v1"',
					"last-modified": "Wed, 21 Oct 2026 07:28:00 GMT",
				},
			}),
			makeResult({ status: 304, body: null }),
		]);
		const fn = createCacheLayer({ store })(next);

		await fn({ url: "http://stub.test/" });
		await fn({ url: "http://stub.test/" });

		assertEquals(next.calls[1].headers?.["if-none-match"], '"v1"');
		assertEquals(
			next.calls[1].headers?.["if-modified-since"],
			"Wed, 21 Oct 2026 07:28:00 GMT",
		);
	});

	await t.step("no ttl ⇒ revalidates every time; within ttl ⇒ pure hit", async () => {
		using time = new FakeTime(0);
		const store = createMemoryCache();
		const next = scriptedFetch([
			makeResult({ headers: { etag: '"v1"' } }),
			makeResult({ status: 304, body: null }),
		]);
		const fn = createCacheLayer({ store, ttl: 1000 })(next);

		await fn({ url: "http://stub.test/" });
		time.tick(500);
		const warm = await fn({ url: "http://stub.test/" });
		assertEquals(warm.attempts, 0, "inside the ttl: no round trip");
		assertEquals(next.calls.length, 1);

		time.tick(600);
		const revalidated = await fn({ url: "http://stub.test/" });
		assertEquals(next.calls.length, 2);
		assertEquals(revalidated.notModified, true);
	});

	await t.step("304 → freshened entry, synthesized result", async () => {
		using time = new FakeTime(1_000_000);
		const store = createMemoryCache();
		const next = scriptedFetch([
			makeResult({
				body: "body-v1",
				headers: { etag: '"v1"', "content-type": "text/html", "x-old": "keep" },
				adapter: "http",
			}),
			makeResult({
				status: 304,
				body: null,
				attempts: 2,
				adapter: "http",
				headers: { etag: '"v2"', "x-new": "added", "content-length": "0" },
			}),
		]);
		const fn = createCacheLayer({ store })(next);

		await fn({ url: "http://stub.test/" });
		time.tick(60_000);
		const res = await fn({ url: "http://stub.test/" });

		assertEquals(res.status, 200, "the stored status, not 304");
		assertEquals(res.ok, true);
		assertEquals(res.fromCache, true);
		assertEquals(res.notModified, true);
		assertEquals(res.attempts, 2, "the revalidation's real attempt count");
		assertEquals(await res.text(), "body-v1");
		assertEquals(res.headers.get("x-old"), "keep", "merged over, not replaced");
		assertEquals(res.headers.get("x-new"), "added");
		assertEquals(res.headers.get("etag"), '"v2"');
		assertEquals(res.headers.get("content-length"), null, "never freshened");

		const entry = await store.get("*:GET:http://stub.test/");
		assertEquals(entry?.etag, '"v2"');
		assertEquals(entry?.storedAt, 1_060_000, "storedAt is bumped on a 304");
		assertEquals(next.calls[1].headers?.["if-none-match"], '"v1"');
	});

	await t.step("200 on revalidation replaces the entry", async () => {
		const store = createMemoryCache();
		const next = scriptedFetch([
			makeResult({ body: "old", headers: { etag: '"v1"' } }),
			makeResult({ body: "new", headers: { etag: '"v2"' } }),
		]);
		const fn = createCacheLayer({ store })(next);

		await fn({ url: "http://stub.test/" });
		const res = await fn({ url: "http://stub.test/" });
		assertEquals(res.fromCache, false);
		assertEquals(await res.text(), "new");

		const entry = await store.get("*:GET:http://stub.test/");
		assertEquals(entry?.etag, '"v2"');
		assertEquals(new TextDecoder().decode(entry!.body), "new");
	});

	await t.step("a 500 on revalidation leaves the entry intact", async () => {
		const store = createMemoryCache();
		const next = scriptedFetch([
			makeResult({ body: "good", headers: { etag: '"v1"' } }),
			makeResult({ status: 500, body: "boom" }),
		]);
		const fn = createCacheLayer({ store })(next);

		await fn({ url: "http://stub.test/" });
		const res = await fn({ url: "http://stub.test/" });
		assertEquals(res.status, 500, "the live failure is returned, not masked");
		assertEquals(res.fromCache, false);

		const entry = await store.get("*:GET:http://stub.test/");
		assertEquals(new TextDecoder().decode(entry!.body), "good");
		assertEquals(entry?.etag, '"v1"');
	});

	await t.step(
		"an entry without validators is refetched, not revalidated",
		async () => {
			const store = createMemoryCache();
			const next = scriptedFetch([
				makeResult({ body: "a" }),
				makeResult({ body: "b" }),
			]);
			const fn = createCacheLayer({ store })(next);

			await fn({ url: "http://stub.test/" });
			const res = await fn({ url: "http://stub.test/" });
			assertEquals(await res.text(), "b");
			assertEquals(next.calls[1].headers?.["if-none-match"], undefined);
		},
	);

	await t.step("errors propagate unchanged — a hit never masks one", async () => {
		const store = createMemoryCache();
		const boom = new PageFetchError({ kind: "network", url: "http://stub.test/" });
		const fn = createCacheLayer({ store })(
			scriptedFetch([makeResult({ headers: { etag: '"v1"' } }), boom]),
		);
		await fn({ url: "http://stub.test/" });
		const e = await assertRejects(
			() => fn({ url: "http://stub.test/" }),
			PageFetchError,
		);
		assertStrictEquals(e, boom);
	});
});

// ---------------------------------------------------------------------------
Deno.test("cache layer — cacheability", async (t) => {
	await t.step("defaultIsCacheable", () => {
		assert(defaultIsCacheable(makeResult({ status: 200 })));
		assert(!defaultIsCacheable(makeResult({ status: 404 })));
		assert(!defaultIsCacheable(makeResult({ status: 204 })));
		assert(
			!defaultIsCacheable(
				makeResult({ headers: { "cache-control": "max-age=0, no-store" } }),
			),
		);
		assert(
			defaultIsCacheable(
				makeResult({ headers: { "cache-control": "no-store-policy" } }),
			),
			"a naive includes() would false-positive on this extension",
		);
	});

	await t.step("non-200 is not stored by default", async () => {
		const store = createMemoryCache();
		await createCacheLayer({ store })(scriptedFetch([makeResult({ status: 404 })]))({
			url: "http://stub.test/",
		});
		assertEquals(store.size, 0);
	});

	await t.step("negative caching via isCacheable", async () => {
		const store = createMemoryCache();
		const next = scriptedFetch([makeResult({ status: 404, body: "gone" })]);
		const fn = createCacheLayer({
			store,
			mode: "dev",
			isCacheable: (r: FetchResult) => r.status === 200 || r.status === 404,
		})(next);

		await fn({ url: "http://stub.test/" });
		const hit = await fn({ url: "http://stub.test/" });
		assertEquals(hit.status, 404);
		assertEquals(hit.ok, false, "a replayed 404 is still not ok");
		assertEquals(hit.fromCache, true);
		assertEquals(next.calls.length, 1);
	});

	await t.step(
		"a bodyless result is never stored, whatever isCacheable says",
		async () => {
			const store = createMemoryCache();
			const logger = recordingLogger();
			await createCacheLayer({ store, logger, isCacheable: () => true })(
				scriptedFetch([makeResult({ body: null })]),
			)({ url: "http://stub.test/" });
			assertEquals(store.size, 0);
			assert(logger.messages("debug").some((m) => m.includes("no body")));
		},
	);

	await t.step("set-cookie is stripped at store time", async () => {
		const store = createMemoryCache();
		const headers = new Headers();
		headers.append("set-cookie", "a=1");
		headers.append("set-cookie", "b=2");
		headers.set("x-keep", "yes");
		await createCacheLayer({ store, mode: "dev" })(
			scriptedFetch([makeResult({ headers })]),
		)({ url: "http://stub.test/" });

		const entry = await store.get("*:GET:http://stub.test/");
		assertEquals(entry?.headers["set-cookie"], undefined);
		assertEquals(entry?.headers["x-keep"], "yes");
	});
});

// ---------------------------------------------------------------------------
Deno.test("cache layer — a broken store degrades to a bypass", async (t) => {
	const broken: CacheStore = {
		get: () => Promise.reject(new Error("disk on fire")),
		set: () => Promise.reject(new Error("disk still on fire")),
		delete: () => Promise.resolve(),
	};

	await t.step("get and set failures warn but never fail the fetch", async () => {
		const logger = recordingLogger();
		const res = await createCacheLayer({ store: broken, logger })(
			scriptedFetch([makeResult({ body: "live" })]),
		)({ url: "http://stub.test/" });

		assertEquals(await res.text(), "live");
		const warnings = logger.messages("warn");
		assert(warnings.some((m) => m.includes("store.get failed")), warnings.join("\n"));
		assert(warnings.some((m) => m.includes("store.set failed")), warnings.join("\n"));
	});
});

// ---------------------------------------------------------------------------
Deno.test("createMemoryCache", async (t) => {
	await t.step("LRU: get reorders, the least recently used goes first", async () => {
		const store = createMemoryCache({ maxEntries: 2 });
		await store.set("a", makeEntry());
		await store.set("b", makeEntry());
		await store.get("a"); // touch a → b is now the eviction candidate
		await store.set("c", makeEntry());

		assertEquals(store.size, 2);
		assert(await store.get("a"));
		assertEquals(await store.get("b"), undefined);
		assert(await store.get("c"));
	});

	await t.step("re-setting an existing key reorders it too", async () => {
		const store = createMemoryCache({ maxEntries: 2 });
		await store.set("a", makeEntry());
		await store.set("b", makeEntry());
		await store.set("a", makeEntry());
		await store.set("c", makeEntry());
		assertEquals(await store.get("b"), undefined);
		assert(await store.get("a"));
	});

	await t.step("entries are shared by reference, not cloned", async () => {
		const store = createMemoryCache();
		const entry = makeEntry();
		await store.set("k", entry);
		assertStrictEquals((await store.get("k"))!.body, entry.body);
	});

	await t.step("evictions are logged; delete and clear work", async () => {
		const logger = recordingLogger();
		const store = createMemoryCache({ maxEntries: 1, logger });
		await store.set("a", makeEntry());
		await store.set("b", makeEntry());
		assert(logger.messages("debug").some((m) => m.includes("evict a")));

		await store.delete("b");
		assertEquals(store.size, 0);
		await store.set("c", makeEntry());
		store.clear();
		assertEquals(store.size, 0);
	});

	await t.step("maxEntries must be >= 1", () => {
		let threw = false;
		try {
			createMemoryCache({ maxEntries: 0 });
		} catch (e) {
			threw = e instanceof TypeError;
		}
		assert(threw);
	});
});

// ---------------------------------------------------------------------------
Deno.test("serializeCachedEntry / deserializeCachedEntry", async (t) => {
	await t.step("round-trips every field", () => {
		const entry = makeEntry({
			statusText: "OK",
			redirects: ["http://a/", "http://b/"],
			etag: '"v1"',
			lastModified: "Wed, 21 Oct 2026 07:28:00 GMT",
			charset: "windows-1250",
			contentType: "text/html",
		});
		const { meta, body } = serializeCachedEntry(entry);
		assertEquals(
			JSON.parse(meta).body,
			undefined,
			"the body never rides in the JSON",
		);
		assertEquals(deserializeCachedEntry(meta, body), entry);
	});

	await t.step("rejects bad JSON, non-objects and unknown versions", () => {
		for (
			const [meta, hint] of [
				["{oops", "not valid JSON"],
				["[1,2]", "not an object"],
				[JSON.stringify({ v: 99, url: "http://a/" }), "Unsupported cached entry"],
			]
		) {
			const e = assertThrowsPageFetchError(() =>
				deserializeCachedEntry(meta, new Uint8Array())
			);
			assertEquals(e.kind, "decode");
			assert(e.message.includes(hint), `${e.message} should mention ${hint}`);
		}
	});
});

function assertThrowsPageFetchError(fn: () => unknown): PageFetchError {
	try {
		fn();
	} catch (e) {
		assert(PageFetchError.is(e), `expected a PageFetchError, got ${e}`);
		return e;
	}
	throw new Error("expected a throw");
}

// ---------------------------------------------------------------------------
Deno.test("cache — integration with the real HTTP adapter", async (t) => {
	const server = await startFixtureServer();
	const adapter = createHttpAdapter();

	await t.step("ETag: 304 is resolved into the stored body", async () => {
		const store = createMemoryCache();
		const fetcher = createFetcher({ adapters: adapter, cache: store, retry: false });
		const url = server.url("/etag?token=cache-etag");

		const first = await fetcher.fetch(url);
		assertEquals(first.fromCache, false);
		assertEquals(await first.text(), "<html><body>etagged</body></html>");

		const second = await fetcher.fetch(url);
		assertEquals(second.status, 200);
		assertEquals(second.fromCache, true);
		assertEquals(second.notModified, true);
		assertEquals(await second.text(), "<html><body>etagged</body></html>");
		assertEquals(second.hasBody, true);
		assertEquals(server.hits("cache-etag", "/etag"), 2, "both requests hit the wire");
	});

	await t.step("Last-Modified: same, via If-Modified-Since", async () => {
		const store = createMemoryCache();
		const fetcher = createFetcher({ adapters: adapter, cache: store, retry: false });
		const url = server.url("/last-modified?token=cache-lm");

		await fetcher.fetch(url);
		const second = await fetcher.fetch(url);
		assertEquals(second.notModified, true);
		assertEquals(await second.text(), "<html><body>dated</body></html>");
	});

	await t.step("dev mode: the second request never leaves the process", async () => {
		const store = createMemoryCache();
		const fetcher = createFetcher({
			adapters: adapter,
			cache: { store, mode: "dev" },
			retry: false,
		});
		const url = server.url("/ok?token=cache-dev");

		await fetcher.fetch(url);
		const hit = await fetcher.fetch(url);
		assertEquals(hit.fromCache, true);
		assertEquals(hit.attempts, 0);
		assertEquals(server.hits("cache-dev", "/ok"), 1, "exactly one network hit");
	});

	await t.step("caching stays off unless a store is given", async () => {
		const fetcher = createFetcher({ adapters: adapter, retry: false });
		const url = server.url("/ok?token=cache-off");
		await fetcher.fetch(url);
		await fetcher.fetch(url);
		assertEquals(server.hits("cache-off", "/ok"), 2);
	});

	await adapter.dispose?.();
	await server.shutdown();
});

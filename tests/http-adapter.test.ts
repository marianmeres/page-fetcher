import { assert, assertEquals, assertRejects } from "@std/assert";
import { createHttpAdapter, DEFAULT_USER_AGENT } from "../src/adapters/http.ts";
import { PageFetchError } from "../src/errors.ts";
import { startFixtureServer } from "./fixtures/server.ts";
import { recordingLogger } from "./helpers.ts";

const echoed = async (res: { text(): Promise<string> }) =>
	JSON.parse(await res.text()) as {
		method: string;
		url: string;
		origin: string;
		headers: Record<string, string>;
		body: string | null;
	};

Deno.test("http adapter", async (t) => {
	const server = await startFixtureServer();
	const http = createHttpAdapter();

	try {
		await t.step("200: normalized result shape", async () => {
			const res = await http.fetch({
				url: server.url("/ok"),
				meta: { depth: 2 },
			});
			assertEquals(res.ok, true);
			assertEquals(res.status, 200);
			assertEquals(res.url, server.url("/ok"));
			assertEquals(res.finalUrl, server.url("/ok"));
			assertEquals(res.redirects, []);
			assertEquals(res.adapter, "http");
			assertEquals(res.attempts, 1);
			assertEquals(res.fromCache, false);
			assertEquals(res.notModified, false);
			assertEquals(res.contentType, "text/html");
			assertEquals(res.charset, "utf-8");
			assertEquals(res.hasBody, true);
			assertEquals(res.meta, { depth: 2 });
			assert(res.requestId.length > 0);
			assert((await res.text()).includes("ok"));
			assertEquals(res.size, (await res.bytes()).length);
			assert(res.timing.total >= 0);
			assertEquals(res.timing.total, res.timing.endedAt - res.timing.startedAt);
			assert((res.timing.ttfb ?? -1) >= 0);
			assert((res.timing.download ?? -1) >= 0);
			// the HTTP adapter cannot observe these
			assertEquals(res.timing.dns, undefined);
			assertEquals(res.timing.connect, undefined);
		});

		await t.step("non-2xx resolves as data, it does not throw", async () => {
			for (const status of [404, 500, 429]) {
				const res = await http.fetch({ url: server.url(`/status/${status}`) });
				assertEquals(res.ok, false);
				assertEquals(res.status, status);
				assertEquals(await res.text(), `status ${status}`);
			}
		});

		await t.step("requestId: passed through, or generated when missing", async () => {
			const given = await http.fetch({
				url: server.url("/ok"),
				requestId: "rid-1",
			});
			assertEquals(given.requestId, "rid-1");
			const a = await http.fetch({ url: server.url("/ok") });
			const b = await http.fetch({ url: server.url("/ok") });
			assert(a.requestId !== b.requestId);
		});

		await t.step("redirect chain is recorded; finalUrl is the last hop", async () => {
			const res = await http.fetch({ url: server.url("/redirect/3") });
			assertEquals(res.status, 200);
			assertEquals(res.finalUrl, server.url("/ok"));
			assertEquals(res.redirects, [
				server.url("/redirect/3"),
				server.url("/redirect/2"),
				server.url("/redirect/1"),
			]);
			assert(
				!res.redirects.includes(res.finalUrl),
				"the final URL is not part of the chain",
			);
			assert((await res.text()).includes("ok"));
		});

		await t.step("maxRedirects is enforced", async () => {
			const capped = createHttpAdapter({ maxRedirects: 2 });
			const e = await assertRejects(
				() => capped.fetch({ url: server.url("/redirect/9") }),
				PageFetchError,
			);
			assertEquals(e.kind, "too-many-redirects");
			assertEquals(e.retryable, false);
			assertEquals(e.attempts, 1);
			assertEquals((e.details?.chain as string[]).length, 3);
		});

		await t.step("redirect loops are detected before the cap", async () => {
			const e = await assertRejects(
				() => http.fetch({ url: server.url("/redirect-loop") }),
				PageFetchError,
			);
			assertEquals(e.kind, "too-many-redirects");
			assert(e.message.includes("loop"));
			assertEquals(e.details?.repeated, server.url("/redirect-loop/a"));
		});

		await t.step(
			"a malformed Location makes the 3xx the final response",
			async () => {
				const logger = recordingLogger();
				const res = await createHttpAdapter({ logger }).fetch({
					url: server.url("/redirect-bad-location"),
				});
				assertEquals(res.status, 302);
				assertEquals(res.ok, false);
				assertEquals(res.redirects, []);
				assert((await res.text()).includes("bad location"));
				assert(
					logger.messages("warn").some((m) => m.includes("malformed Location")),
				);
			},
		);

		await t.step("Authorization and Cookie are kept same-origin", async () => {
			const res = await http.fetch({
				url: server.url("/redirect-status/302?to=/echo"),
				headers: { authorization: "Bearer secret", cookie: "sid=1" },
			});
			const body = await echoed(res);
			assertEquals(body.origin, server.origin);
			assertEquals(body.headers.authorization, "Bearer secret");
			assertEquals(body.headers.cookie, "sid=1");
		});

		await t.step("Authorization and Cookie are dropped cross-origin", async () => {
			const logger = recordingLogger();
			const res = await createHttpAdapter({ logger }).fetch({
				url: server.url("/redirect-cross"),
				headers: { authorization: "Bearer secret", cookie: "sid=1" },
			});
			const body = await echoed(res);
			assertEquals(res.finalUrl, `${server.origin2}/echo-headers`);
			assertEquals(body.origin, server.origin2);
			assertEquals(body.headers.authorization, undefined);
			assertEquals(body.headers.cookie, undefined);
			assertEquals(
				logger.messages("debug").filter((m) => m.includes("dropped")).length,
				2,
			);
		});

		await t.step("default User-Agent is sent and can be overridden", async () => {
			const fromDefault = await echoed(
				await http.fetch({ url: server.url("/echo") }),
			);
			assertEquals(fromDefault.headers["user-agent"], DEFAULT_USER_AGENT);

			const custom = createHttpAdapter({ userAgent: "adapter-ua" });
			assertEquals(
				(await echoed(await custom.fetch({ url: server.url("/echo") })))
					.headers["user-agent"],
				"adapter-ua",
			);
			// request headers win over the adapter level
			assertEquals(
				(await echoed(
					await custom.fetch({
						url: server.url("/echo"),
						headers: { "User-Agent": "request-ua" },
					}),
				)).headers["user-agent"],
				"request-ua",
			);
			// false leaves the platform UA alone
			const platform = createHttpAdapter({ userAgent: false });
			const ua = (await echoed(await platform.fetch({ url: server.url("/echo") })))
				.headers["user-agent"];
			assert(ua !== DEFAULT_USER_AGENT && (ua?.length ?? 0) > 0);
		});

		await t.step("adapter headers merge under request headers", async () => {
			const withHeaders = createHttpAdapter({
				headers: { "x-a": "adapter", "x-b": "adapter" },
			});
			const body = await echoed(
				await withHeaders.fetch({
					url: server.url("/echo"),
					headers: { "x-b": "request" },
				}),
			);
			assertEquals(body.headers["x-a"], "adapter");
			assertEquals(body.headers["x-b"], "request");
		});

		await t.step("HEAD resolves without a body", async () => {
			const res = await http.fetch({ url: server.url("/ok"), method: "HEAD" });
			assertEquals(res.status, 200);
			assertEquals(res.hasBody, false);
			assertEquals(res.size, undefined);
			const e = await assertRejects(() => res.text(), PageFetchError);
			assertEquals(e.kind, "no-body");
			assertEquals(e.details?.reason, "head");
		});

		await t.step("POST sends the body", async () => {
			const body = await echoed(
				await http.fetch({
					url: server.url("/echo"),
					method: "POST",
					headers: { "content-type": "text/plain" },
					body: "hello=1",
				}),
			);
			assertEquals(body.method, "POST");
			assertEquals(body.body, "hello=1");
		});

		await t.step("a body factory is invoked per hop", async () => {
			let made = 0;
			const res = await http.fetch({
				url: server.url("/redirect-status/307?to=/echo"),
				method: "POST",
				headers: { "content-type": "text/plain" },
				body: () => {
					made++;
					return "payload";
				},
			});
			const body = await echoed(res);
			// 307 preserves method AND body
			assertEquals(body.method, "POST");
			assertEquals(body.body, "payload");
			assertEquals(made, 2);
		});

		await t.step("301/302/303 rewrite POST to GET and drop the body", async () => {
			for (const status of [301, 302, 303]) {
				const res = await http.fetch({
					url: server.url(`/redirect-status/${status}?to=/echo`),
					method: "POST",
					headers: { "content-type": "text/plain" },
					body: "dropped",
				});
				const body = await echoed(res);
				assertEquals(body.method, "GET", `status ${status}`);
				assertEquals(body.body, null, `status ${status}`);
				assertEquals(body.headers["content-type"], undefined, `status ${status}`);
			}
		});

		await t.step("308 preserves the method", async () => {
			const body = await echoed(
				await http.fetch({
					url: server.url("/redirect-status/308?to=/echo"),
					method: "POST",
					body: "kept",
				}),
			);
			assertEquals(body.method, "POST");
			assertEquals(body.body, "kept");
		});

		await t.step("gzip is decoded transparently and counted decoded", async () => {
			const res = await http.fetch({ url: server.url("/gzip") });
			const rawLength = Number(res.headers.get("x-raw-length"));
			const wireLength = Number(res.headers.get("content-length"));
			assertEquals(res.size, rawLength);
			assertEquals((await res.text()).length, rawLength);
			assert(wireLength < rawLength);
		});

		await t.step(
			"maxBytes counts decoded bytes, so gzip cannot smuggle a big body",
			async () => {
				const res = await http.fetch({ url: server.url("/gzip") });
				const rawLength = Number(res.headers.get("x-raw-length"));
				const wireLength = Number(res.headers.get("content-length"));
				// a budget above the wire size but below the decoded size must still trip
				assert(
					wireLength < 500 && 500 < rawLength,
					"fixture sizes no longer straddle the budget",
				);
				const tight = createHttpAdapter({ maxBytes: 500 });
				const e = await assertRejects(
					() => tight.fetch({ url: server.url("/gzip") }),
					PageFetchError,
				);
				assertEquals(e.kind, "too-large");
				assertEquals(e.retryable, false);
				assertEquals(e.details?.maxBytes, 500);
			},
		);

		await t.step("maxBytes aborts a stream mid-body", async () => {
			const logger = recordingLogger();
			const tight = createHttpAdapter({ maxBytes: 1000, logger });
			const e = await assertRejects(
				() => tight.fetch({ url: server.url("/big?bytes=500000&chunk=256") }),
				PageFetchError,
			);
			assertEquals(e.kind, "too-large");
			// it stopped early: nowhere near the full 500 kB
			assert((e.details?.read as number) <= 2000, `read ${e.details?.read}`);
			assert(logger.messages("warn").some((m) => m.includes("maxBytes exceeded")));
		});

		await t.step(
			"content-type policy: allowed, error, skip-body, disabled",
			async () => {
				// json is allowed by the default list
				const json = await http.fetch({ url: server.url("/json") });
				assertEquals(json.contentType, "application/json");
				assertEquals(JSON.parse(await json.text()), { hello: "world" });

				const e = await assertRejects(
					() => http.fetch({ url: server.url("/binary") }),
					PageFetchError,
				);
				assertEquals(e.kind, "unsupported-type");
				assertEquals(e.retryable, false);
				assertEquals(e.details?.contentType, "application/octet-stream");

				const skipping = createHttpAdapter({ onUnsupportedType: "skip-body" });
				const skipped = await skipping.fetch({ url: server.url("/binary") });
				assertEquals(skipped.ok, true);
				assertEquals(skipped.status, 200);
				assertEquals(skipped.contentType, "application/octet-stream");
				assertEquals(skipped.hasBody, false);
				assertEquals(skipped.size, undefined);
				const noBody = await assertRejects(() => skipped.bytes(), PageFetchError);
				assertEquals(noBody.kind, "no-body");
				assertEquals(noBody.details?.reason, "skip-body");

				const anything = createHttpAdapter({ allowContentTypes: null });
				const binary = await anything.fetch({ url: server.url("/binary") });
				assertEquals(binary.hasBody, true);
				assertEquals(await binary.bytes(), new Uint8Array([0, 1, 2, 3]));
			},
		);

		await t.step(
			"retainBody: false skips the body but keeps the headers",
			async () => {
				const res = await http.fetch({
					url: server.url("/ok"),
					retainBody: false,
				});
				assertEquals(res.status, 200);
				assertEquals(res.hasBody, false);
				assertEquals(res.size, undefined);
				assertEquals(res.contentType, "text/html");
				const e = await assertRejects(() => res.text(), PageFetchError);
				assertEquals(e.details?.reason, "retain-body");

				// adapter-level default, overridable per request
				const noBodies = createHttpAdapter({ retainBody: false });
				assertEquals(
					(await noBodies.fetch({ url: server.url("/ok") })).hasBody,
					false,
				);
				assertEquals(
					(await noBodies.fetch({ url: server.url("/ok"), retainBody: true }))
						.hasBody,
					true,
				);
			},
		);

		await t.step("304 passes through untouched", async () => {
			const first = await http.fetch({ url: server.url("/etag?token=a1") });
			assertEquals(first.status, 200);
			const etag = first.headers.get("etag")!;
			const second = await http.fetch({
				url: server.url("/etag?token=a1"),
				headers: { "if-none-match": etag },
			});
			assertEquals(second.status, 304);
			assertEquals(second.ok, false); // only the cache layer may call a 304 ok
			assertEquals(second.notModified, false); // ... and only it sets this flag
			assertEquals(second.hasBody, false);
			const e = await assertRejects(() => second.text(), PageFetchError);
			assertEquals(e.details?.reason, "not-modified");
		});

		await t.step(
			"a caller abort before the response maps to kind aborted",
			async () => {
				const ctrl = new AbortController();
				const pending = http.fetch({
					url: server.url("/hang?token=b1"),
					signal: ctrl.signal,
				});
				const timer = setTimeout(() => ctrl.abort(), 30);
				const e = await assertRejects(() => pending, PageFetchError);
				clearTimeout(timer);
				assertEquals(e.kind, "aborted");
				assertEquals(e.retryable, false);
				assertEquals(e.attempts, 1);
			},
		);

		await t.step("a caller abort mid-body maps to kind aborted", async () => {
			const ctrl = new AbortController();
			const pending = http.fetch({
				url: server.url("/trickle?chunks=20&ms=25"),
				signal: ctrl.signal,
			});
			const timer = setTimeout(() => ctrl.abort(), 40);
			const e = await assertRejects(() => pending, PageFetchError);
			clearTimeout(timer);
			assertEquals(e.kind, "aborted");
		});

		await t.step("an already-aborted signal fails before any I/O", async () => {
			const e = await assertRejects(
				() =>
					http.fetch({
						url: server.url("/ok?token=never"),
						signal: AbortSignal.abort(),
					}),
				PageFetchError,
			);
			assertEquals(e.kind, "aborted");
			assertEquals(server.hits("never", "/ok"), 0);
		});
	} finally {
		await server.shutdown();
	}
});

Deno.test("http adapter: unit cases with an injected fetch", async (t) => {
	await t.step("Content-Length fast-fail never drains the body", async () => {
		let cancelled = false;
		let pulls = 0;
		const adapter = createHttpAdapter({
			maxBytes: 100,
			fetch: () => {
				const body = new ReadableStream<Uint8Array>({
					pull(controller) {
						pulls++;
						controller.enqueue(new Uint8Array(10));
					},
					cancel() {
						cancelled = true;
					},
				});
				return Promise.resolve(
					new Response(body, {
						headers: {
							"content-length": "999999",
							"content-type": "text/html",
						},
					}),
				);
			},
		});
		const e = await assertRejects(
			() => adapter.fetch({ url: "http://unit.test/big" }),
			PageFetchError,
		);
		assertEquals(e.kind, "too-large");
		assertEquals(e.details?.contentLength, 999999);
		assertEquals(cancelled, true, "the body must be released, not drained");
		// a fresh stream pre-pulls one chunk to fill its queue; nothing beyond that
		assert(pulls <= 1, `pulled ${pulls} times`);
	});

	await t.step(
		"a compressed response skips the fast-fail (wire size lies)",
		async () => {
			const adapter = createHttpAdapter({
				maxBytes: 1000,
				fetch: () =>
					Promise.resolve(
						new Response("small once decoded", {
							headers: {
								"content-length": "999999", // the wire size, under compression
								"content-encoding": "gzip",
								"content-type": "text/html",
							},
						}),
					),
			});
			const res = await adapter.fetch({ url: "http://unit.test/gz" });
			assertEquals(res.status, 200);
			assertEquals(await res.text(), "small once decoded");
		},
	);

	await t.step("a transport failure becomes kind network, retryable", async () => {
		const adapter = createHttpAdapter({
			fetch: () => Promise.reject(new TypeError("error sending request")),
		});
		const e = await assertRejects(
			() => adapter.fetch({ url: "http://unit.test/down" }),
			PageFetchError,
		);
		assertEquals(e.kind, "network");
		assertEquals(e.retryable, true);
		assertEquals(e.attempts, 1);
		assert(e.cause instanceof TypeError);
	});

	await t.step("an invalid URL fails loudly and is not retryable", async () => {
		const e = await assertRejects(
			() => createHttpAdapter().fetch({ url: "not a url" }),
			PageFetchError,
		);
		assertEquals(e.kind, "network");
		assertEquals(e.retryable, false);
		assert(e.message.includes("Invalid URL"));
	});

	await t.step("a raw ReadableStream body is rejected at a 307 replay", async () => {
		let hop = 0;
		const adapter = createHttpAdapter({
			fetch: () => {
				hop++;
				return Promise.resolve(
					hop === 1
						? new Response("go", {
							status: 307,
							headers: { location: "/next" },
						})
						: new Response("done", {
							headers: { "content-type": "text/html" },
						}),
				);
			},
		});
		const e = await assertRejects(
			() =>
				adapter.fetch({
					url: "http://unit.test/post",
					method: "POST",
					// only reachable from JS — the type forbids it precisely because of this
					body: new ReadableStream<Uint8Array>() as never,
				}),
			PageFetchError,
		);
		assertEquals(e.kind, "network");
		assertEquals(e.retryable, false);
		assert(e.message.includes("Non-replayable"));
		assertEquals(hop, 1);
	});
});

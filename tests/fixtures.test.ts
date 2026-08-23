/**
 * Smoke tests for the fixture server itself, so a later adapter failure bisects to
 * "adapter" and not "fixture".
 */
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { startFixtureServer } from "./fixtures/server.ts";
import { CP1250_TEXT, CP1250_WORD } from "./fixtures/bytes.ts";

Deno.test("fixture server", async (t) => {
	const server = await startFixtureServer();
	try {
		await t.step("serves two distinct loopback origins", () => {
			assert(server.origin.startsWith("http://127.0.0.1:"));
			assertNotEquals(server.origin, server.origin2);
		});

		await t.step("/ok and /status/:code", async () => {
			const ok = await fetch(server.url("/ok"));
			assertEquals(ok.status, 200);
			assertEquals(ok.headers.get("content-type"), "text/html; charset=utf-8");
			assert((await ok.text()).includes("ok"));

			const notFound = await fetch(server.url("/status/404"));
			assertEquals(notFound.status, 404);
			await notFound.body?.cancel();
		});

		await t.step("HEAD returns headers without a body", async () => {
			const res = await fetch(server.url("/ok"), { method: "HEAD" });
			assertEquals(res.status, 200);
			assertEquals(res.body, null);
			assert(Number(res.headers.get("content-length")) > 0);
		});

		await t.step(
			"redirects are real 3xx with a readable body under manual mode",
			async () => {
				const res = await fetch(server.url("/redirect/2"), {
					redirect: "manual",
				});
				assertEquals(res.status, 302);
				assert(res.headers.get("location"));
				assert((await res.text()).includes("redirecting"));
			},
		);

		await t.step("cross-origin redirect points at the other origin", async () => {
			const res = await fetch(server.url("/redirect-cross"), {
				redirect: "manual",
			});
			assertEquals(res.headers.get("location"), `${server.origin2}/echo-headers`);
			await res.body?.cancel();
		});

		await t.step("/gzip is hand-compressed and the client decodes it", async () => {
			const res = await fetch(server.url("/gzip"));
			assertEquals(res.headers.get("content-encoding"), "gzip");
			const raw = Number(res.headers.get("x-raw-length"));
			const wire = Number(res.headers.get("content-length"));
			const decoded = await res.text();
			// the trap this fixture exists for: content-length is the WIRE size while
			// the reader yields DECODED bytes
			assertEquals(decoded.length, raw);
			assert(wire < raw, `wire ${wire} should be smaller than decoded ${raw}`);
		});

		await t.step("/cp1250 serves genuine windows-1250 bytes", async () => {
			const res = await fetch(server.url("/cp1250"));
			assertEquals(
				res.headers.get("content-type"),
				"text/html; charset=windows-1250",
			);
			const bytes = new Uint8Array(await res.arrayBuffer());
			assert(
				[...bytes].join(",").includes([...CP1250_WORD].join(",")),
				"cp1250 high bytes missing from the page",
			);
			assertEquals(
				new TextDecoder("windows-1250").decode(bytes).includes(CP1250_TEXT),
				true,
			);
		});

		await t.step("/big streams without a content-length", async () => {
			const res = await fetch(server.url("/big?bytes=50000&chunk=1000"));
			assertEquals(res.headers.get("content-length"), null);
			assertEquals((await res.arrayBuffer()).byteLength, 50000);
		});

		await t.step("token-keyed routes are per-token and counted", async () => {
			for (let i = 0; i < 3; i++) {
				const res = await fetch(server.url("/flaky?fails=2&token=a"));
				assertEquals(res.status, i < 2 ? 500 : 200);
				await res.body?.cancel();
			}
			// a different token starts from scratch
			const other = await fetch(server.url("/flaky?fails=2&token=b"));
			assertEquals(other.status, 500);
			await other.body?.cancel();
			assertEquals(server.hits("a", "/flaky"), 3);
			assertEquals(server.hits("b", "/flaky"), 1);
		});

		await t.step("/etag answers 304 to a matching If-None-Match", async () => {
			const first = await fetch(server.url("/etag?token=e"));
			assertEquals(first.headers.get("etag"), '"v1"');
			await first.body?.cancel();
			const second = await fetch(server.url("/etag?token=e"), {
				headers: { "if-none-match": '"v1"' },
			});
			assertEquals(second.status, 304);
			assertEquals(second.body, null);
		});

		await t.step("/hang never answers until the request is aborted", async () => {
			const ctrl = new AbortController();
			const pending = fetch(server.url("/hang?token=h"), { signal: ctrl.signal });
			const raced = await Promise.race([
				pending.then(() => "answered"),
				new Promise((r) => setTimeout(() => r("still hanging"), 60)),
			]);
			assertEquals(raced, "still hanging");
			ctrl.abort();
			await pending.catch(() => {});
		});
	} finally {
		// the kill switch must release /hang, otherwise this would deadlock
		await server.shutdown();
	}
});

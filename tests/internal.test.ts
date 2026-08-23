import { assert, assertEquals, assertNotEquals, assertStrictEquals } from "@std/assert";
import { assertRejects } from "@std/assert";
import { createBodyResult, ensureRequestId, shortId } from "../src/internal.ts";
import { PageFetchError } from "../src/errors.ts";

Deno.test("ensureRequestId stamps an id, is idempotent, never mutates the input", () => {
	const req = { url: "http://x/" };
	const a = ensureRequestId(req);
	assert(a.requestId.length > 0);
	assertEquals((req as { requestId?: string }).requestId, undefined);

	// idempotent: an existing id wins and the object is passed through as-is
	const b = ensureRequestId(a);
	assertStrictEquals(b, a);

	assertNotEquals(ensureRequestId({ url: "http://x/" }).requestId, a.requestId);
});

Deno.test("shortId truncates and tolerates a missing id", () => {
	assertEquals(shortId("0123456789abcdef"), "01234567");
	assertEquals(shortId(undefined), "????????");
});

Deno.test("createBodyResult: bytes are handed back as-is, decode is memoized", async () => {
	const bytes = new TextEncoder().encode("hello");
	const body = createBodyResult(bytes, { url: "http://x/" });
	assert(body.hasBody);
	assertStrictEquals(await body.bytes(), bytes); // no copy per call
	assertEquals(await body.text(), "hello");
	assertStrictEquals(await body.text(), await body.text());
});

Deno.test("createBodyResult decodes with the given charset", async () => {
	// "čšžůá" in windows-1250 — not producible via TextEncoder (utf-8 only)
	const cp1250 = new Uint8Array([0xe8, 0x9a, 0x9e, 0xf9, 0xe1]);
	const body = createBodyResult(cp1250, { url: "http://x/", charset: "windows-1250" });
	assertEquals(await body.text(), "čšžůá");
});

Deno.test("createBodyResult falls back to utf-8 for an unknown charset label", async () => {
	const body = createBodyResult(new TextEncoder().encode("ok"), {
		url: "http://x/",
		charset: "x-bogus-label",
	});
	assertEquals(await body.text(), "ok");
});

Deno.test("createBodyResult(null) rejects both accessors with kind no-body", async () => {
	for (
		const reason of ["retain-body", "skip-body", "head", "not-modified"] as const
	) {
		const body = createBodyResult(null, {
			url: "http://x/",
			requestId: "rid",
			absentReason: reason,
		});
		assert(!body.hasBody);
		for (const read of [() => body.bytes(), () => body.text()]) {
			const e = await assertRejects(read, PageFetchError);
			assertEquals(e.kind, "no-body");
			assertEquals(e.retryable, false);
			assertEquals(e.requestId, "rid");
			assertEquals(e.details?.reason, reason);
		}
	}
});

Deno.test("createBodyResult(null) defaults the absence reason to retain-body", async () => {
	const body = createBodyResult(null, { url: "http://x/" });
	const e = await assertRejects(() => body.text(), PageFetchError);
	assertEquals(e.details?.reason, "retain-body");
});

Deno.test("an empty body is still a body", async () => {
	const body = createBodyResult(new Uint8Array(0), { url: "http://x/" });
	assert(body.hasBody);
	assertEquals(await body.text(), "");
});

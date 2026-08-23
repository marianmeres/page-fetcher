import { assert, assertEquals, assertFalse, assertStrictEquals } from "@std/assert";
import {
	defaultRetryable,
	PageFetchError,
	type PageFetchErrorKind,
} from "../src/errors.ts";

const ALL_KINDS: PageFetchErrorKind[] = [
	"network",
	"timeout",
	"deadline",
	"aborted",
	"http",
	"too-large",
	"unsupported-type",
	"too-many-redirects",
	"browser",
	"decode",
	"circuit-open",
	"no-body",
];

Deno.test("every kind is constructible and carries a non-empty default message", () => {
	for (const kind of ALL_KINDS) {
		const e = new PageFetchError({ kind, url: "http://x/" });
		assertEquals(e.kind, kind);
		assertEquals(e.name, "PageFetchError");
		assertEquals(e.url, "http://x/");
		assert(e.message.length > 0, `empty default message for ${kind}`);
		assert(e.message.includes("http://x/"), `message for ${kind} omits the url`);
		assert(e instanceof Error);
	}
});

Deno.test("retryable defaults follow the classification table", () => {
	const retryable: PageFetchErrorKind[] = ["network", "timeout", "browser"];
	const notRetryable: PageFetchErrorKind[] = [
		"deadline",
		"aborted",
		"too-large",
		"unsupported-type",
		"too-many-redirects",
		"decode",
		"circuit-open",
		"no-body",
	];
	for (const kind of retryable) {
		assert(new PageFetchError({ kind, url: "http://x/" }).retryable, kind);
	}
	for (const kind of notRetryable) {
		assertFalse(new PageFetchError({ kind, url: "http://x/" }).retryable, kind);
	}
});

Deno.test("http kind is retryable per status: 408, 425, 429 and 5xx only", () => {
	for (const status of [408, 425, 429, 500, 502, 503, 504, 599]) {
		assert(defaultRetryable("http", status), `${status} should be retryable`);
		assert(new PageFetchError({ kind: "http", url: "http://x/", status }).retryable);
	}
	for (const status of [400, 401, 403, 404, 409, 410, 418, 451, 600]) {
		assertFalse(
			defaultRetryable("http", status),
			`${status} should not be retryable`,
		);
	}
	// no status at all -> nothing to justify a retry
	assertFalse(defaultRetryable("http", undefined));
});

Deno.test("explicit retryable overrides the per-kind default", () => {
	assertFalse(
		new PageFetchError({ kind: "network", url: "http://x/", retryable: false })
			.retryable,
	);
	assert(
		new PageFetchError({ kind: "no-body", url: "http://x/", retryable: true })
			.retryable,
	);
});

Deno.test("init fields are carried through; attempts defaults to 0", () => {
	const cause = new Error("boom");
	const e = new PageFetchError({
		kind: "too-large",
		url: "http://x/a",
		message: "custom",
		status: 200,
		finalUrl: "http://x/b",
		requestId: "rid",
		attempts: 3,
		cause,
		details: { maxBytes: 10, read: 11 },
	});
	assertEquals(e.message, "custom");
	assertEquals(e.status, 200);
	assertEquals(e.finalUrl, "http://x/b");
	assertEquals(e.requestId, "rid");
	assertEquals(e.attempts, 3);
	assertStrictEquals(e.cause, cause);
	assertEquals(e.details, { maxBytes: 10, read: 11 });

	assertEquals(new PageFetchError({ kind: "network", url: "http://x/" }).attempts, 0);
});

Deno.test("is() accepts our own instances and realm-foreign look-alikes", () => {
	assert(PageFetchError.is(new PageFetchError({ kind: "network", url: "http://x/" })));

	// what a duplicated module instance (JSR + npm in one graph) produces
	const foreign = Object.assign(new Error("foreign"), {
		name: "PageFetchError",
		kind: "timeout",
		url: "http://x/",
	});
	assert(PageFetchError.is(foreign));

	assertFalse(PageFetchError.is(new Error("plain")));
	assertFalse(PageFetchError.is(new TypeError("Unknown adapter")));
	assertFalse(PageFetchError.is({ name: "PageFetchError", kind: "http", url: "u" }));
	assertFalse(PageFetchError.is(null));
	assertFalse(PageFetchError.is("network"));
});

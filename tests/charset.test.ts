import { assert, assertEquals } from "@std/assert";
import {
	decodeText,
	detectBom,
	isSupportedEncoding,
	sniffCharset,
	sniffMetaCharset,
} from "../src/charset.ts";
import {
	DEFAULT_ALLOW_CONTENT_TYPES,
	isAllowedContentType,
	isMetaSniffable,
	parseContentType,
} from "../src/content-type.ts";
import { createHttpAdapter } from "../src/adapters/http.ts";
import { startFixtureServer } from "./fixtures/server.ts";
import { concatBytes, CP1250_TEXT, cp1250Page, UTF8_BOM } from "./fixtures/bytes.ts";
import { recordingLogger } from "./helpers.ts";

const enc = (s: string) => new TextEncoder().encode(s);

Deno.test("parseContentType lowercases, strips params and unquotes charset", () => {
	assertEquals(parseContentType("TEXT/HTML; Charset=WINDOWS-1250; foo=bar"), {
		mime: "text/html",
		charset: "windows-1250",
	});
	assertEquals(parseContentType('text/html; charset="utf-8"'), {
		mime: "text/html",
		charset: "utf-8",
	});
	assertEquals(parseContentType("application/json"), { mime: "application/json" });
	assertEquals(parseContentType(null), {});
	assertEquals(parseContentType(""), {});
	// not a mime at all
	assertEquals(parseContentType("nonsense"), {});
});

Deno.test("the default allow-list covers plain json and xml suffixes", () => {
	const allowed = [
		"text/html",
		"application/xhtml+xml",
		"text/plain",
		"application/xml",
		"text/xml",
		"application/json",
		"application/ld+json",
		"application/rss+xml",
	];
	for (const mime of allowed) {
		assert(
			isAllowedContentType(mime, DEFAULT_ALLOW_CONTENT_TYPES),
			`${mime} should be allowed by default`,
		);
	}
	for (const mime of ["application/octet-stream", "image/png", "application/pdf"]) {
		assert(
			!isAllowedContentType(mime, DEFAULT_ALLOW_CONTENT_TYPES),
			`${mime} should not be allowed by default`,
		);
	}
	assert(isAllowedContentType("TEXT/HTML", DEFAULT_ALLOW_CONTENT_TYPES));
});

Deno.test("meta sniffing is limited to html/xml family mimes", () => {
	assert(isMetaSniffable("text/html"));
	assert(isMetaSniffable("application/rss+xml"));
	assert(isMetaSniffable(undefined));
	assert(!isMetaSniffable("application/json"));
	assert(!isMetaSniffable("text/plain"));
});

Deno.test("detectBom recognizes utf-8 and both utf-16 marks", () => {
	assertEquals(detectBom(concatBytes(UTF8_BOM, enc("x"))), "utf-8");
	assertEquals(detectBom(new Uint8Array([0xff, 0xfe, 0x41, 0x00])), "utf-16le");
	assertEquals(detectBom(new Uint8Array([0xfe, 0xff, 0x00, 0x41])), "utf-16be");
	assertEquals(detectBom(enc("no bom here")), undefined);
	assertEquals(detectBom(new Uint8Array(0)), undefined);
});

Deno.test("sniffMetaCharset finds both meta spellings", () => {
	assertEquals(sniffMetaCharset(enc('<meta charset="ISO-8859-2">')), "iso-8859-2");
	assertEquals(
		sniffMetaCharset(
			enc('<meta http-equiv="content-type" content="text/html; charset=windows-1250">'),
		),
		"windows-1250",
	);
	assertEquals(sniffMetaCharset(enc("<html><body>nothing</body></html>")), undefined);
	// only the first ~2 KB is scanned
	assertEquals(
		sniffMetaCharset(enc(" ".repeat(3000) + '<meta charset="windows-1250">')),
		undefined,
	);
});

Deno.test("sniffCharset precedence: BOM > header > meta > fallback", () => {
	const withBom = concatBytes(UTF8_BOM, enc('<meta charset="windows-1250">'));
	assertEquals(
		sniffCharset(withBom, { headerCharset: "iso-8859-2", mime: "text/html" }),
		"utf-8",
	);
	assertEquals(
		sniffCharset(enc('<meta charset="iso-8859-2">'), {
			headerCharset: "windows-1250",
			mime: "text/html",
		}),
		"windows-1250",
	);
	assertEquals(
		sniffCharset(enc('<meta charset="windows-1250">'), { mime: "text/html" }),
		"windows-1250",
	);
	assertEquals(sniffCharset(enc("plain"), {}), "utf-8");
	assertEquals(
		sniffCharset(enc("plain"), { fallback: "windows-1250" }),
		"windows-1250",
	);
	// sniffMeta: false skips the meta level entirely
	assertEquals(
		sniffCharset(enc('<meta charset="windows-1250">'), {
			mime: "text/html",
			sniffMeta: false,
		}),
		"utf-8",
	);
});

Deno.test("an unknown label is skipped, never thrown, and is warned about", () => {
	assert(!isSupportedEncoding("x-bogus"));
	const logger = recordingLogger();
	// bogus header label -> falls through to the meta declaration
	assertEquals(
		sniffCharset(enc('<meta charset="windows-1250">'), {
			headerCharset: "x-bogus",
			mime: "text/html",
			logger,
		}),
		"windows-1250",
	);
	assert(logger.messages("warn").some((m) => m.includes("x-bogus")));
	// bogus everywhere -> utf-8, still no throw
	assertEquals(
		sniffCharset(enc("x"), { headerCharset: "x-bogus", fallback: "x-also-bogus" }),
		"utf-8",
	);
});

Deno.test("decodeText falls back to utf-8 and reports the charset it used", () => {
	assertEquals(decodeText(enc("hi"), "utf-8"), { text: "hi", charset: "utf-8" });
	const logger = recordingLogger();
	assertEquals(decodeText(enc("hi"), "x-bogus", logger), {
		text: "hi",
		charset: "utf-8",
	});
	assertEquals(logger.messages("warn").length, 1);
	// invalid byte sequences become U+FFFD instead of throwing
	assert(decodeText(new Uint8Array([0xff, 0xfe, 0x00]), "utf-8").text.includes("�"));
});

Deno.test("charset over the wire", async (t) => {
	const server = await startFixtureServer();
	const http = createHttpAdapter();
	try {
		await t.step("windows-1250 declared in the Content-Type header", async () => {
			const res = await http.fetch({ url: server.url("/cp1250") });
			assertEquals(res.charset, "windows-1250");
			assertEquals(res.contentType, "text/html");
			assert((await res.text()).includes(CP1250_TEXT));
		});

		await t.step("windows-1250 declared only in a meta tag", async () => {
			const res = await http.fetch({ url: server.url("/cp1250-meta") });
			assertEquals(res.charset, "windows-1250");
			assert((await res.text()).includes(CP1250_TEXT));
		});

		await t.step("utf-8 declared only via <meta charset>", async () => {
			const res = await http.fetch({ url: server.url("/meta-charset") });
			assertEquals(res.charset, "utf-8");
			assert((await res.text()).includes(CP1250_TEXT));
		});

		await t.step("a BOM outranks a (wrong) header charset", async () => {
			const res = await http.fetch({ url: server.url("/bom") });
			assertEquals(res.charset, "utf-8");
			const text = await res.text();
			assert(text.includes(CP1250_TEXT), "BOM lost to the stale header charset");
			assert(!text.startsWith("﻿"), "the BOM should be stripped from the text");
		});

		await t.step("decoding is memoized and bytes stay raw", async () => {
			const res = await http.fetch({ url: server.url("/cp1250") });
			const bytes = await res.bytes();
			assertEquals(bytes, cp1250Page());
			assertEquals(await res.text(), await res.text());
			assertEquals(res.size, bytes.length);
		});
	} finally {
		await server.shutdown();
	}
});

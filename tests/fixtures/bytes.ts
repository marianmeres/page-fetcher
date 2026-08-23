/**
 * Raw-byte fixtures. `TextEncoder` is utf-8 only (the WHATWG Encoding standard removed
 * the legacy encoders), so a windows-1250 page cannot be produced by encoding a JS
 * string — the high bytes have to be literals.
 */

/** `"čšžůá"` in windows-1250. */
export const CP1250_WORD: Uint8Array = new Uint8Array([0xe8, 0x9a, 0x9e, 0xf9, 0xe1]);

/** What {@linkcode CP1250_WORD} must decode to. */
export const CP1250_TEXT = "čšžůá";

/** utf-8 byte order mark. */
export const UTF8_BOM: Uint8Array = new Uint8Array([0xef, 0xbb, 0xbf]);

/** utf-16le byte order mark. */
export const UTF16LE_BOM: Uint8Array = new Uint8Array([0xff, 0xfe]);

const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Concatenate byte chunks into one buffer. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

/**
 * An HTML page whose high bytes are genuine windows-1250.
 *
 * ASCII bytes are identical in windows-1250 and utf-8, so the skeleton can be encoded
 * normally and spliced around {@linkcode CP1250_WORD}.
 *
 * @param opts.meta include a `<meta http-equiv>` declaring windows-1250 (for the
 * "no charset in the header" case)
 */
export function cp1250Page(opts: { meta?: boolean } = {}): Uint8Array {
	const metaTag = opts.meta
		? `<meta http-equiv="content-type" content="text/html; charset=windows-1250">`
		: "";
	return concatBytes(
		ascii(
			`<!doctype html><html><head>${metaTag}<title>cp1250</title></head><body><p>`,
		),
		CP1250_WORD,
		ascii(`</p></body></html>`),
	);
}

/** A utf-8 page that declares its charset only via `<meta charset>`. */
export function metaCharsetPage(text = CP1250_TEXT): Uint8Array {
	return ascii(
		`<!doctype html><html><head><meta charset="utf-8"><title>meta</title></head>` +
			`<body><p>${text}</p></body></html>`,
	);
}

/** A utf-8 page prefixed with a BOM and no charset declared anywhere else. */
export function bomPage(text = CP1250_TEXT): Uint8Array {
	return concatBytes(
		UTF8_BOM,
		ascii(
			`<!doctype html><html><head><title>bom</title></head><body><p>${text}</p></body></html>`,
		),
	);
}

/** gzip via `CompressionStream` — `Deno.serve` does not compress anything by itself. */
export async function gzipBytes(input: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([input as BlobPart]).stream()
		.pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

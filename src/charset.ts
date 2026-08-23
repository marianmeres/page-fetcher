/**
 * Charset detection and lenient decoding.
 *
 * Precedence is BOM → HTTP header → `<meta>` → fallback. That deviates from the design
 * sketch's header-first order and follows the WHATWG encoding standard (and every
 * browser) instead: a BOM is ground truth written by the encoder, while `charset=`
 * parameters are routinely stale server configuration.
 *
 * Nothing here ever throws: an unsupported label falls through to the next precedence
 * level and ultimately to utf-8.
 *
 * @module
 */

import type { Logger } from "./types.ts";

/** Where the winning charset came from. */
export type CharsetSource = "bom" | "header" | "meta" | "fallback";

/** Options of {@linkcode sniffCharset}. */
export interface SniffCharsetOptions {
	/** `charset` parameter from the `Content-Type` header, if any. */
	headerCharset?: string;
	/** Parsed mime — meta sniffing only runs for HTML/XML family documents. */
	mime?: string;
	/** Set `false` to skip the `<meta>` scan entirely. Default `true`. */
	sniffMeta?: boolean;
	/** Label used when nothing else is decidable. Default `"utf-8"`. */
	fallback?: string;
	/** Silent by default. */
	logger?: Logger;
}

/** How much of the body is scanned for a `<meta>` charset declaration. */
const META_SNIFF_BYTES = 2048;

/** Whether `TextDecoder` knows this label. */
export function isSupportedEncoding(label: string): boolean {
	try {
		new TextDecoder(label);
		return true;
	} catch {
		return false;
	}
}

/** Byte order marks, longest first. */
const BOMS: { bytes: number[]; label: string }[] = [
	{ bytes: [0xef, 0xbb, 0xbf], label: "utf-8" },
	{ bytes: [0xff, 0xfe], label: "utf-16le" },
	{ bytes: [0xfe, 0xff], label: "utf-16be" },
];

/** The label implied by a leading byte order mark, if there is one. */
export function detectBom(bytes: Uint8Array): string | undefined {
	for (const { bytes: bom, label } of BOMS) {
		if (bytes.length < bom.length) continue;
		if (bom.every((b, i) => bytes[i] === b)) return label;
	}
	return undefined;
}

/**
 * Find a `<meta charset>` / `<meta http-equiv="content-type">` declaration in the first
 * ~2 KB. The prefix is ASCII-decoded, which is safe for every encoding this matters for
 * (all ASCII-compatible).
 */
export function sniffMetaCharset(bytes: Uint8Array): string | undefined {
	const head = new TextDecoder("utf-8").decode(
		bytes.subarray(0, META_SNIFF_BYTES),
	);
	for (
		const re of [
			/<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_:.\-]+)/i,
			/<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([a-z0-9_:.\-]+)/i,
		]
	) {
		const m = head.match(re);
		if (m?.[1]) return m[1].toLowerCase();
	}
	return undefined;
}

/**
 * Decide which charset label to decode with.
 *
 * Candidates that `TextDecoder` does not know are skipped (with a `warn`), so the
 * return value is always a usable label.
 *
 * @example
 * ```ts
 * sniffCharset(bytes, { headerCharset: "windows-1250", mime: "text/html" });
 * // "windows-1250"
 * ```
 */
export function sniffCharset(bytes: Uint8Array, opts: SniffCharsetOptions = {}): string {
	const { logger } = opts;

	const take = (
		label: string | undefined,
		source: CharsetSource,
	): string | undefined => {
		if (!label) return undefined;
		if (!isSupportedEncoding(label)) {
			logger?.warn(`unknown charset label "${label}" from ${source}, ignoring`);
			return undefined;
		}
		logger?.debug(`charset "${label}" (from ${source})`);
		return label;
	};

	const fromBom = take(detectBom(bytes), "bom");
	if (fromBom) return fromBom;

	const fromHeader = take(opts.headerCharset, "header");
	if (fromHeader) return fromHeader;

	if (opts.sniffMeta !== false) {
		const fromMeta = take(sniffMetaCharset(bytes), "meta");
		if (fromMeta) return fromMeta;
	}

	const fallback = opts.fallback ?? "utf-8";
	return take(fallback, "fallback") ?? "utf-8";
}

/**
 * Decode bytes with the given label, never throwing: an unknown label falls back to
 * utf-8, and invalid byte sequences become U+FFFD.
 *
 * @returns the text and the charset actually used
 */
export function decodeText(
	bytes: Uint8Array,
	label: string,
	logger?: Logger,
): { text: string; charset: string } {
	try {
		return { text: new TextDecoder(label).decode(bytes), charset: label };
	} catch {
		logger?.warn(`unknown charset label "${label}", decoding as utf-8`);
		return { text: new TextDecoder("utf-8").decode(bytes), charset: "utf-8" };
	}
}

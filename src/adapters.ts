/**
 * Adapters — the things that actually perform I/O at the bottom of a layer stack.
 *
 * Flat barrel, kept in sync with the `deno.json` exports map and the npm build's entry
 * points. See {@linkcode createHttpAdapter}.
 *
 * @module
 */

export {
	createHttpAdapter,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_REDIRECTS,
	DEFAULT_USER_AGENT,
} from "./adapters/http.ts";
export type { HttpAdapterOptions } from "./adapters/http.ts";

export {
	DEFAULT_ALLOW_CONTENT_TYPES,
	isAllowedContentType,
	isMetaSniffable,
	parseContentType,
} from "./content-type.ts";
export type { ParsedContentType } from "./content-type.ts";

export {
	decodeText,
	detectBom,
	isSupportedEncoding,
	sniffCharset,
	sniffMetaCharset,
} from "./charset.ts";
export type { CharsetSource, SniffCharsetOptions } from "./charset.ts";

export { readBodyLimited } from "./read-body.ts";
export type { ReadBodyOptions } from "./read-body.ts";

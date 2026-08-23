/**
 * Content-type parsing and the allow-list policy.
 *
 * Like {@link readBodyLimited} these are in-adapter helpers rather than layers: the
 * policy has to be decided *before* the body is read.
 *
 * @module
 */

/**
 * Default allow-list.
 *
 * The design sketch's list plus `application/json` and `+xml`: read literally as a
 * suffix rule, `+json` does not match plain `application/json` (no `+` in its subtype),
 * so the most common JSON mime would have been rejected by the defaults. `+xml` keeps
 * `application/rss+xml` and friends working out of the box for the same reason.
 */
export const DEFAULT_ALLOW_CONTENT_TYPES: string[] = [
	"text/html",
	"application/xhtml+xml",
	"text/plain",
	"application/xml",
	"text/xml",
	"application/json",
	"+json",
	"+xml",
];

/** Result of {@linkcode parseContentType}. */
export interface ParsedContentType {
	/** Lowercased mime without parameters, e.g. `"text/html"`. */
	mime?: string;
	/** Lowercased `charset` parameter, unquoted. */
	charset?: string;
}

/**
 * Parse a `Content-Type` header.
 *
 * @example
 * ```ts
 * parseContentType("TEXT/HTML; Charset=WINDOWS-1250; foo=bar");
 * // { mime: "text/html", charset: "windows-1250" }
 * ```
 */
export function parseContentType(header: string | null | undefined): ParsedContentType {
	if (!header) return {};
	const [first, ...params] = header.split(";");
	const mime = first.trim().toLowerCase();
	const out: ParsedContentType = mime.includes("/") ? { mime } : {};
	for (const param of params) {
		const eq = param.indexOf("=");
		if (eq < 0) continue;
		if (param.slice(0, eq).trim().toLowerCase() !== "charset") continue;
		const value = param.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
		if (value) out.charset = value.toLowerCase();
	}
	return out;
}

/**
 * Is `mime` covered by the allow-list?
 *
 * Entries are either an exact mime (`"text/html"`) or a subtype suffix (`"+json"`,
 * matching `application/ld+json`). Everything is compared lowercased.
 */
export function isAllowedContentType(mime: string, allow: string[]): boolean {
	const m = mime.toLowerCase();
	return allow.some((entry) => {
		const e = entry.toLowerCase();
		return e.startsWith("+") ? m.endsWith(e) : m === e;
	});
}

/**
 * Whether a `<meta charset>` sniff makes sense for this mime — i.e. HTML/XML family
 * documents. Sniffing a JSON or plain-text body for meta tags would be nonsense.
 */
export function isMetaSniffable(mime: string | undefined): boolean {
	if (!mime) return true; // no header at all: cannot rule it out, so try
	return mime === "text/html" ||
		mime === "application/xhtml+xml" ||
		mime === "text/xml" ||
		mime === "application/xml" ||
		mime.endsWith("+xml");
}

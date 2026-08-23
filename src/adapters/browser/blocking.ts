/**
 * Resource blocking — the single biggest throughput lever the browser adapter has.
 *
 * A page fetcher wants the DOM, not the pixels. Dropping images, media, fonts and
 * stylesheets removes the large majority of a typical page's requests and bytes while
 * leaving the serialized DOM identical, which is why blocking is **on by default**
 * here. It is a real behavior change, not a pure optimization: a script that measures
 * layout or reads computed styles can take a different branch without its stylesheets,
 * so `blockResources: false` restores full fidelity when a page needs it.
 *
 * @module
 */

/**
 * Normalized resource types.
 *
 * Both drivers report lowercase strings; anything outside this list (Playwright and
 * Puppeteer each have a few extras, and Chrome adds new ones over time) is treated as
 * `"other"`.
 */
export type ResourceKind =
	/** The navigation itself. Never blocked, whatever the options say. */
	| "document"
	| "stylesheet"
	| "image"
	| "media"
	| "font"
	| "script"
	| "texttrack"
	| "xhr"
	| "fetch"
	| "eventsource"
	| "websocket"
	| "manifest"
	| "other";

/** The kinds blocked unless you say otherwise. */
export const DEFAULT_BLOCKED_RESOURCES: readonly ResourceKind[] = [
	"image",
	"media",
	"font",
	"stylesheet",
];

/**
 * A URL test: a `RegExp` (tested against the full URL) or a predicate.
 *
 * No glob syntax — that would need a matcher dependency, and this package has none.
 * `URLPattern` is not available on every supported runtime either; pass one wrapped in
 * an arrow function if you have it.
 */
export type UrlPredicate = RegExp | ((url: string) => boolean);

/** Resource-blocking options, accepted per adapter and per request. */
export interface BlockingOptions {
	/**
	 * Resource kinds to drop. `false` disables blocking entirely.
	 * Default {@linkcode DEFAULT_BLOCKED_RESOURCES}.
	 */
	blockResources?: false | readonly ResourceKind[];
	/** Additionally block URLs matching any of these. */
	blockUrls?: readonly UrlPredicate[];
	/** When set, block everything that matches **none** of these. */
	allowUrls?: readonly UrlPredicate[];
}

/** What {@linkcode compileRequestFilter} produces — a `DriverPage.setRequestFilter` argument. */
export type RequestFilter = (
	req: { url: string; resourceType: string },
) => "abort" | "continue";

/** Test one URL against a predicate list. */
function matchesAny(predicates: readonly UrlPredicate[], url: string): boolean {
	for (const predicate of predicates) {
		if (typeof predicate === "function") {
			if (predicate(url)) return true;
		} else {
			// a /g or /y regex carries state between calls; reset so the same
			// predicate cannot answer differently for the same URL
			predicate.lastIndex = 0;
			if (predicate.test(url)) return true;
		}
	}
	return false;
}

/**
 * Compile the options into the filter installed on a page.
 *
 * Evaluation order, first verdict wins:
 * 1. `document` requests always continue — blocking the navigation itself would fail
 *    the fetch rather than speed it up. (The driver interface reports frame documents
 *    as `"document"` too, so subframes ride along; blocking those is what `blockUrls`
 *    is for.)
 * 2. `blockResources` — the kind check.
 * 3. `allowUrls` — an allow-list, so anything unmatched is blocked.
 * 4. `blockUrls` — the exceptions to whatever survived.
 *
 * @example
 * ```ts
 * const filter = compileRequestFilter({
 * 	blockUrls: [/googletagmanager|doubleclick/, (u) => u.endsWith(".pdf")],
 * });
 * filter({ url: "https://x.test/a.png", resourceType: "image" }); // "abort"
 * ```
 */
export function compileRequestFilter(options: BlockingOptions = {}): RequestFilter {
	const { blockResources = DEFAULT_BLOCKED_RESOURCES, blockUrls, allowUrls } = options;
	const kinds = blockResources === false ? null : new Set<string>(blockResources);

	return ({ url, resourceType }): "abort" | "continue" => {
		if (resourceType === "document") return "continue";
		if (kinds?.has(resourceType)) return "abort";
		if (allowUrls?.length && !matchesAny(allowUrls, url)) return "abort";
		if (blockUrls?.length && matchesAny(blockUrls, url)) return "abort";
		return "continue";
	};
}

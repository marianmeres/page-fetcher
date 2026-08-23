/**
 * The single error type of `@marianmeres/page-fetcher`.
 *
 * One class with a discriminating `kind` — not a class hierarchy — so callers and the
 * retry policy can branch without matching message strings.
 *
 * @module
 */

/** Discriminant of {@linkcode PageFetchError}. */
export type PageFetchErrorKind =
	/** DNS, ECONNRESET, TLS, or a request shape the transport cannot send. */
	| "network"
	/** Per-attempt timeout elapsed. */
	| "timeout"
	/** Total deadline exceeded. */
	| "deadline"
	/** The caller's `AbortSignal` fired. */
	| "aborted"
	/** Non-2xx response, when the caller opted into throwing (`throwOnHttpError`). */
	| "http"
	/** Body exceeded `maxBytes`. */
	| "too-large"
	/** Content type not in the allow-list and the policy is `"error"`. */
	| "unsupported-type"
	/** Redirect cap hit, or a redirect loop detected. */
	| "too-many-redirects"
	/** Browser launch / crash / navigation failure. */
	| "browser"
	/**
	 * Decoding failed. Reserved: the default charset pipeline is lenient (unknown
	 * labels fall back to utf-8 rather than throwing), so v1 never produces this kind
	 * on the HTTP path — it exists for adapters that decode strictly.
	 */
	| "decode"
	/** The circuit breaker refused the request locally; the host was never contacted. */
	| "circuit-open"
	/** The body is intentionally absent and was read anyway (see `details.reason`). */
	| "no-body";

/** Constructor argument of {@linkcode PageFetchError}. */
export interface PageFetchErrorInit {
	/** What went wrong. */
	kind: PageFetchErrorKind;
	/** The requested URL. */
	url: string;
	/** Human-readable message. Defaults to a description derived from `kind` and `url`. */
	message?: string;
	/** HTTP status, when one was received. */
	status?: number;
	/** URL of the final response, when redirects were followed before failing. */
	finalUrl?: string;
	/** Correlation id of the logical request, when one was assigned. */
	requestId?: string;
	/** Attempts made. Default `0` — thrown before any attempt ran. */
	attempts?: number;
	/** Overrides the per-kind default (see {@linkcode defaultRetryable}). */
	retryable?: boolean;
	/** Underlying error, passed through as the standard `cause`. */
	cause?: unknown;
	/**
	 * Kind-specific extras, e.g. `{ host, until }` for `circuit-open`,
	 * `{ maxBytes, read }` for `too-large`, `{ reason }` for `no-body`.
	 */
	details?: Record<string, unknown>;
}

/** HTTP statuses that are worth another attempt. */
function isRetryableStatus(status: number | undefined): boolean {
	if (status === undefined) return false;
	return status === 408 || status === 425 || status === 429 ||
		(status >= 500 && status <= 599);
}

/**
 * The default `retryable` flag for a given kind (the DESIGN §6 classification table).
 *
 * `http` is status-dependent: 408, 425, 429 and 5xx are retryable, every other status
 * is not. Retrying a redirect loop, an oversized body or a locally refused request
 * cannot help, so those are all `false`.
 */
export function defaultRetryable(
	kind: PageFetchErrorKind,
	status?: number,
): boolean {
	switch (kind) {
		case "network":
		case "timeout":
		case "browser":
			return true;
		case "http":
			return isRetryableStatus(status);
		default:
			return false;
	}
}

function defaultMessage(init: PageFetchErrorInit): string {
	const { kind, url, status } = init;
	switch (kind) {
		case "network":
			return `Network error fetching ${url}`;
		case "timeout":
			return `Timed out fetching ${url}`;
		case "deadline":
			return `Deadline exceeded fetching ${url}`;
		case "aborted":
			return `Aborted fetching ${url}`;
		case "http":
			return `HTTP ${status ?? "error"} fetching ${url}`;
		case "too-large":
			return `Response body too large fetching ${url}`;
		case "unsupported-type":
			return `Unsupported content type fetching ${url}`;
		case "too-many-redirects":
			return `Too many redirects fetching ${url}`;
		case "browser":
			return `Browser error fetching ${url}`;
		case "decode":
			return `Failed to decode response body from ${url}`;
		case "circuit-open":
			return `Circuit open, refusing to fetch ${url}`;
		case "no-body":
			return `Response body was not retained for ${url}`;
	}
}

/**
 * Every failure this package throws.
 *
 * @example
 * ```ts
 * import { createFetcher, PageFetchError } from "@marianmeres/page-fetcher";
 *
 * const fetcher = createFetcher();
 * const soon: string[] = [];
 * const later: string[] = [];
 *
 * try {
 * 	await fetcher.fetch("https://example.com/");
 * } catch (e) {
 * 	if (!PageFetchError.is(e)) throw e;
 * 	// the whole host is fenced off — come back to it much later
 * 	if (e.kind === "circuit-open") later.push(e.url);
 * 	else if (e.retryable) soon.push(e.url);
 * 	else console.warn(`dropped ${e.url}: ${e.message}`);
 * }
 * ```
 */
export class PageFetchError extends Error {
	/** Always `"PageFetchError"` — what {@linkcode PageFetchError.is} matches on. */
	override readonly name = "PageFetchError";
	/** What went wrong. Branch on this, never on the message. */
	readonly kind: PageFetchErrorKind;
	/** The requested URL. */
	readonly url: string;
	/** HTTP status, when one was received. */
	readonly status?: number;
	/** URL of the final response, when redirects were followed before failing. */
	readonly finalUrl?: string;
	/** Correlation id of the logical request, when one was assigned. */
	readonly requestId?: string;
	/** Attempts made before giving up. */
	readonly attempts: number;
	/** Whether another attempt could plausibly succeed. */
	readonly retryable: boolean;
	/** Kind-specific extras. */
	readonly details?: Record<string, unknown>;

	/**
	 * Build an error.
	 *
	 * @param init Everything the error carries. `retryable` and `message` fall back to
	 * the per-kind defaults ({@linkcode defaultRetryable} and a derived description).
	 */
	constructor(init: PageFetchErrorInit) {
		super(init.message ?? defaultMessage(init), { cause: init.cause });
		this.kind = init.kind;
		this.url = init.url;
		this.status = init.status;
		this.finalUrl = init.finalUrl;
		this.requestId = init.requestId;
		this.attempts = init.attempts ?? 0;
		this.retryable = init.retryable ?? defaultRetryable(init.kind, init.status);
		this.details = init.details;
	}

	/**
	 * Realm-safe type guard — use this instead of `instanceof` in cross-package code.
	 *
	 * `instanceof` breaks when the same package is present twice in one module graph
	 * (JSR + npm resolved side by side, or a bundler duplicating a module instance).
	 */
	static is(e: unknown): e is PageFetchError {
		if (e instanceof PageFetchError) return true;
		return e instanceof Error &&
			(e as { name?: unknown }).name === "PageFetchError" &&
			typeof (e as { kind?: unknown }).kind === "string" &&
			typeof (e as { url?: unknown }).url === "string";
	}
}

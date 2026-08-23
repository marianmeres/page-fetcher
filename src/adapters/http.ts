/**
 * The plain-`fetch` adapter: a thin, observable wrapper over the platform `fetch`.
 *
 * Redirects are followed manually (`redirect: "manual"`) so the chain is recordable and
 * cappable, the body is streamed with a hard byte budget instead of being buffered
 * blindly, and the charset is decided from bytes + headers rather than assumed.
 *
 * @module
 */

import { sniffCharset } from "../charset.ts";
import {
	DEFAULT_ALLOW_CONTENT_TYPES,
	isAllowedContentType,
	isMetaSniffable,
	parseContentType,
} from "../content-type.ts";
import { PageFetchError } from "../errors.ts";
import {
	abortErrorFrom,
	createBodyResult,
	ensureRequestId,
	type IdentifiedRequest,
	isAbortError,
	shortId,
	withAttempts,
} from "../internal.ts";
import { readBodyLimited } from "../read-body.ts";
import type {
	Adapter,
	BodyAbsentReason,
	BodyFactory,
	FetchRequest,
	FetchResult,
	HttpMethod,
	ObservabilityOptions,
	ReplayableBody,
	UnsupportedTypePolicy,
} from "../types.ts";

/**
 * Default `User-Agent`.
 *
 * Deliberately identifies the tool and carries a contact URL — the platform defaults
 * (`Deno/x.y.z`, `node`) are useless for polite crawling. Override it with your own
 * contact address when you run this against sites you do not own.
 */
export const DEFAULT_USER_AGENT =
	"marianmeres-page-fetcher (+https://github.com/marianmeres/page-fetcher)";

/** Default body budget: 10 MiB of **decoded** bytes. */
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/** Default redirect cap. */
export const DEFAULT_MAX_REDIRECTS = 5;

/** Statuses that are redirects. Note 304 is 3xx but never a redirect. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Options of {@linkcode createHttpAdapter}. */
export interface HttpAdapterOptions extends ObservabilityOptions {
	/** Adapter name, reported as `FetchResult.adapter`. Default `"http"`. */
	name?: string;
	/** Platform `fetch` to use. Injectable so unit tests need no sockets. */
	fetch?: typeof globalThis.fetch;
	/** Adapter-level default headers. Request headers win over these. */
	headers?: Record<string, string>;
	/**
	 * `User-Agent` used when neither the adapter nor the request sets one.
	 * `false` leaves the platform's own UA untouched.
	 */
	userAgent?: string | false;
	/** Redirect cap. Default {@linkcode DEFAULT_MAX_REDIRECTS}. */
	maxRedirects?: number;
	/**
	 * Maximum **decoded** body bytes. Default {@linkcode DEFAULT_MAX_BYTES}.
	 *
	 * Decoded, not wire bytes: the platform decompresses transparently, so a gzipped
	 * response yields more bytes than `Content-Length` advertises.
	 */
	maxBytes?: number;
	/**
	 * Allowed content types (exact mimes and `"+suffix"` entries).
	 * `null` disables the check. Default {@linkcode DEFAULT_ALLOW_CONTENT_TYPES}.
	 */
	allowContentTypes?: string[] | null;
	/** What to do with a disallowed type. Default `"error"` — loud beats silent. */
	onUnsupportedType?: UnsupportedTypePolicy;
	/** Default for `FetchRequest.retainBody`. Default `true`. */
	retainBody?: boolean;
	/** Charset used when nothing else is decidable. Default `"utf-8"`. */
	charsetFallback?: string;
	/** Scan the first ~2 KB for a `<meta charset>` declaration. Default `true`. */
	sniffMeta?: boolean;
}

/** Merge header sources; later sources win, matching case-insensitively. */
function mergeHeaders(...sources: (Record<string, string> | undefined)[]): Headers {
	const headers = new Headers();
	for (const source of sources) {
		for (const [k, v] of Object.entries(source ?? {})) headers.set(k, v);
	}
	return headers;
}

/** Produce this attempt's body value; a factory is invoked once per attempt/hop. */
function materializeBody(body: ReplayableBody | BodyFactory): BodyInit {
	return (typeof body === "function" ? (body as BodyFactory)() : body) as BodyInit;
}

/**
 * Create the HTTP adapter.
 *
 * A non-2xx response is **not** an error here — it resolves with `ok: false`, because
 * crawlers need 404s and 500s as data. Throwing on them is a composition-layer opt-in.
 *
 * @example
 * ```ts
 * const http = createHttpAdapter({ maxBytes: 2_000_000 });
 * const res = await http.fetch({ url: "https://example.com/" });
 * console.log(res.status, res.finalUrl, (await res.text()).length);
 * ```
 */
export function createHttpAdapter(options: HttpAdapterOptions = {}): Adapter {
	const {
		name = "http",
		fetch: platformFetch = globalThis.fetch,
		userAgent,
		maxRedirects = DEFAULT_MAX_REDIRECTS,
		maxBytes = DEFAULT_MAX_BYTES,
		allowContentTypes = DEFAULT_ALLOW_CONTENT_TYPES,
		onUnsupportedType = "error",
		charsetFallback = "utf-8",
		sniffMeta = true,
		logger,
	} = options;

	async function httpFetch(req: IdentifiedRequest): Promise<FetchResult> {
		const requestId = req.requestId;
		const rid = shortId(requestId);
		const startedAt = Date.now();
		const url0 = req.url;

		let origin0: string;
		try {
			origin0 = new URL(url0).origin;
		} catch (cause) {
			throw new PageFetchError({
				kind: "network",
				url: url0,
				requestId,
				attempts: 1,
				retryable: false,
				message: `Invalid URL: ${url0}`,
				cause,
			});
		}

		const headers = mergeHeaders(options.headers, req.headers);
		if (userAgent !== false && !headers.has("user-agent")) {
			headers.set("user-agent", userAgent ?? DEFAULT_USER_AGENT);
		}

		let method: HttpMethod = req.method ?? "GET";
		let body = req.body;
		let current = url0;
		const redirects: string[] = [];
		const visited = new Set<string>([`${method} ${url0}`]);

		let res!: Response;
		let headersAt = startedAt;

		// ---- redirect loop -------------------------------------------------------
		for (;;) {
			if (req.signal?.aborted) {
				throw abortErrorFrom(req.signal, { url: current, requestId });
			}
			logger?.debug(`[${rid}] ${method} ${current}`);

			const init: RequestInit = {
				method,
				headers,
				redirect: "manual",
				signal: req.signal,
			};
			if (body !== undefined && method === "POST") {
				init.body = materializeBody(body);
			}

			try {
				res = await platformFetch(current, init);
			} catch (cause) {
				if (PageFetchError.is(cause)) throw cause;
				if (isAbortError(cause) || req.signal?.aborted) {
					throw abortErrorFrom(req.signal, { url: current, requestId, cause });
				}
				throw new PageFetchError({
					kind: "network",
					url: url0,
					finalUrl: current,
					requestId,
					attempts: 1,
					cause,
				});
			}
			headersAt = Date.now();

			const location = res.headers.get("location");
			if (!REDIRECT_STATUSES.has(res.status) || !location) break;

			let next: string | undefined;
			try {
				next = new URL(location, current).href;
			} catch {
				// browsers error here; a crawler is better served by the data it has
				logger?.warn(
					`[${rid}] malformed Location "${location}" at ${current}; ` +
						`treating the ${res.status} as the final response`,
				);
				break;
			}

			// the redirect body is real and readable — release the connection
			await res.body?.cancel().catch(() => {});

			if (redirects.length >= maxRedirects) {
				throw new PageFetchError({
					kind: "too-many-redirects",
					url: url0,
					finalUrl: current,
					status: res.status,
					requestId,
					attempts: 1,
					retryable: false,
					message: `Exceeded maxRedirects (${maxRedirects}) fetching ${url0}`,
					details: { maxRedirects, chain: [...redirects, current] },
				});
			}

			// method rewrite, mirroring the WHATWG fetch algorithm
			let nextMethod = method;
			if (res.status === 303 && method !== "HEAD") nextMethod = "GET";
			else if ((res.status === 301 || res.status === 302) && method === "POST") {
				nextMethod = "GET";
			} else if (res.status === 307 || res.status === 308) {
				if (body instanceof ReadableStream) {
					throw new PageFetchError({
						kind: "network",
						url: url0,
						finalUrl: current,
						status: res.status,
						requestId,
						attempts: 1,
						retryable: false,
						message:
							`Non-replayable body (ReadableStream) on a ${res.status} redirect ` +
							`from ${current} — pass a body factory instead`,
					});
				}
			}
			if (nextMethod !== method) {
				method = nextMethod;
				body = undefined;
				headers.delete("content-type");
			}

			const key = `${method} ${next}`;
			if (visited.has(key)) {
				throw new PageFetchError({
					kind: "too-many-redirects",
					url: url0,
					finalUrl: current,
					status: res.status,
					requestId,
					attempts: 1,
					retryable: false,
					message: `Redirect loop detected fetching ${url0} (back to ${next})`,
					details: { chain: [...redirects, current], repeated: next },
				});
			}
			visited.add(key);

			// credentials never cross an origin boundary — compared against the
			// ORIGINAL origin, and once dropped they stay dropped
			if (new URL(next).origin !== origin0) {
				for (const h of ["authorization", "cookie"]) {
					if (headers.has(h)) {
						headers.delete(h);
						logger?.debug(
							`[${rid}] dropped ${h} on cross-origin hop to ${next}`,
						);
					}
				}
			}

			logger?.debug(`[${rid}] ${res.status} ${current} -> ${next}`);
			redirects.push(current);
			current = next;
		}

		// ---- final response ------------------------------------------------------
		const { mime, charset: headerCharset } = parseContentType(
			res.headers.get("content-type"),
		);
		const retainBody = req.retainBody ?? options.retainBody ?? true;
		const isHead = method === "HEAD";

		let bytes: Uint8Array | null = null;
		let absentReason: BodyAbsentReason | undefined;
		let charset: string | undefined;
		let size: number | undefined;

		const discard = async (reason: BodyAbsentReason) => {
			await res.body?.cancel().catch(() => {});
			absentReason = reason;
		};

		if (
			allowContentTypes && mime && !isHead &&
			!isAllowedContentType(mime, allowContentTypes)
		) {
			await res.body?.cancel().catch(() => {});
			if (onUnsupportedType === "error") {
				throw new PageFetchError({
					kind: "unsupported-type",
					url: url0,
					finalUrl: current,
					status: res.status,
					requestId,
					attempts: 1,
					retryable: false,
					message: `Unsupported content type "${mime}" fetching ${current}`,
					details: { contentType: mime, allow: allowContentTypes },
				});
			}
			logger?.warn(`[${rid}] skipping body of unsupported content type "${mime}"`);
			absentReason = "skip-body";
		} else if (isHead) {
			await discard("head");
		} else if (res.status === 304) {
			await discard("not-modified");
		} else if (!retainBody) {
			logger?.debug(`[${rid}] retainBody: false — discarding the body`);
			await discard("retain-body");
		} else {
			// Content-Length fast-fail, but only when nothing was compressed: under
			// Content-Encoding the header reports the WIRE size while the reader yields
			// decoded bytes, so the comparison would be meaningless.
			const encoding = (res.headers.get("content-encoding") ?? "identity")
				.toLowerCase();
			const contentLength = res.headers.get("content-length");
			const declared = contentLength === null ? NaN : Number(contentLength);
			if (
				encoding === "identity" && Number.isFinite(declared) &&
				declared > maxBytes
			) {
				await res.body?.cancel().catch(() => {});
				logger?.debug(
					`[${rid}] content-length ${declared} > maxBytes ${maxBytes}`,
				);
				throw new PageFetchError({
					kind: "too-large",
					url: url0,
					finalUrl: current,
					status: res.status,
					requestId,
					attempts: 1,
					retryable: false,
					message:
						`Declared Content-Length (${declared}) exceeds maxBytes (${maxBytes}) fetching ${current}`,
					details: { maxBytes, contentLength: declared },
				});
			}

			bytes = await readBodyLimited(res.body, {
				maxBytes,
				url: current,
				requestId,
				signal: req.signal,
				logger,
			});
			size = bytes.length;
			charset = sniffCharset(bytes, {
				headerCharset,
				mime,
				sniffMeta: sniffMeta && isMetaSniffable(mime),
				fallback: charsetFallback,
				logger,
			});
		}

		const endedAt = Date.now();
		const bodyResult = createBodyResult(bytes, {
			url: url0,
			requestId,
			charset,
			absentReason,
		});

		return {
			ok: res.status >= 200 && res.status < 300,
			url: url0,
			finalUrl: current,
			status: res.status,
			statusText: res.statusText || undefined,
			headers: res.headers,
			redirects,
			requestId,
			hasBody: bodyResult.hasBody,
			text: bodyResult.text,
			bytes: bodyResult.bytes,
			contentType: mime,
			charset,
			size,
			fromCache: false,
			notModified: false,
			timing: {
				startedAt,
				endedAt,
				total: endedAt - startedAt,
				ttfb: headersAt - startedAt,
				download: endedAt - headersAt,
			},
			attempts: 1,
			adapter: name,
			meta: req.meta,
		};
	}

	return {
		name,
		fetch: async (input: FetchRequest): Promise<FetchResult> => {
			const req = ensureRequestId(input);
			try {
				return await httpFetch(req);
			} catch (e) {
				// one attempt was made — say so, whichever helper constructed the error
				if (PageFetchError.is(e)) throw withAttempts(e, 1);
				// an abort can also surface from the body reader, after the headers
				if (isAbortError(e) || req.signal?.aborted) {
					throw withAttempts(
						abortErrorFrom(req.signal, {
							url: req.url,
							requestId: req.requestId,
							cause: e,
						}),
						1,
					);
				}
				// the platform reports transport failures as plain TypeErrors — never
				// leak those, they are fetch outcomes and the retry layer must classify them
				throw new PageFetchError({
					kind: "network",
					url: req.url,
					requestId: req.requestId,
					attempts: 1,
					cause: e,
				});
			}
		},
	};
}

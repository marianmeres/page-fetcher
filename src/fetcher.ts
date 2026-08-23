/**
 * `createFetcher` — the convenience that wires the default stack.
 *
 * Nothing here is privileged: every layer it composes is exported and usable on its
 * own, and the whole function is one {@linkcode compose} call plus option plumbing. Use
 * it when the defaults suit you; hand-roll the stack when they do not.
 *
 * The wired order, outermost → innermost, and why each layer sits where it does:
 *
 * ```
 * circuit breaker   optional, off by default — refuses before any I/O, and above retry
 *                   so one logical request counts once, however many attempts it made
 * events            the terminal onResponse/onError pair, exactly once per request;
 *                   below the breaker, whose refusals deliberately stay silent
 * http error guard  optional — turns a non-2xx into a throw. Above retry so retry
 *                   still sees the result and can honor its Retry-After header
 * deadline guard    spans every attempt and the sleeps between them, so: above retry
 * retry             owns the attempt loop, the sleeps, the attempts counter, and the
 *                   per-attempt onRequest/onRetry events
 * timeout guard     below retry, so the per-attempt budget re-arms on every attempt
 * routing           terminal: picks the adapter and calls it
 * ```
 *
 * The cache layer will slot in above the breaker (a cache hit must cost nothing and
 * depend on nothing, an open circuit included).
 *
 * @module
 */

import { createHttpAdapter } from "./adapters/http.ts";
import { type CircuitBreakerOptions, createCircuitBreaker } from "./circuit-breaker.ts";
import { compose } from "./compose.ts";
import { createEventsLayer } from "./events.ts";
import { deadlineGuard, httpErrorGuard, timeoutGuard } from "./guards.ts";
import { ensureRequestId, shortId } from "./internal.ts";
import { createRetry, type RetryOptions } from "./retry.ts";
import type {
	Adapter,
	FetchFn,
	FetchLayer,
	FetchRequest,
	FetchResult,
	ObservabilityOptions,
} from "./types.ts";
import { resolveDeadline } from "./utils.ts";

/** Options of {@linkcode createFetcher}. */
export interface CreateFetcherOptions extends ObservabilityOptions {
	/**
	 * The I/O backends. Default: a single {@linkcode createHttpAdapter}. The **first**
	 * adapter is the default route; the rest are reachable by name.
	 */
	adapters?: Adapter | Adapter[];
	/**
	 * Routing hook, consulted when the request carries no explicit `adapter`.
	 * Return `undefined` to fall back to the default adapter.
	 */
	selectAdapter?(req: FetchRequest): string | undefined;
	/**
	 * Retry policy. Default: on, with the {@linkcode RetryOptions} defaults.
	 *
	 * `false` means a single attempt — note that the layer itself stays in the stack,
	 * because it owns the attempt loop and therefore the per-attempt `onRequest` event.
	 */
	retry?: RetryOptions | false;
	/**
	 * Per-host circuit breaker. Default: **off**. `true` enables it with the
	 * {@linkcode CircuitBreakerOptions} defaults.
	 *
	 * Off by default because it is the one layer that refuses requests you asked for;
	 * a crawler hitting a few hundred hosts should turn it on, a script fetching one
	 * page has no use for it.
	 */
	circuitBreaker?: CircuitBreakerOptions | boolean;
	/** Default per-attempt timeout in ms, used when the request sets none. */
	timeout?: number;
	/** Default overall deadline, used when the request sets none. */
	deadline?: number | Date;
	/** Default request headers. Per-request headers win, matched case-insensitively. */
	headers?: Record<string, string>;
	/**
	 * Convenience for a default `User-Agent` header — applied unless the request or
	 * `headers` already sets one. Applies to every adapter, unlike an adapter's own
	 * `userAgent` option.
	 */
	userAgent?: string;
	/**
	 * Turn a non-2xx result into a thrown `PageFetchError` (`kind: "http"`, the whole
	 * result on `details.result`). Default `false` — a 404 is data, not an exception.
	 */
	throwOnHttpError?: boolean;
}

/**
 * A wired stack plus the adapters it owns.
 *
 * Disposable: `await using fetcher = createFetcher()` tears the adapters down at the
 * end of the scope on any runtime with `Symbol.asyncDispose` (Deno, Node ≥ 20.4).
 */
export interface Fetcher {
	/** Fetch by URL, with the rest of the request as an optional second argument. */
	fetch(url: string, init?: Omit<FetchRequest, "url">): Promise<FetchResult>;
	/** Fetch a fully-formed request. */
	fetch(req: FetchRequest): Promise<FetchResult>;
	/**
	 * Dispose every adapter. Idempotent, and never throws: an adapter that fails to
	 * dispose is logged and skipped, because disposal usually runs in a `finally` and
	 * must not mask the error that got you there.
	 */
	dispose(): Promise<void>;
	/** Alias of {@linkcode Fetcher.dispose}, for `await using`. */
	[Symbol.asyncDispose](): Promise<void>;
}

/** Merge header sources into a plain record; later sources win, case-insensitively. */
function mergeHeaders(
	...sources: (Record<string, string> | undefined)[]
): Record<string, string> | undefined {
	if (!sources.some((s) => s && Object.keys(s).length)) return undefined;
	const headers = new Headers();
	for (const source of sources) {
		for (const [k, v] of Object.entries(source ?? {})) headers.set(k, v);
	}
	return Object.fromEntries(headers);
}

/**
 * Wire the default stack.
 *
 * @example
 * ```ts
 * await using fetcher = createFetcher({
 * 	timeout: 10_000,
 * 	retry: { attempts: 4 },
 * 	circuitBreaker: true,
 * 	events: { onRetry: (i) => console.warn(`retry ${i.attempt} of ${i.url}`) },
 * });
 *
 * const res = await fetcher.fetch("https://example.com/");
 * console.log(res.status, res.finalUrl, (await res.text()).length);
 * ```
 */
export function createFetcher(options: CreateFetcherOptions = {}): Fetcher {
	const {
		adapters,
		selectAdapter,
		retry,
		circuitBreaker,
		timeout,
		deadline: defaultDeadline,
		headers: defaultHeaders,
		userAgent,
		throwOnHttpError,
		events,
		logger,
	} = options;

	// ---- adapters ------------------------------------------------------------
	const list = adapters === undefined
		? [createHttpAdapter({ logger, events })]
		: Array.isArray(adapters)
		? adapters
		: [adapters];
	if (!list.length) {
		throw new TypeError("createFetcher: `adapters` must not be empty");
	}
	const byName = new Map<string, Adapter>();
	for (const adapter of list) {
		if (byName.has(adapter.name)) {
			throw new TypeError(
				`createFetcher: duplicate adapter name "${adapter.name}"`,
			);
		}
		byName.set(adapter.name, adapter);
	}
	const defaultAdapter = list[0].name;

	// ---- terminal: routing ---------------------------------------------------
	const route: FetchFn = (req: FetchRequest): Promise<FetchResult> => {
		const name = req.adapter ?? selectAdapter?.(req) ?? defaultAdapter;
		const adapter = byName.get(name);
		if (!adapter) {
			// a config error, not a fetch outcome: it must fail loudly and must never
			// be retried or counted against the host (both layers pass it through)
			throw new TypeError(
				`Unknown adapter "${name}". Available: ${[...byName.keys()].join(", ")}`,
			);
		}
		logger?.debug(`[${shortId(req.requestId)}] adapter "${name}" ${req.url}`);
		return adapter.fetch(req);
	};

	// ---- the stack, outermost first ------------------------------------------
	const layers: FetchLayer[] = [];

	if (circuitBreaker) {
		const opts: CircuitBreakerOptions = circuitBreaker === true ? {} : circuitBreaker;
		layers.push(createCircuitBreaker({
			...opts,
			logger: opts.logger ?? logger,
			events: opts.events ?? events,
		}));
	}

	layers.push(createEventsLayer({ events, logger }));

	if (throwOnHttpError) layers.push(httpErrorGuard({ logger }));

	layers.push(deadlineGuard({ logger }));

	const retryOptions: RetryOptions = retry === false ? { attempts: 1 } : retry ?? {};
	layers.push(createRetry({
		...retryOptions,
		logger: retryOptions.logger ?? logger,
		events: retryOptions.events ?? events,
	}));

	layers.push(timeoutGuard({ defaultTimeout: timeout, logger }));

	const pipeline = compose(layers, route);

	// ---- lifecycle -----------------------------------------------------------
	let disposed = false;
	let disposal: Promise<void> | undefined;

	async function runDispose(): Promise<void> {
		logger?.debug(`[fetcher] disposing ${list.length} adapter(s)`);
		const outcomes = await Promise.allSettled(
			list.map((adapter) => adapter.dispose?.()),
		);
		outcomes.forEach((outcome, i) => {
			if (outcome.status === "rejected") {
				logger?.warn(
					`[fetcher] adapter "${
						list[i].name
					}" failed to dispose: ${outcome.reason}`,
				);
			}
		});
		logger?.debug("[fetcher] disposed");
	}

	function dispose(): Promise<void> {
		disposed = true;
		// memoized, not just flagged: a second caller must await real completion
		return (disposal ??= runDispose());
	}

	// ---- the outer wrapper ---------------------------------------------------
	function fetchImpl(
		input: string | FetchRequest,
		init: Omit<FetchRequest, "url"> = {},
	): Promise<FetchResult> {
		if (disposed) {
			// a usage error, not a fetch outcome — deliberately not a PageFetchError
			return Promise.reject(new Error("Fetcher is disposed"));
		}
		const base: FetchRequest = typeof input === "string"
			? { ...init, url: input }
			: input;
		if (!base || typeof base.url !== "string" || !base.url) {
			return Promise.reject(
				new TypeError("Fetcher.fetch: `url` must be a non-empty string"),
			);
		}

		// mergeHeaders lowercases every key, so this lookup is the whole
		// case-insensitivity story
		let headers = mergeHeaders(defaultHeaders, base.headers);
		if (userAgent && !headers?.["user-agent"]) {
			headers = { "user-agent": userAgent, ...headers };
		}

		// anchored once, here: every layer below sees an absolute instant and none of
		// them can restart the clock
		const deadlineAt = resolveDeadline(base.deadline ?? defaultDeadline);

		return pipeline(ensureRequestId({
			...base,
			headers,
			deadline: deadlineAt === undefined ? undefined : new Date(deadlineAt),
		}));
	}

	const fetcher: Fetcher = {
		fetch: fetchImpl,
		dispose,
		[Symbol.asyncDispose]: dispose,
	};
	return fetcher;
}

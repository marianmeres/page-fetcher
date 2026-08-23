/**
 * The per-host circuit breaker.
 *
 * Stop hammering a host that is already down: after N consecutive failures the circuit
 * for that host opens and every further request to it is refused locally — no socket,
 * no timeout wait — until a cooldown elapses and a single probe request is let through
 * to test the water.
 *
 * Two placement rules make it behave. It belongs **above** the retry layer, so one
 * logical request contributes at most one failure count (and a local refusal is never
 * slept on and retried), and **below** the cache, so content already in hand is served
 * whatever the host's health.
 *
 * State lives in a `Map` inside the factory closure — per layer instance, hence per
 * fetcher. There is no module-level state: two fetchers never share a verdict about a
 * host unless you share the layer.
 *
 * @module
 */

import { PageFetchError } from "./errors.ts";
import { ensureRequestId, safeEmit, shortId } from "./internal.ts";
import type {
	FetchFn,
	FetchLayer,
	FetchRequest,
	FetchResult,
	ObservabilityOptions,
	RetryOutcome,
} from "./types.ts";

/** Consecutive failures before the circuit opens. */
export const DEFAULT_CIRCUIT_THRESHOLD = 5;

/** How long the circuit stays open before a probe is allowed, in ms. */
export const DEFAULT_CIRCUIT_COOLDOWN = 30_000;

/** Circuit state of one host. */
export type CircuitState =
	/** Requests flow; consecutive failures are being counted. */
	| "closed"
	/** Requests are refused locally until the cooldown elapses. */
	| "open"
	/** Cooldown elapsed; exactly one probe request is allowed through. */
	| "half-open";

/** Payload of {@linkcode CircuitBreakerOptions.onStateChange}. */
export interface CircuitStateChange {
	/** Host (including port) whose circuit changed. */
	host: string;
	/** The state just entered. */
	state: CircuitState;
	/** Epoch ms until which the circuit stays open. Set only for `"open"`. */
	until?: number;
	/** Consecutive failures counted for this host at the moment of the change. */
	failures: number;
	/** Correlation id of the request that triggered the change, when there was one. */
	requestId?: string;
}

/** Options of {@linkcode createCircuitBreaker}. */
export interface CircuitBreakerOptions extends ObservabilityOptions {
	/** Consecutive failures per host before opening. Default `5`. */
	threshold?: number;
	/** Open duration in ms before a half-open probe. Default `30_000`. */
	cooldown?: number;
	/**
	 * What counts as a failure. Replaces the built-in table entirely — wrap
	 * {@linkcode defaultIsFailure} to extend rather than replace it.
	 */
	isFailure?(outcome: RetryOutcome): boolean;
	/** Per-layer callback, fired on every state transition. */
	onStateChange?(info: CircuitStateChange): void;
}

/**
 * The built-in failure table: "is this host down?", not "did this request go well?".
 *
 * Failures are transport-level errors (`network`, `timeout`, `browser`) and 5xx —
 * server-side breakage the host is responsible for. Deliberately **not** failures:
 * every 4xx including 429 (the host is up and answering; rate limiting belongs to
 * retry/backoff, not to outage detection), and content-side rejections such as
 * `too-large` or `unsupported-type` (our policy, not their health).
 */
export function defaultIsFailure(outcome: RetryOutcome): boolean {
	if (outcome.error) {
		const { kind, status } = outcome.error;
		if (kind === "network" || kind === "timeout" || kind === "browser") return true;
		// the throwOnHttpError path turns a 503 into an `http` error
		return status !== undefined && status >= 500;
	}
	if (outcome.result) return outcome.result.status >= 500;
	return false;
}

/**
 * Outcomes that say nothing about the host: we gave up (or never asked), so they must
 * neither trip the breaker nor clear a suspicion it already holds.
 */
function isInconclusive(outcome: RetryOutcome): boolean {
	const kind = outcome.error?.kind;
	return kind === "aborted" || kind === "deadline" || kind === "circuit-open";
}

/** Per-host bookkeeping. Entries exist only for hosts that are not healthy. */
interface HostEntry {
	state: CircuitState;
	failures: number;
	/** Epoch ms; set while `state === "open"`. */
	until?: number;
	/** A half-open probe is in flight. */
	probing?: boolean;
}

/**
 * Refuse requests to a host that keeps failing.
 *
 * @example
 * ```ts
 * const fetchFn = createCircuitBreaker({ threshold: 3, cooldown: 10_000 })(
 * 	createRetry()(adapter.fetch),
 * );
 * ```
 */
export function createCircuitBreaker(options: CircuitBreakerOptions = {}): FetchLayer {
	const {
		threshold = DEFAULT_CIRCUIT_THRESHOLD,
		cooldown = DEFAULT_CIRCUIT_COOLDOWN,
		isFailure = defaultIsFailure,
		onStateChange,
		events,
		logger,
	} = options;

	/** Unhealthy hosts only — an entry is deleted the moment its host recovers. */
	const hosts = new Map<string, HostEntry>();

	function emitStateChange(info: CircuitStateChange): void {
		safeEmit(
			onStateChange as ((i: CircuitStateChange) => void) | undefined,
			logger,
			info,
		);
	}

	function open(host: string, entry: HostEntry, requestId: string): void {
		entry.state = "open";
		entry.until = Date.now() + cooldown;
		entry.probing = false;
		logger?.warn(
			`[${shortId(requestId)}] circuit open for "${host}" until ` +
				`${
					new Date(entry.until).toISOString()
				} (${entry.failures} consecutive failures)`,
		);
		emitStateChange({
			host,
			state: "open",
			until: entry.until,
			failures: entry.failures,
			requestId,
		});
		safeEmit(events?.onCircuitOpen, logger, { host, until: entry.until, requestId });
	}

	/** Fold one completed outcome into the host's state. */
	function settle(
		host: string,
		outcome: RetryOutcome,
		wasProbe: boolean,
		requestId: string,
	): void {
		const entry = hosts.get(host);
		const failed = isFailure(outcome);

		// nothing learned — release the probe slot and leave every counter alone
		if (!failed && isInconclusive(outcome)) {
			if (wasProbe && entry) entry.probing = false;
			return;
		}

		if (!failed) {
			// the host answered — it is healthy, whatever the status was
			if (!entry) return;
			hosts.delete(host);
			if (entry.state !== "closed") {
				logger?.debug(`[${shortId(requestId)}] circuit closed for "${host}"`);
				emitStateChange({ host, state: "closed", failures: 0, requestId });
			}
			return;
		}

		const next = entry ?? { state: "closed" as CircuitState, failures: 0 };
		next.failures++;
		hosts.set(host, next);

		if (wasProbe) {
			// the probe confirmed the host is still down — fresh cooldown
			open(host, next, requestId);
			return;
		}
		// a request that was already in flight when the circuit opened must not
		// extend the cooldown or re-announce the transition
		if (next.state === "closed" && next.failures >= threshold) {
			open(host, next, requestId);
		}
	}

	function refuse(host: string, entry: HostEntry, req: FetchRequest): never {
		const isOpen = entry.state === "open";
		throw new PageFetchError({
			kind: "circuit-open",
			url: req.url,
			requestId: req.requestId,
			attempts: 0,
			retryable: false,
			message: isOpen
				? `Circuit open for "${host}" until ` +
					`${
						new Date(entry.until!).toISOString()
					}, refusing to fetch ${req.url}`
				: `Circuit half-open for "${host}" — a probe request is already in ` +
					`flight, refusing to fetch ${req.url}`,
			details: isOpen
				? { host, state: entry.state, until: entry.until }
				: { host, state: entry.state },
		});
	}

	return (next: FetchFn): FetchFn =>
	async (input: FetchRequest): Promise<FetchResult> => {
		const req = ensureRequestId(input);
		const requestId = req.requestId;

		let host: string;
		try {
			// includes the port: two ports are two servers, and one being down says
			// nothing about the other
			host = new URL(req.url).host;
		} catch {
			// let the adapter produce the real error for a malformed URL
			return await next(req);
		}

		let isProbe = false;
		const entry = hosts.get(host);
		if (entry && entry.state !== "closed") {
			if (entry.state === "open" && Date.now() >= entry.until!) {
				// cooldown elapsed — this request becomes the single probe
				entry.state = "half-open";
				entry.probing = true;
				isProbe = true;
				logger?.debug(
					`[${shortId(requestId)}] circuit half-open for "${host}" — probing`,
				);
				emitStateChange({
					host,
					state: "half-open",
					failures: entry.failures,
					requestId,
				});
			} else if (entry.state === "half-open" && !entry.probing) {
				// the previous probe ended inconclusively (aborted) — take its slot
				entry.probing = true;
				isProbe = true;
			} else {
				refuse(host, entry, req);
			}
		}

		try {
			const result = await next(req);
			settle(host, { result }, isProbe, requestId);
			return result;
		} catch (e) {
			// TypeErrors and friends are programmer/config errors, not host health
			if (!PageFetchError.is(e)) {
				const current = hosts.get(host);
				if (isProbe && current) current.probing = false;
				throw e;
			}
			settle(host, { error: e }, isProbe, requestId);
			throw e;
		}
	};
}

import { assertEquals } from "@std/assert";
import * as mod from "../src/mod.ts";

// Type-level surface check: these must all be importable as types from the root.
// (Types are erased at runtime, so this is a compile-time assertion only.)
import type {
	Adapter,
	BackoffStrategy,
	BodyAbsentReason,
	BodyFactory,
	CircuitBreakerOptions,
	CircuitState,
	CircuitStateChange,
	CreateFetcherOptions,
	DeadlineGuardOptions,
	Fetcher,
	FetcherEvents,
	FetchFn,
	FetchLayer,
	FetchRequest,
	FetchResult,
	FetchTiming,
	HttpErrorGuardOptions,
	HttpMethod,
	Logger,
	ObservabilityOptions,
	PageFetchErrorInit,
	PageFetchErrorKind,
	ReplayableBody,
	RetryInfo,
	RetryOptions,
	RetryOutcome,
	TimeoutGuardOptions,
	UnsupportedTypePolicy,
} from "../src/mod.ts";

// one entry per imported type — kept in the same order, so a stale name is obvious
type _Surface = [
	Adapter,
	BackoffStrategy,
	BodyAbsentReason,
	BodyFactory,
	CircuitBreakerOptions,
	CircuitState,
	CircuitStateChange,
	CreateFetcherOptions,
	DeadlineGuardOptions,
	Fetcher,
	FetcherEvents,
	FetchFn,
	FetchLayer,
	FetchRequest,
	FetchResult,
	FetchTiming,
	HttpErrorGuardOptions,
	HttpMethod,
	Logger,
	ObservabilityOptions,
	PageFetchErrorInit,
	PageFetchErrorKind,
	ReplayableBody,
	RetryInfo,
	RetryOptions,
	RetryOutcome,
	TimeoutGuardOptions,
	UnsupportedTypePolicy,
];

Deno.test("mod.ts exports exactly the documented runtime surface", () => {
	// Guards against accidental API drift: adding a value export here is a deliberate
	// act that must be reflected in the docs.
	assertEquals(Object.keys(mod).sort(), [
		"DEFAULT_CIRCUIT_COOLDOWN",
		"DEFAULT_CIRCUIT_THRESHOLD",
		"PageFetchError",
		"compose",
		"composeSignal",
		"createCircuitBreaker",
		"createEventsLayer",
		"createFetcher",
		"createRetry",
		"deadlineGuard",
		"defaultIsFailure",
		"defaultIsRetryable",
		"defaultRetryable",
		"httpErrorGuard",
		"parseRetryAfter",
		"resolveDeadline",
		"safeEmit",
		"sleep",
		"timeoutGuard",
	]);
});

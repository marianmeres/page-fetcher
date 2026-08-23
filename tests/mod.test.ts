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
	DeadlineGuardOptions,
	FetcherEvents,
	FetchFn,
	FetchLayer,
	FetchRequest,
	FetchResult,
	FetchTiming,
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

type _Surface = [
	Adapter,
	BackoffStrategy,
	CircuitBreakerOptions,
	CircuitState,
	CircuitStateChange,
	DeadlineGuardOptions,
	RetryOptions,
	TimeoutGuardOptions,
	BodyAbsentReason,
	BodyFactory,
	FetcherEvents,
	FetchFn,
	FetchLayer,
	FetchRequest,
	FetchResult,
	FetchTiming,
	HttpMethod,
	Logger,
	ObservabilityOptions,
	BackoffStrategy,
	DeadlineGuardOptions,
	PageFetchErrorInit,
	PageFetchErrorKind,
	RetryOptions,
	TimeoutGuardOptions,
	ReplayableBody,
	RetryInfo,
	RetryOutcome,
	UnsupportedTypePolicy,
];

Deno.test("mod.ts exports exactly the documented runtime surface", () => {
	// Guards against accidental API drift: adding a value export here is a deliberate
	// act that must be reflected in the docs.
	assertEquals(Object.keys(mod).sort(), [
		"DEFAULT_CIRCUIT_COOLDOWN",
		"DEFAULT_CIRCUIT_THRESHOLD",
		"PageFetchError",
		"composeSignal",
		"createCircuitBreaker",
		"createRetry",
		"deadlineGuard",
		"defaultIsFailure",
		"defaultIsRetryable",
		"defaultRetryable",
		"parseRetryAfter",
		"resolveDeadline",
		"sleep",
		"timeoutGuard",
	]);
});

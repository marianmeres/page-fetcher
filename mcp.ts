/**
 * MCP tools exposed by `@marianmeres/page-fetcher`.
 *
 * Discovered and namespaced by the central `@marianmeres/mcp-server`. Every handler is
 * pure and synchronous in spirit — no tool here performs a fetch, launches a browser or
 * touches the filesystem.
 *
 * @module
 */

import { z } from "npm:zod";
import type { McpToolDefinition } from "jsr:@marianmeres/mcp-server/types";
import {
	DEFAULT_ALLOW_CONTENT_TYPES,
	isAllowedContentType,
	isMetaSniffable,
	parseContentType,
} from "./src/content-type.ts";
import { parseRetryAfter, rawBackoff } from "./src/retry.ts";
import type { BackoffStrategy } from "./src/retry.ts";

// ---------------------------------------------------------------------------
// generate-fetcher-setup
// ---------------------------------------------------------------------------

interface SetupOptions {
	adapter: "http" | "browser" | "both";
	driver: "playwright" | "puppeteer";
	browser: "chromium" | "firefox" | "webkit";
	cache: "none" | "dev" | "conditional";
	retryAttempts: number;
	circuitBreaker: boolean;
	timeout?: number;
	deadline?: number;
	throwOnHttpError: boolean;
	runtime: "deno" | "node";
}

/**
 * The composed layer order for a config.
 *
 * Mirrors the `layers.push(...)` sequence in `src/fetcher.ts` — `tests/mcp.test.ts`
 * pins the two together, so a reordering there fails a test rather than silently
 * making this tool lie.
 */
function layerOrder(o: SetupOptions): string[] {
	const layers: string[] = [];
	if (o.cache !== "none") layers.push(`createCacheLayer (mode: "${o.cache}")`);
	if (o.circuitBreaker) layers.push("createCircuitBreaker");
	layers.push("createEventsLayer");
	if (o.throwOnHttpError) layers.push("httpErrorGuard");
	layers.push("deadlineGuard");
	layers.push(
		o.retryAttempts <= 1
			? "createRetry (attempts: 1 — the layer stays in the stack, it owns the attempt loop)"
			: `createRetry (attempts: ${o.retryAttempts})`,
	);
	layers.push("timeoutGuard");
	layers.push("→ adapter routing (terminal)");
	return layers;
}

function generateSetup(o: SetupOptions): string {
	const wantsBrowser = o.adapter !== "http";
	const wantsHttp = o.adapter !== "browser";

	// ---- install hints ----
	const install: string[] = [
		o.runtime === "deno"
			? "// deno add jsr:@marianmeres/page-fetcher"
			: "// npm i @marianmeres/page-fetcher",
	];
	if (wantsBrowser) {
		install.push(
			o.runtime === "deno" ? `// deno add npm:${o.driver}` : `// npm i ${o.driver}`,
		);
	}

	// ---- imports ----
	const imports: string[] = [
		`import { createFetcher } from "@marianmeres/page-fetcher";`,
	];
	const adapterNames: string[] = [];
	if (wantsHttp) adapterNames.push("createHttpAdapter");
	if (wantsBrowser) {
		adapterNames.push("createBrowserAdapter", `${o.driver}Driver`);
	}
	const names = adapterNames.sort().join(", ");
	const oneLine = `import { ${names} } from "@marianmeres/page-fetcher/adapters";`;
	imports.push(
		// keep the emitted snippet inside a sane line width
		oneLine.length <= 90 ? oneLine : [
			"import {",
			...adapterNames.map((n) => `\t${n},`),
			`} from "@marianmeres/page-fetcher/adapters";`,
		].join("\n"),
	);
	if (o.cache !== "none") {
		imports.push(
			`import { createMemoryCache } from "@marianmeres/page-fetcher/cache";`,
		);
	}
	if (wantsBrowser) {
		// the browser is INJECTED — this package never imports one itself
		imports.push(
			o.driver === "playwright"
				? `import * as playwright from "playwright";`
				: `import puppeteer from "puppeteer";`,
		);
	}

	// ---- adapter list (the FIRST entry is the default route) ----
	const adapters: string[] = [];
	if (wantsHttp) adapters.push("\t\tcreateHttpAdapter(),");
	if (wantsBrowser) {
		const driverCall = o.driver === "playwright"
			? `playwrightDriver(playwright, { browser: "${o.browser}" })`
			: `puppeteerDriver(puppeteer)`;
		adapters.push(
			"\t\tcreateBrowserAdapter({",
			`\t\t\tdriver: ${driverCall},`,
			`\t\t\twait: "networkidle",`,
			"\t\t}),",
		);
	}

	// ---- createFetcher options ----
	const opts: string[] = ["\tadapters: [", ...adapters, "\t],"];
	if (o.cache !== "none") {
		opts.push(
			`\tcache: { store: createMemoryCache({ maxEntries: 500 }), mode: "${o.cache}" },`,
		);
	}
	if (o.circuitBreaker) opts.push("\tcircuitBreaker: true,");
	if (o.retryAttempts !== 3) {
		opts.push(
			o.retryAttempts <= 1
				? "\tretry: false,"
				: `\tretry: { attempts: ${o.retryAttempts} },`,
		);
	}
	if (o.timeout !== undefined) opts.push(`\ttimeout: ${o.timeout},`);
	if (o.deadline !== undefined) opts.push(`\tdeadline: ${o.deadline},`);
	if (o.throwOnHttpError) opts.push("\tthrowOnHttpError: true,");

	// ---- usage ----
	const fetchArgs = o.adapter === "both"
		? `"https://example.com/", { adapter: "browser" }`
		: `"https://example.com/"`;
	const usage: string[] = [`const res = await fetcher.fetch(${fetchArgs});`];
	if (!o.throwOnHttpError) {
		usage.push(
			"// a non-2xx response is data, not a throw — check `ok` yourself",
			"if (!res.ok) console.warn(`HTTP ${res.status} for ${res.finalUrl}`);",
		);
	}
	usage.push("console.log(res.finalUrl, (await res.text()).length);");

	const code = [
		...install,
		"",
		...imports,
		"",
		"// `await using` disposes every adapter (and any launched browser) at end of scope.",
		"// Use `const fetcher = createFetcher(...)` + `await fetcher.dispose()` if you need",
		"// it to outlive the block.",
		"await using fetcher = createFetcher({",
		...opts,
		"});",
		"",
		...usage,
	].join("\n");

	const order = layerOrder(o).map((n, i) => ` ${i + 1}. ${n}`).join("\n");

	const notes: string[] = [];
	if (wantsBrowser) {
		notes.push(
			`- The browser is injected, never imported by the package: you pass the ` +
				`${o.driver} module to ${o.driver}Driver().`,
		);
	}
	if (o.adapter === "both") {
		notes.push(
			`- The first adapter in the array ("http") is the default route; reach the ` +
				`other by name via \`{ adapter: "browser" }\`, or set \`selectAdapter(req)\` ` +
				`on createFetcher for automatic routing.`,
		);
	}
	if (o.cache === "dev") {
		notes.push(
			`- Cache mode "dev" serves any hit and never revalidates — right for iterating ` +
				`on extraction code, wrong against a live origin. Use "conditional" there.`,
		);
	}
	if (o.throwOnHttpError) {
		notes.push(
			`- throwOnHttpError turns a non-2xx into PageFetchError { kind: "http" }, with ` +
				`the whole result on \`details.result\`.`,
		);
	}

	return [
		code,
		"",
		"/* Composed layer order (outermost → innermost):",
		order,
		"*/",
		...(notes.length ? ["", "/* Notes:", ...notes, "*/"] : []),
	].join("\n");
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

/** The tools this package contributes to the central MCP server. */
export const tools: McpToolDefinition[] = [
	{
		name: "generate-fetcher-setup",
		description:
			"Generate a ready-to-run @marianmeres/page-fetcher `createFetcher` setup — " +
			"adapter choice (plain http, headless browser, or both), Playwright/Puppeteer " +
			"driver injection, cache mode, retry, circuit breaker and timeouts — plus the " +
			"resulting composed layer order. Use this instead of hand-writing the wiring: " +
			"the browser driver is injected by the caller and never imported by the " +
			"package, and the exports are split across three subpaths.",
		params: {
			adapter: z.enum(["http", "browser", "both"]).optional().describe(
				'Which adapter(s) to wire. "both" makes http the default route and the ' +
					'browser reachable by name. Default "http"',
			),
			driver: z.enum(["playwright", "puppeteer"]).optional().describe(
				'Browser driver, used when adapter is "browser" or "both". Default "playwright"',
			),
			browser: z.enum(["chromium", "firefox", "webkit"]).optional().describe(
				'Playwright engine. Ignored for puppeteer. Default "chromium"',
			),
			cache: z.enum(["none", "dev", "conditional"]).optional().describe(
				'Cache mode. "dev" serves any hit without revalidating; "conditional" ' +
					'revalidates with If-None-Match/If-Modified-Since. Default "none"',
			),
			retryAttempts: z.number().int().min(1).optional().describe(
				"Total attempts INCLUDING the first. 1 disables retrying. Default 3",
			),
			circuitBreaker: z.boolean().optional().describe(
				"Enable the per-host circuit breaker. Default false",
			),
			timeout: z.number().int().positive().optional().describe(
				"Default per-attempt timeout in ms",
			),
			deadline: z.number().int().positive().optional().describe(
				"Default overall deadline in ms, across all attempts",
			),
			throwOnHttpError: z.boolean().optional().describe(
				"Turn a non-2xx result into a thrown PageFetchError. Default false — a " +
					"404 is data, not an exception",
			),
			runtime: z.enum(["deno", "node"]).optional().describe(
				'Affects the install hint only. Default "deno"',
			),
		},
		// deno-lint-ignore require-await
		handler: async (args: Record<string, unknown>): Promise<string> => {
			return generateSetup({
				adapter: (args.adapter as SetupOptions["adapter"]) ?? "http",
				driver: (args.driver as SetupOptions["driver"]) ?? "playwright",
				browser: (args.browser as SetupOptions["browser"]) ?? "chromium",
				cache: (args.cache as SetupOptions["cache"]) ?? "none",
				retryAttempts: (args.retryAttempts as number) ?? 3,
				circuitBreaker: (args.circuitBreaker as boolean) ?? false,
				timeout: args.timeout as number | undefined,
				deadline: args.deadline as number | undefined,
				throwOnHttpError: (args.throwOnHttpError as boolean) ?? false,
				runtime: (args.runtime as SetupOptions["runtime"]) ?? "deno",
			});
		},
	},

	{
		name: "preview-retry-schedule",
		description:
			"Compute the actual retry delay schedule and worst-case wall time for a " +
			"@marianmeres/page-fetcher `createRetry` config — including the jitter range, " +
			"maxDelay capping and a Retry-After header override — and check whether it " +
			"fits inside a deadline. Use before setting retry options: `attempts` counts " +
			"the first try, exponential backoff is baseDelay * 2^(n-1), and backoff alone " +
			"can exhaust a deadline before any I/O completes.",
		params: {
			attempts: z.number().int().min(1).optional().describe(
				"Total attempts INCLUDING the first. Default 3 (so 2 retries)",
			),
			backoff: z.enum(["exponential", "linear", "fixed"]).optional().describe(
				'Backoff shape. exponential = base * 2^(n-1), linear = base * n, fixed = base. Default "exponential"',
			),
			baseDelay: z.number().int().min(0).optional().describe(
				"Base delay in ms. Default 500",
			),
			maxDelay: z.number().int().min(0).optional().describe(
				"Upper bound for any single delay, Retry-After included. Default 30000",
			),
			jitter: z.boolean().optional().describe(
				"Full jitter (random() * delay). Default true — each delay becomes a range",
			),
			retryAfterHeader: z.string().optional().describe(
				"A Retry-After header value (delay-seconds or an HTTP-date) to factor in; " +
					"it overrides the computed backoff when parseable",
			),
			respectRetryAfter: z.boolean().optional().describe(
				"Honor a Retry-After response header. Default true",
			),
			deadline: z.number().int().positive().optional().describe(
				"Overall deadline in ms, to check the schedule against",
			),
			method: z.string().optional().describe(
				'HTTP method, to flag the built-in "POST is never retried" rule. Default "GET"',
			),
		},
		// deno-lint-ignore require-await
		handler: async (args: Record<string, unknown>): Promise<string> => {
			const attempts = (args.attempts as number) ?? 3;
			const backoff =
				((args.backoff as string) ?? "exponential") as BackoffStrategy;
			const baseDelay = (args.baseDelay as number) ?? 500;
			const maxDelay = (args.maxDelay as number) ?? 30_000;
			const jitter = (args.jitter as boolean) ?? true;
			const method = ((args.method as string) ?? "GET").toUpperCase();
			const deadline = args.deadline as number | undefined;

			const respectRetryAfter = (args.respectRetryAfter as boolean) ?? true;
			const retryAfterMs = respectRetryAfter
				? parseRetryAfter(args.retryAfterHeader as string | undefined)
				: undefined;

			// mirrors computeDelay() in src/retry.ts: a server-directed Retry-After is
			// capped but NEVER jittered; only the computed backoff is
			const serverDirected = retryAfterMs !== undefined;
			const jittered = jitter && !serverDirected;

			const sleeps: Record<string, unknown>[] = [];
			let worstTotal = 0;
			for (let attempt = 1; attempt < attempts; attempt++) {
				const raw = retryAfterMs ??
					Math.max(0, rawBackoff(backoff, attempt, baseDelay));
				const capped = Math.min(raw, maxDelay);
				worstTotal += capped;
				sleeps.push({
					afterAttempt: attempt,
					delayMs: jittered ? { min: 0, max: capped } : capped,
					uncappedMs: raw,
					cappedByMaxDelay: raw > maxDelay,
					source: serverDirected ? "retry-after" : backoff,
				});
			}

			return JSON.stringify(
				{
					attempts,
					retries: Math.max(0, attempts - 1),
					sleeps,
					worstCaseSleepMs: worstTotal,
					jitter: jittered
						? "Full jitter: each delay is random() * delay, so worstCaseSleepMs " +
							"is an upper bound and the expected total is about half of it."
						: serverDirected && jitter
						? "Requested, but not applied: a server-directed Retry-After is " +
							"never jittered. Delays are exact."
						: "Disabled: delays are exact.",
					retryAfter: args.retryAfterHeader === undefined ? null : {
						header: args.retryAfterHeader,
						parsedMs: retryAfterMs ?? null,
						note: !respectRetryAfter
							? "Ignored: respectRetryAfter is false."
							: retryAfterMs === undefined
							? "Unparseable — the layer falls back to its own backoff."
							: "Overrides the computed backoff. Still capped by maxDelay, " +
								"and never jittered.",
					},
					methodRule: method === "POST"
						? "POST is NEVER retried by defaultIsRetryable — this schedule is " +
							"hypothetical unless you pass a custom isRetryable."
						: null,
					deadline: deadline === undefined ? null : {
						deadlineMs: deadline,
						fitsSleepOnly: worstTotal < deadline,
						warning: worstTotal >= deadline
							? "Backoff alone can exhaust the deadline before any I/O " +
								"completes; deadlineGuard will abort mid-schedule."
							: null,
					},
					note:
						"Sleep time only — each attempt's own request duration is on top.",
				},
				null,
				2,
			);
		},
	},

	{
		name: "check-content-type",
		description:
			"Parse a Content-Type header and check it against the @marianmeres/page-fetcher " +
			"allow-list — returns the mime, charset, whether the type is allowed, and " +
			"whether <meta charset> sniffing applies. Note the suffix rule that trips people " +
			"up: a '+json' entry does NOT match 'application/json' (no '+' in its subtype), " +
			"which is why the default list carries both.",
		params: {
			header: z.string().describe(
				'The raw Content-Type header value, e.g. "text/html; charset=windows-1250"',
			),
			allow: z.array(z.string()).optional().describe(
				'Custom allow-list: exact mimes ("text/html") or subtype suffixes ' +
					'("+json"). Defaults to DEFAULT_ALLOW_CONTENT_TYPES',
			),
		},
		// deno-lint-ignore require-await
		handler: async (args: Record<string, unknown>): Promise<string> => {
			const header = args.header as string;
			const allow = (args.allow as string[] | undefined) ??
				DEFAULT_ALLOW_CONTENT_TYPES;
			const parsed = parseContentType(header);
			const allowed = parsed.mime
				? isAllowedContentType(parsed.mime, allow)
				: false;

			return JSON.stringify(
				{
					header,
					mime: parsed.mime ?? null,
					charset: parsed.charset ?? null,
					allowed,
					metaSniffable: isMetaSniffable(parsed.mime),
					allowList: allow,
					consequence: allowed
						? "The adapter reads the body."
						: parsed.mime
						? "Rejected by the allow-list: with the adapter's default " +
							'onUnsupportedType "error" this throws PageFetchError ' +
							'{ kind: "unsupported-type" }; with "skip-body" the result ' +
							'resolves with hasBody: false and bodyAbsentReason "skip-body".'
						: "No parseable mime in the header — the adapter cannot match it " +
							"against the allow-list.",
				},
				null,
				2,
			);
		},
	},
];

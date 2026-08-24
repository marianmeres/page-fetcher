/**
 * Tests for `mcp.ts`.
 *
 * Gated out of `deno task test` (see the `--ignore` in `deno.json`) and run by
 * `deno task test:mcp` instead: `mcp.ts` imports `npm:zod` and the MCP server types,
 * and the default suite stays hermetic and dependency-free.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { tools } from "../../mcp.ts";

const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

function call(name: string, args: Record<string, unknown>): Promise<string> {
	const tool = byName[name];
	assert(tool, `no such tool: ${name}`);
	return tool.handler(args);
}

/** The layer names listed in a `generate-fetcher-setup` result, in order. */
function reportedLayers(output: string): string[] {
	const block = output.match(
		/Composed layer order \(outermost → innermost\):\n([\s\S]*?)\n\*\//,
	);
	assert(block, "no layer-order block in the output");
	return block[1]
		.split("\n")
		.map((l) => l.replace(/^\s*\d+\.\s*/, "").replace(/\s*\(.*$/, "").trim())
		.filter((l) => l && !l.startsWith("→"));
}

Deno.test("tool definitions are well-formed", () => {
	assert(tools.length > 0);
	for (const t of tools) {
		assert(/^[a-z0-9-]+$/.test(t.name), `bad tool name: ${t.name}`);
		assert(t.description.length > 40, `thin description: ${t.name}`);
		assert(Object.keys(t.params).length > 0, `no params: ${t.name}`);
	}
	assertEquals(new Set(tools.map((t) => t.name)).size, tools.length);
});

// ---------------------------------------------------------------------------
// generate-fetcher-setup
// ---------------------------------------------------------------------------

Deno.test("generate-fetcher-setup: layer order matches src/fetcher.ts", async () => {
	// the pin: scrape the real `layers.push(...)` sequence and compare it to what the
	// tool reports, so reordering the stack fails here instead of silently making the
	// tool lie
	const src = await Deno.readTextFile(
		fromFileUrl(import.meta.resolve("../../src/fetcher.ts")),
	);
	const actual = [...src.matchAll(/layers\.push\(\s*(\w+)\(/g)].map((m) => m[1]);

	const output = await call("generate-fetcher-setup", {
		cache: "dev",
		circuitBreaker: true,
		throwOnHttpError: true,
	});

	assertEquals(reportedLayers(output), actual);
	assertEquals(actual, [
		"createCacheLayer",
		"createCircuitBreaker",
		"createEventsLayer",
		"httpErrorGuard",
		"deadlineGuard",
		"createRetry",
		"timeoutGuard",
	]);
});

Deno.test("generate-fetcher-setup: optional layers drop out when off", async () => {
	const layers = reportedLayers(await call("generate-fetcher-setup", {}));
	assertEquals(layers, [
		"createEventsLayer",
		"deadlineGuard",
		"createRetry",
		"timeoutGuard",
	]);
});

Deno.test("generate-fetcher-setup: http-only emits no browser wiring", async () => {
	const out = await call("generate-fetcher-setup", {});
	assertStringIncludes(out, `import { createHttpAdapter }`);
	assert(!out.includes("playwright"), "leaked a browser import");
	assert(!out.includes("createBrowserAdapter"));
});

Deno.test("generate-fetcher-setup: the browser is injected, not imported", async () => {
	const pw = await call("generate-fetcher-setup", { adapter: "browser" });
	assertStringIncludes(pw, `import * as playwright from "playwright";`);
	assertStringIncludes(pw, "playwrightDriver(playwright,");

	const pptr = await call("generate-fetcher-setup", {
		adapter: "browser",
		driver: "puppeteer",
	});
	assertStringIncludes(pptr, `import puppeteer from "puppeteer";`);
	assertStringIncludes(pptr, "puppeteerDriver(puppeteer)");
});

Deno.test("generate-fetcher-setup: retry: false renders as a single attempt", async () => {
	const out = await call("generate-fetcher-setup", { retryAttempts: 1 });
	assertStringIncludes(out, "retry: false,");
	// the layer still sits in the stack — it owns the attempt loop
	assert(reportedLayers(out).includes("createRetry"));
});

Deno.test("generate-fetcher-setup: emitted lines stay within the line width", async () => {
	const out = await call("generate-fetcher-setup", { adapter: "both" });
	const code = out.split("\n/* Composed")[0];
	for (const line of code.split("\n")) {
		assert(line.length <= 90, `line too long (${line.length}): ${line}`);
	}
});

// ---------------------------------------------------------------------------
// preview-retry-schedule
// ---------------------------------------------------------------------------

Deno.test("preview-retry-schedule: exponential defaults", async () => {
	const r = JSON.parse(
		await call("preview-retry-schedule", { attempts: 4, jitter: false }),
	);
	assertEquals(r.retries, 3);
	assertEquals(r.sleeps.map((s: { delayMs: number }) => s.delayMs), [500, 1000, 2000]);
	assertEquals(r.worstCaseSleepMs, 3500);
});

Deno.test("preview-retry-schedule: linear and fixed shapes", async () => {
	const lin = JSON.parse(
		await call("preview-retry-schedule", {
			attempts: 4,
			backoff: "linear",
			jitter: false,
		}),
	);
	assertEquals(lin.sleeps.map((s: { delayMs: number }) => s.delayMs), [
		500,
		1000,
		1500,
	]);

	const fix = JSON.parse(
		await call("preview-retry-schedule", {
			attempts: 4,
			backoff: "fixed",
			jitter: false,
		}),
	);
	assertEquals(fix.sleeps.map((s: { delayMs: number }) => s.delayMs), [500, 500, 500]);
});

Deno.test("preview-retry-schedule: jitter reports a range, not a number", async () => {
	const r = JSON.parse(await call("preview-retry-schedule", { attempts: 2 }));
	assertEquals(r.sleeps[0].delayMs, { min: 0, max: 500 });
});

Deno.test("preview-retry-schedule: Retry-After is capped but never jittered", async () => {
	// mirrors computeDelay() in src/retry.ts — the server-directed path skips jitter
	const r = JSON.parse(
		await call("preview-retry-schedule", {
			attempts: 2,
			retryAfterHeader: "120", // 120s, over the 30s maxDelay
			jitter: true,
		}),
	);
	assertEquals(r.sleeps[0].delayMs, 30_000);
	assertEquals(r.sleeps[0].uncappedMs, 120_000);
	assertEquals(r.sleeps[0].cappedByMaxDelay, true);
	assertEquals(r.sleeps[0].source, "retry-after");
	assertStringIncludes(r.jitter, "never jittered");
});

Deno.test("preview-retry-schedule: respectRetryAfter: false ignores the header", async () => {
	const r = JSON.parse(
		await call("preview-retry-schedule", {
			attempts: 2,
			retryAfterHeader: "120",
			respectRetryAfter: false,
			jitter: false,
		}),
	);
	assertEquals(r.sleeps[0].delayMs, 500);
	assertEquals(r.sleeps[0].source, "exponential");
});

Deno.test("preview-retry-schedule: maxDelay caps the backoff", async () => {
	const r = JSON.parse(
		await call("preview-retry-schedule", {
			attempts: 6,
			baseDelay: 1000,
			maxDelay: 4000,
			jitter: false,
		}),
	);
	assertEquals(r.sleeps.map((s: { delayMs: number }) => s.delayMs), [
		1000,
		2000,
		4000,
		4000,
		4000,
	]);
	assertEquals(r.sleeps[3].cappedByMaxDelay, true);
});

Deno.test("preview-retry-schedule: flags the deadline it cannot fit in", async () => {
	const tight = JSON.parse(
		await call("preview-retry-schedule", { attempts: 5, deadline: 5000 }),
	);
	assertEquals(tight.worstCaseSleepMs, 7500);
	assertEquals(tight.deadline.fitsSleepOnly, false);
	assert(tight.deadline.warning);

	const roomy = JSON.parse(
		await call("preview-retry-schedule", { attempts: 5, deadline: 20_000 }),
	);
	assertEquals(roomy.deadline.fitsSleepOnly, true);
	assertEquals(roomy.deadline.warning, null);
});

Deno.test("preview-retry-schedule: flags the POST rule", async () => {
	const post = JSON.parse(
		await call("preview-retry-schedule", { attempts: 3, method: "post" }),
	);
	assertStringIncludes(post.methodRule, "NEVER retried");
	const get = JSON.parse(await call("preview-retry-schedule", { attempts: 3 }));
	assertEquals(get.methodRule, null);
});

Deno.test("preview-retry-schedule: attempts: 1 means no sleeps", async () => {
	const r = JSON.parse(await call("preview-retry-schedule", { attempts: 1 }));
	assertEquals(r.retries, 0);
	assertEquals(r.sleeps, []);
	assertEquals(r.worstCaseSleepMs, 0);
});

// ---------------------------------------------------------------------------
// check-content-type
// ---------------------------------------------------------------------------

Deno.test("check-content-type: parses mime and charset", async () => {
	const r = JSON.parse(
		await call("check-content-type", {
			header: "TEXT/HTML; Charset=WINDOWS-1250; foo=bar",
		}),
	);
	assertEquals(r.mime, "text/html");
	assertEquals(r.charset, "windows-1250");
	assertEquals(r.allowed, true);
	assertEquals(r.metaSniffable, true);
});

Deno.test("check-content-type: the '+json' suffix rule", async () => {
	// the whole reason this tool exists: '+json' does NOT match 'application/json'
	const suffixOnly = JSON.parse(
		await call("check-content-type", {
			header: "application/json",
			allow: ["+json"],
		}),
	);
	assertEquals(suffixOnly.allowed, false);

	const ld = JSON.parse(
		await call("check-content-type", {
			header: "application/ld+json",
			allow: ["+json"],
		}),
	);
	assertEquals(ld.allowed, true);

	// the default list carries both, so plain JSON is allowed out of the box
	const dflt = JSON.parse(
		await call("check-content-type", { header: "application/json" }),
	);
	assertEquals(dflt.allowed, true);
});

Deno.test("check-content-type: rejects a type outside the allow-list", async () => {
	const r = JSON.parse(
		await call("check-content-type", { header: "application/pdf" }),
	);
	assertEquals(r.allowed, false);
	assertEquals(r.metaSniffable, false);
	assertStringIncludes(r.consequence, "unsupported-type");
});

Deno.test("check-content-type: an unparseable header yields no mime", async () => {
	const r = JSON.parse(await call("check-content-type", { header: "garbage" }));
	assertEquals(r.mime, null);
	assertEquals(r.allowed, false);
	// no header at all cannot be ruled out, so sniffing stays on
	assertEquals(r.metaSniffable, true);
});

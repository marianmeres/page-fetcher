/**
 * Shared gate and driver loading for the flagged real-browser suite.
 *
 * Two things matter here and both are about **not** pulling a browser into the ordinary
 * test run:
 *
 * 1. This directory is `--ignore`d by `deno task test`, so its modules are neither run
 *    nor even imported there. That is the primary gate.
 * 2. The env check below is the belt to that pair of braces — it also covers someone
 *    running `deno test tests/` by hand. It queries the permission **before** reading
 *    the variable, so a permissionless run degrades to "suite skipped" instead of
 *    failing the file at collection with an uncaught `NotCapable`.
 *
 * The driver specifier is imported dynamically, inside a function, and is deliberately
 * absent from `deno.json`'s import map: `deno install` must never pre-cache Playwright
 * for a contributor who only wants to run the unit tests.
 *
 * Run it with `deno task test:browser`, optionally `BROWSER_DRIVER=puppeteer`.
 */

import type { BrowserDriver } from "../../src/adapters/browser/driver.ts";
import { playwrightDriver } from "../../src/adapters/browser/drivers/playwright.ts";
import { puppeteerDriver } from "../../src/adapters/browser/drivers/puppeteer.ts";

/** Is the flagged suite switched on? Never throws, never prompts. */
export const BROWSER_TESTS: boolean = (() => {
	try {
		const query = Deno.permissions.querySync({
			name: "env",
			variable: "BROWSER_TESTS",
		});
		return query.state === "granted" && Deno.env.get("BROWSER_TESTS") === "1";
	} catch {
		return false;
	}
})();

/** Which binding is under test. Default Playwright — the engine the README promises. */
export function driverName(): "playwright" | "puppeteer" {
	try {
		const query = Deno.permissions.querySync({
			name: "env",
			variable: "BROWSER_DRIVER",
		});
		if (query.state !== "granted") return "playwright";
		return Deno.env.get("BROWSER_DRIVER") === "puppeteer"
			? "puppeteer"
			: "playwright";
	} catch {
		return "playwright";
	}
}

/**
 * Import the real driver and bridge it.
 *
 * Called only from inside an enabled test body — never at module load, which is the
 * whole point.
 */
export async function loadDriver(): Promise<BrowserDriver> {
	const launchOptions = { headless: true, args: ["--no-sandbox"] };
	if (driverName() === "puppeteer") {
		const puppeteer = await import(`npm:puppeteer@^24`);
		return puppeteerDriver(puppeteer as Record<string, unknown>, { launchOptions });
	}
	const playwright = await import(`npm:playwright@^1`);
	return playwrightDriver(playwright as Record<string, unknown>, {
		browser: "chromium",
		launchOptions,
	});
}

/** `Deno.test` options that skip the whole case unless the suite is enabled. */
export const gated = { ignore: !BROWSER_TESTS } as const;

/**
 * The zombie-process test: after `dispose()`, no browser child process may survive.
 *
 * Orphaned Chromium processes are the number one operational complaint about anything
 * that drives a browser, and they are invisible to every other kind of test — the suite
 * goes green while the machine fills up. So this one looks at the process table.
 *
 * Deliberately driver-agnostic and best effort: Playwright's `Browser` exposes no
 * process (only `BrowserServer` does), so pinning the assertion to a pid would test one
 * driver and not the other. Scanning our own descendants for browser-looking commands
 * catches the actual failure mode without depending on either driver's internals.
 * Skipped where `ps -eo` is not available.
 */
import { assert, assertEquals } from "@std/assert";
import { createBrowserAdapter } from "../../src/adapters/browser/browser-adapter.ts";
import { startFixtureServer } from "../fixtures/server.ts";
import { BROWSER_TESTS, loadDriver } from "./harness.ts";

/** Commands that mean "a browser we launched". */
const BROWSER_COMMAND = /chrom|headless_shell|firefox|webkit|playwright|puppeteer/i;

const SCANNABLE = Deno.build.os === "darwin" || Deno.build.os === "linux";

interface ProcessRow {
	pid: number;
	ppid: number;
	command: string;
}

/** Read the process table. Both BSD and procps `ps` accept `-eo`. */
async function processTable(): Promise<ProcessRow[]> {
	const { stdout } = await new Deno.Command("ps", {
		args: ["-eo", "pid,ppid,comm"],
		stdout: "piped",
		stderr: "null",
	}).output();
	return new TextDecoder().decode(stdout)
		.split("\n")
		.slice(1)
		.map((line) => line.trim().split(/\s+/))
		.filter((parts) => parts.length >= 3 && Number.isFinite(Number(parts[0])))
		.map((parts) => ({
			pid: Number(parts[0]),
			ppid: Number(parts[1]),
			// a command path can contain spaces ("Google Chrome for Testing"), so
			// everything after ppid is the command
			command: parts.slice(2).join(" "),
		}));
}

/** Every transitive descendant of `root` whose command looks like a browser. */
async function browserDescendants(root: number): Promise<ProcessRow[]> {
	const rows = await processTable();
	const byParent = new Map<number, ProcessRow[]>();
	for (const row of rows) {
		const siblings = byParent.get(row.ppid) ?? [];
		siblings.push(row);
		byParent.set(row.ppid, siblings);
	}

	const found: ProcessRow[] = [];
	const queue = [root];
	const seen = new Set<number>([root]);
	while (queue.length) {
		for (const child of byParent.get(queue.shift()!) ?? []) {
			if (seen.has(child.pid)) continue;
			seen.add(child.pid);
			queue.push(child.pid);
			if (BROWSER_COMMAND.test(child.command)) found.push(child);
		}
	}
	return found;
}

/** Poll until no browser descendant is left, or the budget runs out. */
async function waitForNoBrowsers(root: number, budgetMs = 5_000): Promise<ProcessRow[]> {
	const until = Date.now() + budgetMs;
	let left = await browserDescendants(root);
	while (left.length && Date.now() < until) {
		await new Promise((r) => setTimeout(r, 200));
		left = await browserDescendants(root);
	}
	return left;
}

Deno.test({
	ignore: !BROWSER_TESTS || !SCANNABLE,
	name: "real browser: dispose leaves no zombie browser process behind",
	fn: async () => {
		const server = await startFixtureServer();
		const adapter = createBrowserAdapter({
			driver: await loadDriver(),
			poolSize: 2,
			wait: "domcontentloaded",
		});

		try {
			await Promise.all(
				["/ok", "/spa", "/ok"].map((path) =>
					adapter.fetch({ url: server.url(path) })
				),
			);

			// the scan must be able to SEE the browser, or the assertion after dispose
			// would pass for the wrong reason
			const running = await browserDescendants(Deno.pid);
			assert(
				running.length > 0,
				"no browser process found while the adapter was live — the process " +
					"scan is not working, so the leak assertion would be vacuous",
			);

			await adapter.dispose?.();

			const survivors = await waitForNoBrowsers(Deno.pid);
			assertEquals(
				survivors.map((p) => `${p.pid} ${p.command}`),
				[],
				"browser processes survived dispose()",
			);
		} finally {
			await adapter.dispose?.();
			await server.shutdown();
		}
	},
});

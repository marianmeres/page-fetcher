<!--
GENERATED ANALYSIS — @marianmeres/page-fetcher implementation plan
Produced 2026-08-23 by multi-agent research -> adversarial verify -> synthesize.
Claims verified against the design doc (tmp/page-fetcher-DESIGN.md), local ecosystem
sources, and platform checks. Repo is a pre-first-commit scaffold; no code was changed.
-->

# Browser adapter: driver interface, pool, lifecycle

> This doc covers `createBrowserAdapter` (DESIGN §5.2): the internal driver interface
> abstracting Playwright and Puppeteer, wait strategies, resource blocking, context
> strategies and the pool, crash recovery, zombie cleanup, the `onPage` hook, and extras
> capture. Driver API names and line citations below were verified against real local
> type definitions (puppeteer-core 24.41.0 `lib/types.d.ts` from the Deno npm cache,
> playwright-core 1.58.1 `types/types.d.ts` from a local node_modules) — nothing here is
> from memory alone. Remaining unverifiable behaviors are explicitly marked
> "assumed — verify at implementation time".

> The single most important takeaway: **the design doc's "injected or lazily imported"
> driver loading is half wrong — lazy import must be dropped.** A dynamic
> `import("playwright")` from JSR-published code has no working spelling: a bare specifier
> is unmapped in Deno consumers, an `npm:playwright` specifier breaks in the npm build,
> and a computed specifier evades build-time rewriting entirely. **Design deviation:**
> v1 is injection-required — the caller imports the driver package themselves and passes
> it through a tiny bundled bridge (`playwrightDriver(playwright)` /
> `puppeteerDriver(puppeteer)`). This is not a loss: it is more explicit, keeps the
> zero-runtime-dependency promise trivially true, and makes the adapter testable against
> a fake in-memory driver.

> Headline recommendation: define a ~10-method structural driver interface (no type
> imports from playwright/puppeteer — structural "shaped-like" types only), ship the two
> bridges, and build the pool against that interface with epoch-based crash recovery so a
> dead browser can never wedge the acquire queue. Everything else (wait strategies,
> blocking, capture) hangs off that interface cleanly.

## Summary of recommendations

| #  | Recommendation                                                                       | Value | Effort | Risk |
| -- | ------------------------------------------------------------------------------------ | ----- | ------ | ---- |
| 5  | Result mapping: eager `content()`, redirect chain, `finalUrl`, bytes semantics       | high  | S      | low  |
| 6  | Resource blocking ON by default (image/media/font/stylesheet) + URL predicates       | high  | S      | low  |
| 1  | Injection-required driver API: `driver: playwrightDriver(pw)` — no lazy import       | high  | M      | low  |
| 2  | Tiny structural driver interface + two bundled bridges + fake driver for tests       | high  | M      | low  |
| 4  | Wait strategy normalization; default = hybrid "load then soft networkidle"           | high  | M      | low  |
| 3  | Context pool with epoch-based crash recovery; waiters never wedge                    | high  | L      | med  |
| 7  | Cross-runtime exit-hook helper (Deno signal/unload vs Node process), opt-out         | med   | S      | low  |
| 8  | `onPage` hook + console-error/failed-request capture on by default, bounded          | med   | S      | low  |
| 9  | `logger?: Logger` (clog) on `createBrowserAdapter` and the pool, silent default      | med   | S      | low  |
| 10 | Confirm DESIGN §12 ordering (browser adapter after core+retry); note crawler tension | low   | S      | low  |

(Numbers are stable finding IDs; the table is ordered by value desc, effort asc.)

## Findings & recommendations (detailed)

### 1. Lazy driver import cannot work under JSR+npm dual publish — require injection

- **Problem / observation.** DESIGN §5.2 says the driver is "injected or lazily
  imported". The lazy-import half is a packaging trap for this package specifically:
  - A literal `import("playwright")` bare specifier resolves for npm consumers but is
    unmapped for JSR/Deno consumers unless _they_ add an import-map entry — a silent
    runtime failure mode ("Relative import path / bare specifier not prefixed" errors at
    the moment the browser adapter is first used, not at install).
  - Writing `import("npm:playwright")` works in Deno but is an invalid specifier in the
    npm build output for Node consumers.
  - A computed specifier (`import(name)` where `name` is a variable) dodges both JSR's
    dependency analysis and `@marianmeres/npmbuild`'s specifier rewriting — the exact
    "works on my machine" fragility the zero-dep promise (DESIGN §2) exists to prevent.
  - Even where a lazy import resolves, it makes the dependency invisible: `deno.json` /
    `package.json` cannot declare it (that would violate zero-runtime-deps), so there is
    no install-time signal at all that Playwright is needed.
- **Evidence** — DESIGN §2 ("Zero required runtime dependencies… loaded lazily"),
  DESIGN §5.2 ("injected or lazily imported"); repo `deno.json` (single-string JSR
  export `deno.json:4`, npmbuild-based npm publish `deno.json:16`). JSR's requirement
  that all imports be statically analyzable is assumed — verify at implementation time,
  but the Deno-consumer bare-specifier failure alone is disqualifying.
- **Proposed change.** Injection-required v1 API. The caller owns the driver import:

  ```ts
  import playwright from "playwright"; // or: import * as pw
  import {
  	createBrowserAdapter,
  	playwrightDriver,
  } from "@marianmeres/page-fetcher/adapters";

  const adapter = createBrowserAdapter({ driver: playwrightDriver(playwright) });
  // or:
  const adapter = createBrowserAdapter({ driver: puppeteerDriver(puppeteer) });
  // or fully custom:
  const adapter = createBrowserAdapter({ driver: myDriver }); // implements BrowserDriver
  ```

  The bridges are plain functions bundled with this package; they hold **no** import of
  playwright/puppeteer at module scope (they only touch the object passed in), so
  installing/importing this package never pulls a browser. Their parameter types are
  local structural interfaces (see #2), not types imported from the driver packages —
  otherwise we would smuggle in a compile-time dependency on their type packages too.
  `@marianmeres/clog` remains the only compile-time (type-only) dep, per the accepted
  ecosystem convention.

  **Design deviation:** drop "lazily imported" from the contract; README documents the
  two-line injection recipe instead. The README should also state explicitly that the
  driver is a peer the user installs (`npm i playwright` / `deno add npm:playwright`).
- **Affected files** — `src/adapters/browser/browser-adapter.ts`,
  `src/adapters/browser/drivers/playwright.ts`,
  `src/adapters/browser/drivers/puppeteer.ts`, README.
- **Effort / Value / Risk** — M / high / low.
- **Implementation notes.** `playwrightDriver(source, opts?)` accepts either the whole
  module (`{ chromium, firefox, webkit }`) or a single BrowserType-shaped object
  (`{ launch }`); `opts: { browser?: "chromium" | "firefox" | "webkit"; launchOptions?:
  Record<string, unknown> }`, default chromium. `puppeteerDriver(source, opts?)` accepts
  the module default export (`{ launch }`); `opts: { launchOptions?: Record<string,
  unknown> }`. `launchOptions` pass through verbatim (users need `executablePath`,
  `args: ["--no-sandbox"]` etc. — an earlier internal implementation needed exactly
  those). Detect an obviously wrong `source` (no `launch`, no `chromium.launch`) and
  throw a descriptive `TypeError` at bridge-call time, not at first fetch.

### 2. The internal driver interface: tiny, structural, and the key to testability

- **Problem / observation.** DESIGN §5.2 names six driver methods (`launch`,
  `newContext`, `newPage`, `goto`, `content`, `close`). That list is too small to cover
  the required capabilities in the same section: request interception (resource
  blocking), wait hooks (`networkidle` / selector / fn), crash detection, console/failed
  request capture, and title. It also glosses over a real model difference: Playwright
  contexts carry per-context options (`userAgent`, `viewport`, `locale`, `timezoneId`,
  `javaScriptEnabled`, `extraHTTPHeaders` — all verified in `BrowserContextOptions`),
  while Puppeteer's `browser.createBrowserContext()` takes none of these; the equivalents
  are per-page calls (`page.setUserAgent`, `page.setViewport`,
  `page.setJavaScriptEnabled`, `page.setExtraHTTPHeaders`, `page.emulateTimezone` — all
  verified). Puppeteer has no locale API at all (closest: `Accept-Language` header).
- **Evidence** — DESIGN §5.2; playwright-core 1.58.1 `types/types.d.ts`
  (`newContext(options?: BrowserContextOptions)` :9694, `javaScriptEnabled` :9891,
  `timezoneId` :10117, `userAgent` :10122, `viewport` :10152, `extraHTTPHeaders` :9819);
  puppeteer-core 24.41.0 `lib/types.d.ts` (`createBrowserContext` :335,
  `setUserAgent` :6404, `setJavaScriptEnabled` :6670, `emulateTimezone` :6779,
  `setExtraHTTPHeaders` :6396, `setViewport` :6861).
- **Proposed change.** `src/adapters/browser/driver.ts` exporting structural interfaces
  (public, so custom drivers are possible):

  ```ts
  export interface DriverContextOptions {
  	userAgent?: string;
  	viewport?: { width: number; height: number } | null;
  	locale?: string;
  	timezoneId?: string;
  	javaScriptEnabled?: boolean;
  	extraHTTPHeaders?: Record<string, string>;
  }

  export interface DriverNavResult {
  	status: number;
  	statusText?: string;
  	headers: Record<string, string>; // lowercased keys
  	redirects: string[]; // HTTP redirect chain, oldest first, excl. final
  	finalUrl: string; // end of HTTP redirect chain
  }

  export interface DriverPage {
  	goto(url: string, opts: {
  		waitUntil: "load" | "domcontentloaded";
  		timeout: number;
  	}): Promise<DriverNavResult>;
  	waitForNetworkIdle(opts: { idleMs: number; timeout: number }): Promise<void>;
  	waitForSelector(selector: string, opts: { timeout: number }): Promise<void>;
  	waitForFunction(fn: string, opts: { timeout: number }): Promise<void>;
  	content(): Promise<string>;
  	title(): Promise<string>;
  	url(): string;
  	/** Install once, before goto. Return "abort" to block the request. */
  	setRequestFilter(
  		filter: (req: { url: string; resourceType: string }) => "abort" | "continue",
  	): Promise<void>;
  	onConsoleError(cb: (text: string) => void): void;
  	onRequestFailed(cb: (info: { url: string; failure: string }) => void): void;
  	onCrash(cb: (err: Error) => void): void;
  	/** Puppeteer bridge applies context-equivalent options here; playwright no-op. */
  	applyPageOptions(opts: DriverContextOptions): Promise<void>;
  	close(): Promise<void>;
  	/** Native page object — handed to the onPage hook. */
  	raw: unknown;
  }

  export interface DriverContext {
  	newPage(): Promise<DriverPage>;
  	close(): Promise<void>;
  	raw: unknown;
  }

  export interface DriverBrowser {
  	newContext(opts: DriverContextOptions): Promise<DriverContext>;
  	onDisconnected(cb: () => void): void;
  	close(): Promise<void>;
  	/** Browser child-process pid when the driver exposes it (puppeteer); see #7. */
  	readonly pid?: number;
  	raw: unknown;
  }

  export interface BrowserDriver {
  	readonly name: string; // "playwright" | "puppeteer" | custom
  	launch(): Promise<DriverBrowser>;
  	/** What the underlying driver can honor; adapter logs a warn on unsupported opts. */
  	readonly capabilities: {
  		locale: boolean;
  		timezone: boolean;
  		contextOptions: boolean;
  	};
  }
  ```

  Per-driver mapping (all names verified against the local type definitions):

  | Driver op         | Playwright                                                                  | Puppeteer                                                    |
  | ----------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------ |
  | launch            | `chromium.launch(opts)`                                                     | `puppeteer.launch(opts)`                                     |
  | newContext        | `browser.newContext(opts)` (options honored)                                | `browser.createBrowserContext()` (no opts; applied per page) |
  | newPage           | `context.newPage()`                                                         | `context.newPage()`                                          |
  | goto              | `page.goto(url, { waitUntil, timeout })`                                    | `page.goto(url, { waitUntil, timeout })`                     |
  | networkidle       | `page.waitForLoadState("networkidle", { timeout })`                         | `page.waitForNetworkIdle({ idleTime, timeout })`             |
  | selector / fn     | `page.waitForSelector` / `page.waitForFunction`                             | same names (arg order differs — bridge normalizes)           |
  | content/title/url | `page.content()` / `page.title()` / `page.url()`                            | same                                                         |
  | request filter    | `page.route("**/*", r => r.abort()/r.continue())`                           | `page.setRequestInterception(true)` + `page.on("request")`   |
  | resource type     | `request.resourceType(): string`                                            | `request.resourceType(): ResourceType` (lowercased)          |
  | redirect chain    | walk `response.request().redirectedFrom()`                                  | `response.request().redirectChain()`                         |
  | console errors    | `page.on("console")` (filter `type() === "error"`) + `page.on("pageerror")` | same event names                                             |
  | failed requests   | `page.on("requestfailed")`                                                  | `page.on("requestfailed")`                                   |
  | page crash        | `page.on("crash")`                                                          | `page.on("error")` ("Emitted when the page crashes")         |
  | browser died      | `browser.on("disconnected")`                                                | `browser.on("disconnected")`                                 |

  Verified event/method lines: playwright `page.route` :4017, `crash` :1060,
  `pageerror` :1143, `requestfailed` :1198, `resourceType(): string` :20529; puppeteer
  `setRequestInterception` :5789, `PageEvent` enum (`console`/`error`/`pageerror`/
  `requestfailed`) :7517, page-crash doc ("Emitted when the page crashes") :7561,
  `ResourceType = Lowercase<…>` :8653.

  `waitUntil` in the driver interface is deliberately narrowed to
  `"load" | "domcontentloaded"` — both drivers support those literally (Playwright adds
  `"networkidle" | "commit"`, Puppeteer adds `"networkidle0" | "networkidle2"`, verified
  `PuppeteerLifeCycleEvent` :8323), and the adapter expresses networkidle through the
  separate `waitForNetworkIdle` op so the differing semantics (Playwright: fixed ~500 ms
  idle window; Puppeteer: configurable `idleTime`/`concurrency`, defaults 500/0 —
  verified `WaitForNetworkIdleOptions` :9346-9359) live in the bridges, not the adapter.

  `goto` accepts **no AbortSignal in either driver** — cancellation is emulated in the
  adapter: race navigation against the request signal and `page.close()` on abort
  (closing the page aborts in-flight navigation in both drivers — assumed, verify at
  implementation time). This is the browser half of DESIGN §7's cancellation
  requirement; the composition of caller signal + timeout belongs to the guards layer
  (see plan docs 01/03 — one-line pointer, not duplicated here).
- **Affected files** — `src/adapters/browser/driver.ts`,
  `src/adapters/browser/drivers/playwright.ts`,
  `src/adapters/browser/drivers/puppeteer.ts`,
  `tests/browser/fake-driver.ts`.
- **Effort / Value / Risk** — M / high / low.
- **Implementation notes.**
  - **Fake driver is the test strategy.** Because the pool, wait, and crash logic only
    see `BrowserDriver`, a fully in-memory fake (scriptable: "crash after 2 pages",
    "hang goto for 5s") lets the entire pool/crash/recycle test suite run with zero
    browsers and zero network, satisfying DESIGN §10. Real-browser tests stay behind a
    tag/flag. This is the strongest practical argument for the interface.
  - `waitForFunction` arg order — verified: Playwright is
    `waitForFunction(fn, arg, options)` (Page :643), Puppeteer is
    `waitForFunction(fn, options, ...args)` (:7426-7433). The driver interface
    sidesteps the difference by accepting only a self-contained function _string_ and
    options; the bridges place the arguments.
  - Puppeteer request interception disables the browser HTTP cache while enabled
    (assumed — verify at implementation time); acceptable for a crawler-transport, note
    it in docs.
  - Playwright's `page.route` and Puppeteer's interception must be installed **before**
    `goto`; the adapter's per-page setup order is: `applyPageOptions` →
    `setRequestFilter` → capture listeners → `goto`.
  - Puppeteer `locale`: bridge maps `locale` to an `Accept-Language` extra header and
    the driver reports `capabilities.locale: false`; adapter logs a `warn` (via the
    injected logger, #9) when an unhonorable option is set.

### 3. Pool: N contexts over one browser, epoch-based crash recovery, waiters never wedge

- **Problem / observation.** DESIGN §5.2 requires context strategies
  `"shared" | "per-request" | "pooled"` (default pooled), a pool of N with an
  acquire/release queue and per-page max-reuse recycling, and crash recovery where "a
  crashed browser must never wedge the pool". The doc does not spec _how_ waiters
  survive a crash — that is the part that goes wrong in practice (an earlier internal
  implementation avoided the problem by launching a fresh browser per fetch, which is
  correct but ~1–3s of launch overhead per page — the pool exists to beat that).
- **Evidence** — DESIGN §5.2 (context strategy, pool, crash recovery bullets); DESIGN §4
  (`PageFetchError.kind: "browser"`, `retryable`); puppeteer/playwright
  `browser.on("disconnected")` verified (puppeteer types :835, playwright types :9572).
- **Proposed change.** `src/adapters/browser/pool.ts`:

  ```ts
  export interface PoolOptions {
  	driver: BrowserDriver;
  	size: number; // default 3
  	maxPagesPerContext: number; // recycle context after k pages, default 50
  	acquireTimeout: number; // default 30_000 ms
  	contextOptions: DriverContextOptions;
  	logger?: Logger;
  }

  export interface PoolLease {
  	context: DriverContext;
  	epoch: number;
  	release(opts?: { broken?: boolean }): void;
  }

  export interface ContextPool {
  	acquire(signal?: AbortSignal): Promise<PoolLease>;
  	dispose(): Promise<void>; // idempotent
  	readonly stats: { size: number; idle: number; waiting: number; epoch: number };
  }
  export function createContextPool(opts: PoolOptions): ContextPool;
  ```

  Behavior spec:
  - **One browser, N contexts.** Contexts are cheap and isolated (cookies/storage) in
    both drivers; browser-per-slot is deferred (not v1). The browser launches lazily on
    first `acquire`, behind a single-flight promise (concurrent acquires share one
    launch).
  - **Slot lifecycle.** Each slot tracks `{ context, pagesServed, epoch }`. `acquire`:
    pop idle slot → if `pagesServed >= maxPagesPerContext`, close and replace the
    context (recycle) → hand out lease. No idle slot and `slots.length < size` → create
    slot. Otherwise enqueue a waiter `{ resolve, reject, timer, signal }` (FIFO);
    the waiter rejects with `PageFetchError { kind: "timeout", retryable: true }` on
    `acquireTimeout` and with `kind: "aborted"` if its signal fires; either way it is
    unlinked from the queue.
  - **Release.** `release()` increments `pagesServed`, then hands the slot to the first
    live waiter or pushes it to idle. `release({ broken: true })` (page crashed, goto
    blew up unrecognizably) destroys the slot's context and creates a replacement lazily.
  - **Crash = epoch bump.** On `browser.onDisconnected` (or any driver op failing with a
    disconnected/closed error): `epoch++`, drop all slots and idle entries, null the
    browser handle. In-flight fetches holding stale leases fail naturally; their
    `release()` is a no-op because `lease.epoch !== pool.epoch` (this check is what
    prevents a stale context from re-entering the new pool generation). **Waiters stay
    queued** — they are not rejected by the crash itself. The next `acquire` (or the
    queued waiters, drained by a `refill()` scheduled on the crash) triggers relaunch
    via the single-flight launch. Only if **relaunch itself fails** are all current
    waiters rejected with `PageFetchError { kind: "browser", retryable: true }` — so the
    retry layer backs off and re-enters, and a permanently broken environment surfaces
    as failed fetches, never as a hung process. This is the "never wedge" guarantee,
    stated as an invariant to test: _no waiter promise remains pending after (a) its
    timeout, (b) its signal, (c) pool dispose, or (d) a failed relaunch._
  - **Fetch-level error mapping.** A crash observed during a fetch attempt surfaces as
    `PageFetchError { kind: "browser", retryable: true }` per DESIGN §6's classification
    table (browser crash → retry: yes).
  - **dispose().** Rejects all waiters (`kind: "aborted"`, `retryable: false`), closes
    contexts then browser, unregisters the exit hook (#7), idempotent (guard flag).
    Wired to `Adapter.dispose` (DESIGN §5 contract).
  - **Context strategies** map onto the pool trivially: `"pooled"` = the above;
    `"shared"` = `size: 1` with `maxPagesPerContext: Infinity` (still epoch-recovering);
    `"per-request"` = fresh context per acquire, destroyed on release
    (`maxPagesPerContext: 1` over the same bounded slot count `size`, so concurrency
    stays capped — a truly unbounded per-request mode is a footgun).
- **Affected files** — `src/adapters/browser/pool.ts`,
  `src/adapters/browser/browser-adapter.ts`, `tests/browser/pool.test.ts` (fake driver).
- **Effort / Value / Risk** — L / high / med (the med risk is concurrency-bug surface;
  mitigated by the fake-driver test suite and the stated invariant).
- **Implementation notes.** Keep the pool free of any timer left running after dispose
  (clear waiter timers). Use plain arrays + a `Set` for slots; no external deps. The
  `stats` getter exists for tests and for the crawler's future introspection. Pool logs
  (logger #9): launch, relaunch-after-crash (warn), recycle (debug), waiter timeout
  (warn), dispose (debug).

### 4. Wait strategy: normalize to one shape; default = "load, then soft networkidle"

- **Problem / observation.** DESIGN §5.2 requires
  `"load" | "domcontentloaded" | "networkidle" | { selector } | { fn }` with
  `networkidle` on its own timeout, but names no **default**, and does not say what
  happens when the networkidle timeout expires (error vs proceed). Real sites with
  websockets/analytics never go idle; a hard-failing networkidle default would make the
  adapter unusable on exactly the JS-heavy pages it exists for. An earlier internal
  implementation converged on: navigate with `waitUntil: "load"`, then wait for network
  idle with a short cap and _swallow_ the idle timeout — content is rendered by then.
- **Evidence** — DESIGN §5.2 (wait strategy bullet); prior-art hybrid pattern in an
  earlier internal implementation (500 ms idle window, 10 s cap, catch-and-continue);
  playwright `waitForLoadState("load"|"domcontentloaded"|"networkidle", { timeout })`
  verified (:4972), puppeteer `waitForNetworkIdle(options)` verified (:6590; `idleTime`
  - inherited `timeout`, :9346-9359) and `PuppeteerLifeCycleEvent = load |
  domcontentloaded | networkidle0 | networkidle2` verified (:8323).
- **Proposed change.** `src/adapters/browser/wait.ts`:

  ```ts
  export type WaitStrategy =
  	| "load"
  	| "domcontentloaded"
  	| "networkidle"
  	| { selector: string; timeout?: number }
  	| { fn: string; timeout?: number }; // function body/source string

  export interface NetworkIdleOptions {
  	idleMs?: number; // default 500
  	timeout?: number; // default 10_000 — SEPARATE from navigation timeout
  	strict?: boolean; // default false: timeout => proceed, set extra.networkidleTimedOut
  }

  export async function applyWait(
  	page: DriverPage,
  	url: string,
  	strategy: WaitStrategy,
  	opts: { navigationTimeout: number; networkidle: Required<NetworkIdleOptions> },
  ): Promise<{ nav: DriverNavResult; networkidleTimedOut?: boolean }>;
  ```

  Semantics:
  - `"load"` / `"domcontentloaded"` → `goto(url, { waitUntil, timeout: navigationTimeout })`.
  - `"networkidle"` → `goto(url, { waitUntil: "load", … })`, then
    `waitForNetworkIdle({ idleMs, timeout })`; on idle-timeout: if `strict` → throw
    (`kind: "timeout"`, retryable true), else proceed and report
    `networkidleTimedOut: true` (surfaced in `FetchResult.extra`). **Design gap:** the
    doc's bare `"networkidle"` is spec'd here as this hybrid soft form — recommended
    because it is the only form that works on both static and never-idle pages.
  - `{ selector }` / `{ fn }` → `goto(waitUntil: "domcontentloaded")`, then
    `waitForSelector`/`waitForFunction` with `timeout ?? navigationTimeout`; timeout
    here is a **hard** failure (`kind: "timeout"`, retryable true) — the caller
    explicitly asked for a condition, absence of which means the page is not usable.
  - **Default strategy: `"networkidle"`** (i.e. the soft hybrid). **Design deviation
    (doc is silent):** the browser adapter exists for JS-rendered pages; plain `"load"`
    as default would return pre-hydration DOM on SPA sites, the #1 "it returns empty
    HTML" bug report. Per-request override via `req.adapterOptions.wait` (DESIGN §5.2
    "per-request overridable").
  - `timing.render` = time from `goto` resolution to wait-strategy completion (0 for
    plain load/domcontentloaded), reported per DESIGN §4 `FetchTiming.render`.
- **Affected files** — `src/adapters/browser/wait.ts`,
  `src/adapters/browser/browser-adapter.ts`, tests via fake driver.
- **Effort / Value / Risk** — M / high / low.
- **Implementation notes.** `{ fn }` takes a source **string**, not a function object —
  it must serialize into the page anyway, and a string keeps the driver interface
  normalizable across the two drivers' differing `waitForFunction` signatures (see #2).
  Both `goto` timeout errors map to `PageFetchError { kind: "timeout" }`; navigation
  errors that are not timeouts (net::ERR_*, TargetClosed) map to `kind: "browser"` or
  `kind: "network"` — spec: DNS/connection-looking `net::ERR_` messages → `"network"`,
  everything else browser-side → `"browser"`; both retryable.

### 5. Result mapping: eager content, redirect chain, finalUrl, and honest bytes()

- **Problem / observation.** DESIGN §4's `FetchResult` promises `text()`, `bytes()`,
  `redirects`, `finalUrl`, and DESIGN §11.1 already suggests eager text for the browser
  adapter (page is returned to the pool — after release, `page.content()` is gone).
  Three under-spec'd corners: (a) a browser navigation auto-follows redirects, so
  `maxRedirects` cannot abort mid-chain like the HTTP adapter; (b) `bytes()` cannot
  return original network bytes without CDP response-body capture (out of v1 scope);
  (c) `finalUrl` can diverge between "end of HTTP redirect chain" and the live
  `page.url()` after client-side JS redirects during the wait phase.
- **Evidence** — DESIGN §4, §11.1; puppeteer `redirectChain(): HTTPRequest[]` verified
  (:3845); playwright `redirectedFrom(): null|Request` chain-walk verified (:20507).
- **Proposed change.** In `browser-adapter.ts`, after `applyWait` and `onPage`, and
  **before** `lease.release()`:
  1. Materialize `const html = await page.content()`, `const title = await page.title()`.
  2. `text()` resolves the cached string; `bytes()` returns
     `new TextEncoder().encode(html)` (computed lazily, cached); `size` = that byte
     length; `charset` = `"utf-8"` always (the DOM is re-serialized — original transport
     charset is irrelevant); `contentType` parsed from response headers. Document
     loudly: browser `bytes()` is the serialized DOM, not wire bytes.
  3. `redirects` from the driver's `DriverNavResult.redirects`; if
     `redirects.length > maxRedirects`, fail post-hoc with
     `kind: "too-many-redirects"` (**Design deviation:** enforcement is after the fact —
     the browser already followed the chain; cheaper than CDP-level interception and
     good enough for a cap of 5).
  4. `finalUrl` = end of the HTTP redirect chain (`DriverNavResult.finalUrl`); when
     `page.url()` differs after waits (client-side redirect/pushState), report it as
     `extra.pageUrl` — callers resolving relative refs (the crawler) get the
     server-truth `finalUrl` per DESIGN §4, and SPA URL drift stays observable.
  5. `status`/`statusText`/`headers` from `DriverNavResult`; non-2xx resolves with
     `ok: false`, never throws (DESIGN §4 decision) — same policy as the HTTP adapter.
  - One-line pointer: the lazy-vs-eager `text()` contract across adapters is owned by
    plan doc 01 (core types); this doc only fixes the browser side as eager.
- **Affected files** — `src/adapters/browser/browser-adapter.ts`,
  `src/adapters/browser/drivers/*.ts` (nav-result assembly).
- **Effort / Value / Risk** — S / high / low.
- **Implementation notes.** Playwright `goto` returns `Promise<null|Response>` —
  verified (:3212, :3239); the `null` case (same-document navigation) cannot happen for
  a fresh page navigating to an http(s) URL, but guard: `null` →
  `PageFetchError { kind: "browser", retryable: true }`. Puppeteer response headers
  arrive as `Record<string, string>` with lowercased keys; playwright same via
  `response.headers()` — assemble a `Headers` instance in the adapter (multi-value
  headers are lossy in both drivers' record form; acceptable, note in JSDoc).

### 6. Resource blocking: ON by default, plus URL predicates — confirmed sound

- **Problem / observation.** DESIGN §5.2 mandates blocking
  `image`, `media`, `font`, `stylesheet` by default with a loud doc note ("3–5×
  throughput win"). This is sound and stays as spec'd — one line of confirmation, no
  manufactured objection. Two refinements are needed: a per-request override channel,
  and the optional URL allow/block patterns the doc lists under "Optional".
- **Evidence** — DESIGN §5.2 (resource blocking bullet, optional block/allow URL
  patterns); playwright `page.route` + `request.resourceType(): string` verified
  (:4017, :20529); puppeteer `setRequestInterception(value: boolean)` + lowercased
  `ResourceType` verified (:5789, :8653).
- **Proposed change.** `src/adapters/browser/blocking.ts`:

  ```ts
  export type ResourceKind =
  	| "image"
  	| "media"
  	| "font"
  	| "stylesheet"
  	| "script"
  	| "xhr"
  	| "fetch"
  	| "other";

  export interface BlockingOptions {
  	/** false disables; default ["image","media","font","stylesheet"] */
  	blockResources?: false | readonly ResourceKind[];
  	/** Block when any matches (checked after resource-kind pass-through). */
  	blockUrls?: readonly (RegExp | ((url: string) => boolean))[];
  	/** When set, only matching urls load (document requests always allowed). */
  	allowUrls?: readonly (RegExp | ((url: string) => boolean))[];
  }
  export function compileRequestFilter(
  	opts: BlockingOptions,
  ): (req: { url: string; resourceType: string }) => "abort" | "continue";
  ```

  - The main-frame `document` request is **never** blocked regardless of patterns.
  - Predicates are `RegExp | function` — no glob dependency (zero-dep rule); `URLPattern`
    is not universally available in Node (assumed — verify at implementation time), so it
    is not the v1 type, though a passed-in `URLPattern` works fine as a
    `(url) => boolean` wrapper on the caller's side.
  - Per-request override: `req.adapterOptions.blockResources` / `blockUrls` /
    `allowUrls` replace (not merge) the adapter defaults for that request. Merging rules
    are a complexity trap; replacement is predictable.
  - Resource-kind normalization: both drivers report lowercased type strings; unknown
    strings map to `"other"`.
  - README carries the required loud note: blocking is ON by default, including
    `stylesheet` — pages whose scripts read computed styles may render differently;
    `blockResources: false` restores full fidelity.
- **Affected files** — `src/adapters/browser/blocking.ts`, `browser-adapter.ts`, README.
- **Effort / Value / Risk** — S / high / low.
- **Implementation notes.** Install the filter per page before `goto` (see #2 setup
  order). Puppeteer's cooperative interception nuance
  (`request.isInterceptResolutionHandled`, verified :3755) only matters when user code
  also intercepts on the same raw page via `onPage` — document "don't add a second
  interceptor", don't engineer around it in v1.

### 7. Zombie cleanup: cross-runtime exit hook, opt-out, complementary to driver handlers

- **Problem / observation.** DESIGN §5.2 requires `dispose()` to kill the browser plus a
  process-exit/SIGINT hook (opt-out) because orphaned Chromium processes are the top
  operational complaint. Constraint: no Deno-only APIs unconditionally executed
  (DESIGN §2 "No Deno-only APIs in the core" — feature-detected conditional use is
  fine), and Node/Deno differ (`Deno.addSignalListener` vs `process.on`).
  Nuance the design doc misses: **both drivers already install SIGINT/SIGTERM/SIGHUP
  handlers by default** (`handleSIGINT` et al. verified in both launch-option types), so
  our hook is a second line of defense — it matters for `unload`/`exit` paths, for
  users launching with `handleSIGINT: false`, and for custom drivers.
- **Evidence** — DESIGN §5.2 (zombie cleanup bullet); puppeteer `handleSIGINT/…TERM/…HUP`
  verified (:4912-4922); playwright `handleSIGINT` verified (:15071); Deno APIs verified
  by execution on this machine: `typeof Deno.addSignalListener === "function"`,
  `globalThis.addEventListener("unload", …)` accepted, `node:process` shim exposes
  `on`/`kill`/`pid`, and `Deno.kill`/`Deno.pid` exist.
- **Proposed change.** `src/adapters/browser/exit-hook.ts` (kept inside the browser
  module — no other layer needs it):

  ```ts
  /** Returns an unregister function. Never throws; no-ops where unsupported. */
  export function registerExitHook(fn: () => void): () => void;
  ```

  - Feature-detect at call time (never at module top level):
    - `globalThis.Deno?.addSignalListener` → register `"SIGINT"` (+ `"SIGTERM"` on
      non-Windows; a SIGTERM listener on Windows throws in Deno — assumed, verify at
      implementation time) and `globalThis.addEventListener("unload", fn)`.
    - else `globalThis.process?.on` → `process.on("exit", fn)` and `process.once("SIGINT", …)`.
  - Signal-handler protocol: run `fn` (synchronous best-effort), then **unregister and
    re-raise** the same signal — Deno: remove listener + `Deno.kill(Deno.pid, "SIGINT")`;
    Node: `process.kill(process.pid, "SIGINT")` — so default exit codes and other
    handlers are preserved. Installing a SIGINT listener suppresses default termination
    in both runtimes — the re-raise is mandatory, spell it out in tests.
  - `fn` is synchronous by contract: exit/unload cannot await. Best effort =
    `void browser.close().catch(() => {})` — for a hard kill the driver needs a pid
    (puppeteer `browser.process(): ChildProcess | null` verified :315; playwright's
    `Browser` (:9543) has **no** public `process()` — only `BrowserServer` does,
    verified :18652), so a sync kill is puppeteer-only: bridge fills the optional
    `DriverBrowser.pid` (#2), hook prefers `process.kill(pid)`/`Deno.kill(pid)` when
    available, falls back to fire-and-forget `close()`.
  - Adapter option `exitHooks?: boolean` (default `true`); `dispose()` always
    unregisters.
- **Affected files** — `src/adapters/browser/exit-hook.ts`, `pool.ts` (registers around
  launch), `browser-adapter.ts` (option plumbing).
- **Effort / Value / Risk** — S / med / low.
- **Implementation notes.** The leak test from DESIGN §10 (launch, fetch N, dispose,
  assert no child processes) runs in the tagged real-browser suite; the exit-hook unit
  test runs against the fake driver by asserting register/unregister bookkeeping (never
  send real signals in tests).

### 8. onPage hook + capture: console errors and failed requests on by default, bounded

- **Problem / observation.** DESIGN §5.2 requires `onPage(page, req) => extra` and lists
  console-error/failed-request capture under "Optional:". Leaving capture off by default
  wastes the cheapest diagnostic signal a browser fetch has ("why is this page empty?" —
  answer is almost always in console errors / failed requests).
- **Evidence** — DESIGN §5.2 (`evaluate` hook bullet, Optional bullet); event names
  verified (#2 table).
- **Proposed change.**

  ```ts
  export interface BrowserAdapterOptions /* excerpt */ {
  	onPage?: (
  		page: unknown,
  		req: FetchRequest,
  	) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
  	captureConsoleErrors?: boolean; // default true
  	captureFailedRequests?: boolean; // default true
  	captureLimit?: number; // default 50 entries per list
  }
  ```

  - **Design deviation:** capture defaults ON (doc says optional). Rationale: two event
    listeners and two capped arrays per page — negligible cost, high value; the caps
    (`captureLimit`, drop-beyond with a final `"… truncated"` marker) bound memory on
    pathological pages. Opt-out stays one flag away.
  - `onPage` runs **after** the wait strategy resolves and **before** `content()` — the
    hook sees the settled page and may mutate it (scroll, click cookie banners); its
    return value is shallow-merged into `extra` _last_ (hook wins on key collision).
    `page` is the native driver page (`DriverPage.raw`), typed `unknown` — callers cast
    to their driver's Page type; this keeps driver types out of our public surface.
    Hook errors do **not** fail the fetch: log via logger (warn), set
    `extra.onPageError: string`.
  - Extra shape produced by the adapter:
    `extra: { title, consoleErrors?: string[], failedRequests?: { url, failure }[],
    networkidleTimedOut?: boolean, pageUrl?: string, onPageError?: string, ...onPageResult }`.
- **Affected files** — `src/adapters/browser/browser-adapter.ts` (capture is ~20 lines;
  no separate module needed).
- **Effort / Value / Risk** — S / med / low.

### 9. Logger: first-class `@marianmeres/clog` Logger, silent by default

- **Problem / observation.** User requirement (overrides doc silence): every layer
  factory accepts `logger?: Logger`; default silent. The browser adapter is where
  logging earns its keep — launches, crashes, recycles and exit hooks are invisible in
  `FetcherEvents` (DESIGN §9 events are per-attempt/per-request, not
  per-browser-lifecycle). Logging complements, does not replace, the events object.
- **Evidence** — `Logger` interface verified at
  `/Users/mm/projects/@marianmeres/clog/src/clog.ts:186` (`debug/log/warn/error`,
  console-compatible, `(...args: any[]) => any`); structurally satisfied by `console`.
- **Proposed change.** `import type { Logger } from "@marianmeres/clog"` (type-only —
  erased at runtime, zero-runtime-dep holds; clog added to `deno.json` imports as a
  compile-time dep — accepted). `createBrowserAdapter`, `createContextPool` take
  `logger?: Logger`; internal helper `const log = logger ?? silentLogger` where
  `silentLogger` is a shared no-op from `src/utils/logger.ts` (shared with all layers —
  one-line pointer: the package-wide logger convention belongs to plan doc 01;
  this doc only claims the browser-side call sites). Level mapping: launch/dispose →
  `debug`; recycle → `debug`; crash detected / relaunch / unhonored capability /
  onPage error / waiter timeout → `warn`; relaunch failure → `error`.
- **Affected files** — `src/utils/logger.ts` (shared), `pool.ts`,
  `browser-adapter.ts`, `deno.json` (imports entry for `@marianmeres/clog`).
- **Effort / Value / Risk** — S / med / low.

### 10. Phase ordering (DESIGN §12 steps 7–8): confirmed, with one noted tension

- **Problem / observation.** DESIGN §12 sequences the browser adapter (7: driver
  interface + single-context; 8: pool/recovery/exit hooks) after core types, HTTP
  adapter, guards, retry, breaker, and composition (1–6). Confirmed sound: the browser
  adapter consumes `FetchRequest`/`FetchResult`/`PageFetchError` and the retry layer's
  `retryable` contract, so building it first would mean building against a moving
  target. v1 without the browser adapter is shippable and useful (HTTP fetching with
  retries/guards/cache is a complete product for non-JS pages, link checking, APIs).
  **Tension to record:** the future crawler names the browser adapter its _default_
  (DESIGN §5.2 first line), so "shippable without it" is true for page-fetcher but the
  crawler cannot start integration until steps 7–8 land — if crawler work is imminent,
  step 7 (driver interface + single-context adapter, no pool) is the minimal unblock,
  and the interface-first design here (#2) makes step 7 small.
- **Evidence** — DESIGN §12, §5.2 ("Default adapter for the crawler's HTML pages").
- **Proposed change.** Keep the ordering. Within this dimension, the internal order is:
  `driver.ts` + fake driver → `drivers/playwright.ts`/`drivers/puppeteer.ts` (bridges) →
  `browser-adapter.ts` single-context → `wait.ts`/`blocking.ts` → `pool.ts` →
  `exit-hook.ts` → tagged real-browser smoke + leak test.
- **Affected files** — none (plan-level).
- **Effort / Value / Risk** — S / low / low (confirms the design rather than changing
  it; the actionable part is the internal build order above).

### Module layout (proposed)

```
src/adapters/browser/
	mod.ts                   — public re-exports: createBrowserAdapter, playwrightDriver,
	                           puppeteerDriver, BrowserDriver + Driver* types, WaitStrategy
	browser-adapter.ts       — createBrowserAdapter: per-request orchestration
	                           (acquire → page setup → wait → onPage → materialize → release)
	driver.ts                — BrowserDriver / DriverBrowser / DriverContext / DriverPage
	drivers/playwright.ts    — playwrightDriver(source, opts?) bridge (no pw imports)
	drivers/puppeteer.ts     — puppeteerDriver(source, opts?) bridge (no ppt imports)
	pool.ts                  — createContextPool (epochs, recycling, waiter queue)
	wait.ts                  — WaitStrategy normalization + applyWait
	blocking.ts              — compileRequestFilter
	exit-hook.ts             — registerExitHook (cross-runtime, feature-detected)
tests/browser/
	fake-driver.ts           — scriptable in-memory BrowserDriver
	pool.test.ts, wait.test.ts, blocking.test.ts, adapter.test.ts   (no browser, no net)
	real.smoke.test.ts       — tagged/flagged; includes the DESIGN §10 leak test
```

The `@marianmeres/page-fetcher/adapters` subexport (DESIGN §2) requires converting
`deno.json` `exports` from a single string to a map — owned by the packaging dimension
doc (one-line pointer); this layout only requires that `src/adapters/browser/mod.ts` be
reachable from whatever entry that doc defines. Nothing under `src/adapters/browser/`
may be imported by `src/mod.ts`'s core path — the browser module must be reachable only
via the adapters entry so tree-shaking/npm consumers of the core never touch it.

## Open questions / decisions needed

- Default pool numbers: `poolSize: 3`, `maxPagesPerContext: 50`, `acquireTimeout:
  30_000`, networkidle `idleMs: 500` / `timeout: 10_000` are proposed here — sane, but
  they are product defaults the owner should bless.
- Default wait strategy: this doc recommends the soft hybrid `"networkidle"` (load →
  bounded idle wait → proceed on idle-timeout) as the default. Confirm, or choose plain
  `"load"` (faster, but returns pre-hydration DOM on SPAs by default).
- `finalUrl` semantics on client-side redirects: this doc picks "end of HTTP redirect
  chain" with `extra.pageUrl` for divergence. Confirm (the crawler's relative-URL
  resolution depends on this choice).
- Capture-on-by-default (console errors + failed requests) is a mild deviation from the
  doc's "Optional:" — confirm default-on with `captureLimit: 50`.
- Playwright browser choice surface: is `playwrightDriver(pw, { browser: "firefox" })`
  wanted in v1, or chromium-only (webkit/firefox untested)? Bridges support it for free;
  the question is what the README promises/tests.
- Should `"per-request"` context strategy cap concurrency at `poolSize` (recommended
  here) or be truly unbounded as the naive reading of DESIGN §5.2 allows?

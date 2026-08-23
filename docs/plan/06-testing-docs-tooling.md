<!--
GENERATED ANALYSIS — @marianmeres/page-fetcher implementation plan
Produced 2026-08-23 by multi-agent research -> adversarial verify -> synthesize.
Claims verified against the design doc (tmp/page-fetcher-DESIGN.md), local ecosystem
sources, and platform checks. Repo is a pre-first-commit scaffold; no code was changed.
Adversarial verify pass 2026-08-23: every file:line citation re-opened; every platform
claim re-run network-free on Deno 2.9.5 / npm 11.19.0, darwin. One draft claim was
corrected (the "broken npm build" — see finding 1) and one draft snippet fixed (the
browser-test env gate — see finding 5).
-->

# Testing strategy, package tooling, documentation plan

> This doc covers DESIGN §10 (testing), the deno.json / npmbuild / release tooling, and
> the complete documentation plan (agent docs + human docs), with every platform and
> ecosystem claim checked against real files or a network-free `deno eval` / probe run
> (Deno 2.9.5, npm 11.19.0, 2026-08-23).

> Two verified platform facts shape the whole test plan. (a) `Deno.serve` does **not**
> auto-compress responses on this runtime — reproduced twice via raw-socket probe with
> `Accept-Encoding: gzip, br` against both a 4 KB string body and an 8 KB streamed body:
> no `content-encoding` either way. The gzip fixture must therefore be hand-encoded with
> `CompressionStream` and served with an explicit `Content-Encoding: gzip` header (which
> is also more deterministic). (b) On Deno 2.9.5, `@std/testing`'s `FakeTime.tickAsync()`
> drives both `setTimeout` **and** `AbortSignal.timeout()` — so retry, breaker, and even
> the timeout guards are all fake-timer testable. One scaffold nit was defused during
> verification: `scripts/build-npm.ts` passes `versionizeDeps([""], ...)`, which makes
> npmbuild run `npm install ""` — verified a harmless no-op (exit 0, nothing installed,
> no deps written), so nothing is broken today; the placeholder still must become a real
> decision (findings 1 and 9).

> Headline recommendation: lean hard on the design's own layering for testability. Because
> every layer is `(next: FetchFn) => FetchFn` (DESIGN §3) and the browser adapter talks to
> a tiny driver interface (DESIGN §5.2), the retry, circuit-breaker, guard, and pool
> logic are all unit-testable with a stub `next` / fake driver — **no sockets, no browser,
> no real sleeps**. The fixture server then only covers the true I/O edge (HTTP adapter,
> charset, redirects, 304, streaming `maxBytes`) — a genuine design win worth stating in
> docs/architecture.md.

> On documentation: the owner-required plan is fully specifiable now (AGENTS.md + three
> docs/ files + CLAUDE.md redirect; README + API.md per the human guide). One correction:
> AGENT_DOCUMENTATION_GUIDE.md §9 cites a CLAUDE.md template path that does not exist —
> the real template is at `/Users/mm/projects/@marianmeres/agents/mm-local-docs/CLAUDE_TEMPLATE.md`
> (verified: a 3-line redirect to AGENTS.md). Also note `tmp/` is gitignored, so the
> design doc will silently never be committed — promote a cleaned copy to `docs/design.md`.

## Summary of recommendations

| #  | Recommendation                                                                                                                    | Value | Effort | Risk |
| -- | --------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | ---- |
| 1  | Align subpath exports (deno.json exports map + npmbuild `entryPoints`) and replace the build script's `[""]` placeholder          | high  | S      | low  |
| 2  | Retry/backoff/circuit/timeout tests on `FakeTime` with a stub `next` — zero sockets, zero real sleeps                             | high  | S      | low  |
| 3  | One fixture server module (`tests/fixtures/server.ts`): port 0, dual origin, kill-switch shutdown, hand-gzip                      | high  | M      | low  |
| 4  | Concrete per-module test matrix (12 files) incl. raw-byte windows-1250 fixture and abort-propagation cases                        | high  | M      | low  |
| 5  | Browser suite gating: `tests/browser/` + `BROWSER_TESTS=1` + `--ignore`; pool unit-tested vs fake driver; ps-scan leak test       | high  | M      | med  |
| 6  | Agent docs set: AGENTS.md (~1k tokens), docs/architecture.md, docs/conventions.md, docs/tasks.md, CLAUDE.md redirect              | high  | M      | low  |
| 7  | Human docs: README per template (badges, §5.3 + §8 recipes, resource-blocking loud note, non-2xx decision, clog example) + API.md | high  | M      | low  |
| 8  | deno.json: pin `@marianmeres/clog@^3.21.0` + `@std/testing@^1.0.18`; scoped test task flags                                       | med   | S      | low  |
| 9  | npm packaging of the type-only clog dep: declare as regular dependency (ecosystem precedent) — owner sign-off                     | med   | S      | low  |
| 10 | Promote `tmp/page-fetcher-DESIGN.md` → `docs/design.md` (tmp/ is gitignored; the doc would never be committed)                    | med   | S      | low  |
| 12 | Release flow: keep tasks as-is (byte-identical to clog's); no publish until owner green-light                                     | med   | S      | low  |
| 11 | JSDoc + `@module` docs on every public export, `@example` on factories (JSR score)                                                | med   | M      | low  |

## Findings & recommendations (detailed)

### 1. Subpath exports need a deliberate deno.json ↔ npmbuild alignment; the build script's `[""]` dependency placeholder is a verified no-op, but must become a real decision

- **Problem / observation.** Two related issues.
  (a) `scripts/build-npm.ts:9` passes `dependencies: versionizeDeps([""], denoJson)`.
  `versionizeDeps` maps each entry: `""` has no `@` at index > 0, is not in `imports`,
  and passes through unchanged — so npmbuild receives `[""]`, and since
  `Array.isArray(dependencies) && dependencies.length > 0` is true it runs
  `npm install ""` (npm-build.ts:445-446). **Verified (npm 11.19.0): `npm install ""` is
  a silent no-op** — exit 0, nothing installed, no dependency written — so the build is
  not broken today. The placeholder is still meaningless and must be replaced with the
  finding-9 decision (or an empty array) rather than left to luck across npm versions.
  (b) DESIGN §2 specifies three export subpaths (`.`, `./adapters`, `./cache`) but the
  scaffold's deno.json has only `"exports": "./src/mod.ts"`, and nothing wires the npm
  side. npmbuild generates npm `exports` from `entryPoints`, where each entry `name` maps
  to `src/{name}.ts` → export key `./{name}` (`"mod"` → `"."`) — flat names only
  (npm-build.ts:172-176, 356-364). So the Deno and npm export maps stay in sync only if
  the entry files are **flat barrels** directly under `src/`.
- **Evidence** — DESIGN §2 (suggested exports); /Users/mm/projects/@marianmeres/page-fetcher/scripts/build-npm.ts:9;
  /Users/mm/projects/@marianmeres/npmbuild/npm-build.ts:87-104 (`versionizeDeps` — signature
  `versionizeDeps(deps: string[], denoJsonOrPath?: string | Record<string, unknown>): string[]`,
  confirmed also in npmbuild README), :172-176 (`entryPoints` contract), :356-366
  (exports map generation), :445-446 (`npm install ...deps`); npmbuild README "Multiple
  Entry Points" section; `npm install ""` no-op verified in a scratch dir 2026-08-23.
- **Proposed change.**
  1. deno.json exports map:
     ```jsonc
     "exports": {
       ".": "./src/mod.ts",
       "./adapters": "./src/adapters.ts",
       "./cache": "./src/cache.ts"
     }
     ```
  2. Flat barrel files (they only re-export; internal modules live in subdirectories —
     final internal layout is owned by the 01/architecture dimension doc):
     - `src/adapters.ts` — `export { createHttpAdapter } from "./adapters/http.ts";
       export { createBrowserAdapter } from "./adapters/browser/mod.ts";` (+ types).
       Safe because the browser driver is lazily imported inside `createBrowserAdapter`
       (DESIGN §2, §5.2), so the barrel never pulls a driver at module load.
     - `src/cache.ts` — `export { createMemoryCache } from "./cache/memory.ts";
       export type { CacheStore, CachedEntry } from "./cache/types.ts";`
  3. `scripts/build-npm.ts` rewritten:
     ```ts
     import { npmBuild, versionizeDeps } from "@marianmeres/npmbuild";

     const denoJson = JSON.parse(Deno.readTextFileSync("deno.json"));

     await npmBuild({
     	name: denoJson.name,
     	version: denoJson.version,
     	repository: denoJson.name.replace(/^@/, ""),
     	entryPoints: ["mod", "adapters", "cache"],
     	// see finding 9 for the clog decision:
     	dependencies: versionizeDeps(["@marianmeres/clog"], denoJson),
     });
     ```
- **Affected files** — deno.json, scripts/build-npm.ts, src/adapters.ts (new), src/cache.ts (new).
- **Effort / Value / Risk** — S / high / low.
- **Implementation notes.** npmBuild's default `rootFiles` already copies `LICENSE`,
  `README.md`, `API.md`, `AGENTS.md`, `CLAUDE.md`, and the whole `docs/` directory into
  the npm package (npm-build.ts:222-229) — the doc plan in findings 6/7/10 ships to npm
  for free; no `rootFiles` override needed. Keep `entryPoints[0] = "mod"` (it becomes
  `main`/`types`, npm-build.ts:366).

### 2. Retry, circuit-breaker, and timeout tests run on FakeTime against a stub `next` — no fixture server, no real sleeps

- **Problem / observation.** DESIGN §10 requires fake timers for retry/backoff tests. The
  clean way to satisfy it falls out of the layer contract: `withRetry(opts)(next)` is
  exercised with `next = stub FetchFn` that fails N times then succeeds (or returns 429
  results with `Retry-After`), while `FakeTime` advances the clock. Verified on Deno 2.9.5:
  - `jsr:@std/testing@^1/time` exports `FakeTime`; `new FakeTime()` +
    `await t.tickAsync(5000)` fires a pending 5 s `setTimeout` (checked by eval).
  - `FakeTime` also drives `AbortSignal.timeout(1000)` — `signal.aborted === true` after
    `tickAsync(2000)` (checked by eval). So the per-attempt timeout guard may use either
    `AbortSignal.timeout` or a manual `setTimeout`+`AbortController`; both are fake-timer
    testable **on Deno**. Caution: this is runtime-specific behavior — if the guard ever
    needs to be tested under Node/sinon, only the manual `setTimeout` variant is fakeable;
    prefer the manual variant in src for that reason (final call belongs to the guards
    dimension — one-line pointer, not duplicated here).
  - `AbortSignal.any` exists (needed for caller-signal + timeout composition, DESIGN §7).
  - `FakeTime` patches `Date` (checked by eval: `Date.now()` advances exactly with
    `tickAsync`), so `Retry-After: <http-date>` tests compute the date against the same
    faked clock — coherent by construction.
- **Evidence** — DESIGN §6, §10; `deno eval` runs 2026-08-23 (Deno 2.9.5): FakeTime tick,
  FakeTime × `AbortSignal.timeout`, FakeTime × `Date.now`,
  `typeof AbortSignal.any === "function"`. Version pin convention:
  /Users/mm/projects/@marianmeres/tracker/deno.json:25
  (`"@std/testing": "jsr:@std/testing@^1.0.18"`).
- **Proposed change.** `tests/retry.test.ts` and `tests/circuit-breaker.test.ts` use
  **only** stub `FetchFn`s + `FakeTime`; they must not import the fixture server. Pattern:
  ```ts
  import { FakeTime } from "@std/testing/time";
  Deno.test("exponential backoff with full jitter stays within bounds", async () => {
  	using time = new FakeTime(); // FakeTime implements [Symbol.dispose]
  	const delays: number[] = [];
  	const fetchFn = withRetry({
  		attempts: 3,
  		baseDelay: 500,
  		onRetry: (i) => delays.push(i.delay),
  	})(failNTimes(2, okResult()));
  	const p = fetchFn({ url: "http://x/" });
  	await time.tickAsync(60_000);
  	const res = await p;
  	assertEquals(res.attempts, 3);
  	// jitter: 0 <= delay <= base * 2^attempt, capped by maxDelay
  });
  ```
  Key cases (details in finding 4's matrix): backoff shapes (exponential / linear /
  fixed / custom fn), jitter bounds, `maxDelay` cap, `respectRetryAfter` with seconds AND
  http-date, full retryable classification table from DESIGN §6, deadline-aware "never
  sleep past deadline, fail fast", abort **during** the retry sleep (must reject with
  `kind: "aborted"` promptly at fake-time of abort), `onRetry` invocation shape; breaker:
  opens after N consecutive per-host failures, fail-fast result kind/`retryable: false`,
  half-open probe after cooldown (`tickAsync(cooldown)`), per-host isolation.
- **Affected files** — tests/retry.test.ts, tests/circuit-breaker.test.ts, tests/helpers.ts
  (stub `FetchFn` builders: `okResult`, `httpResult(status, headers)`, `failNTimes`,
  `neverResolves(signal)`).
- **Effort / Value / Risk** — S (per test-writing session; enabling pattern) / high / low.
- **Implementation notes.** `using time = new FakeTime()` guarantees `restore()` on test
  exit — verified: `FakeTime` exposes a `[Symbol.dispose]` function on Deno 2.9.5 /
  @std/testing 1.0.18. Add `"@std/testing": "jsr:@std/testing@^1.0.18"` to imports
  (finding 8). Do not let any real `setTimeout` leak into these tests — the Deno test
  sanitizers (timer/op leak detection, on by default) will fail the test if a retry sleep
  escapes the faked clock, which is exactly the guard we want.

### 3. One fixture server module: `Deno.serve` on port 0, dual origin, kill-switch shutdown, hand-gzipped bodies

- **Problem / observation.** DESIGN §10 requires a local fixture server with zero external
  network. Platform facts verified 2026-08-23 (Deno 2.9.5, all network-free evals):
  - `Deno.serve({ port: 0, hostname: "127.0.0.1" })` works; `server.addr` is
    `{ hostname, port, transport }` — read the real port from `server.addr.port`.
    (Default hostname is `0.0.0.0` — always pass `127.0.0.1` explicitly.)
  - **`Deno.serve` does not auto-compress**: raw-socket GET with
    `Accept-Encoding: gzip, br` against a 4 KB `text/html` string body AND an 8 KB
    streamed body both came back with no `content-encoding` (string body:
    `content-length: 4096`; streamed: `transfer-encoding: chunked`). Reproduced
    independently during the verify pass — same result. The gzip fixture must hand-encode.
  - `CompressionStream("gzip")` round-trips (magic bytes `1f 8b` observed; decompressed
    back to the source string) — so hand-gzipping needs no dependency.
  - Scoped `--allow-net=127.0.0.1` covers both listening on port 0 and connecting to the
    random port (verified in one probe run under exactly that flag).
- **Evidence** — DESIGN §10; probe runs listed above; DESIGN §7 (Authorization drop
  across origins → needs a second origin; origin = scheme+host+port, so a second server
  on another random 127.0.0.1 port suffices).
- **Proposed change.** `tests/fixtures/server.ts`:
  ```ts
  export interface FixtureServer {
  	origin: string; // "http://127.0.0.1:<port>"
  	url(path: string): string;
  	/** secondary origin (second Deno.serve on its own random port) for cross-origin tests */
  	origin2: string;
  	url2(path: string): string;
  	/** aborts hanging/slow handlers, then shuts both servers down */
  	shutdown(): Promise<void>;
  }
  export async function startFixtureServer(): Promise<FixtureServer>;
  ```
  Internals: one shared `AbortController` ("kill switch"); every artificial delay is
  `abortableDelay(ms, kill.signal)`. This matters: `Deno.serve().shutdown()` waits for
  in-flight handlers, so a `/hang` route would deadlock teardown without it.
  `shutdown()` = `kill.abort(); await Promise.all([a.shutdown(), b.shutdown()])`.
  Stateful routes key their counters by a caller-supplied `token` query param in a
  server-side `Map`, so parallel test cases never share state.

  Route table (primary origin unless noted):

  | Route                              | Behavior                                                                        | Exercises                                                  |
  | ---------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------- |
  | `GET /ok`                          | 200, `text/html; charset=utf-8`                                                 | baseline                                                   |
  | `GET /status/:code`                | echoes status, tiny body                                                        | non-2xx `ok:false`, classification                         |
  | `GET /echo`                        | 200 JSON of method/headers/body                                                 | default UA, header pass-through, POST                      |
  | `GET /redirect/:n`                 | chain of n 302 hops → `/ok` (mix relative + absolute `Location`)                | chain recording, `finalUrl`, `maxRedirects`                |
  | `GET /redirect-loop`               | `/a` ↔ `/b` 302 loop                                                            | loop detection → `too-many-redirects`                      |
  | `GET /redirect-cross`              | 302 → `origin2 + /echo-headers`                                                 | **Authorization drop cross-origin**                        |
  | `GET /echo-headers` (origin2)      | 200 JSON of received headers                                                    | assert `authorization` absent/present                      |
  | `GET /slow?ms=N&token=`            | abortable delay N ms, then 200                                                  | per-attempt timeout, deadline                              |
  | `GET /hang?token=`                 | never responds (awaits kill signal)                                             | timeout with no response at all                            |
  | `GET /trickle?chunks=N&ms=M`       | streamed body, one chunk per M ms (abortable)                                   | mid-body abort propagation, download timing                |
  | `GET /cp1250`                      | raw windows-1250 bytes, `Content-Type: text/html; charset=windows-1250`         | charset from header                                        |
  | `GET /cp1250-meta`                 | same bytes, `Content-Type: text/html` (no charset), `<meta http-equiv>` in body | charset from meta, in cp1250                               |
  | `GET /meta-charset`                | utf-8 body, charset only via `<meta charset>` within first 2 KB                 | meta sniffing order                                        |
  | `GET /bom`                         | UTF-8 BOM prefixed body, no charset anywhere                                    | BOM detection                                              |
  | `GET /gzip`                        | body pre-gzipped via `CompressionStream`, explicit `Content-Encoding: gzip`     | platform decompression path                                |
  | `GET /big?bytes=N&chunk=K`         | streamed N bytes in K-byte chunks (chunked, no content-length)                  | `maxBytes` streaming abort                                 |
  | `GET /rate-limited?fails=N&token=` | 429 + `Retry-After: 0` for N calls, then 200                                    | retry integration smoke (no fake timers)                   |
  | `GET /retry-after-date?token=`     | 429 + `Retry-After: <IMF-fixdate ~2 s ahead>` once, then 200                    | http-date parsing (integration; unit variant in finding 2) |
  | `GET /etag?token=`                 | 200 + `ETag: "v1"`; `If-None-Match: "v1"` → 304 empty                           | conditional flow, `notModified`                            |
  | `GET /last-modified?token=`        | same via `Last-Modified` / `If-Modified-Since`                                  | conditional flow variant                                   |
  | `GET /flaky?fails=N&token=`        | 500 × N then 200                                                                | retry integration, breaker half-open                       |
  | `GET /json`, `GET /binary`         | `application/json` / `application/octet-stream`                                 | content-type policy, `skip-body`                           |
  | `HEAD /ok`                         | headers only                                                                    | HEAD support                                               |

  > **Cut from the draft:** a `/big-cl` route for an "optional early content-length bail"
  > — DESIGN §7 specifies `maxBytes` enforcement _while streaming_ only; a pre-check on
  > `content-length` is unspecified speculation. Add the route later if the guards
  > dimension adopts such a bail.

- **Affected files** — tests/fixtures/server.ts (new), tests/fixtures/bytes.ts (new — see
  finding 4 for the cp1250 byte fixture).
- **Effort / Value / Risk** — M / high / low.
- **Implementation notes.** Start one `FixtureServer` per test **file** (top-level
  `await startFixtureServer()` + `Deno.test` steps, or a shared `beforeAll`-style helper),
  never a fixed port. Deno's default resource sanitizer will flag leaked connections —
  keep it enabled; it doubles as a free "adapter closed its readers" assertion. The
  `Retry-After` http-date route computes `new Date(Date.now() + 2000).toUTCString()`
  against the real clock — that route is only for the no-fake-timer integration smoke;
  unit-level date parsing lives in finding 2's stub tests. Do not use `localhost` anywhere
  (keeps the net allowlist to a single literal, finding 8).

### 4. Concrete test matrix — 12 files, keyed to modules; windows-1250 fixture as raw bytes

- **Problem / observation.** DESIGN §10 lists requirements but not a file plan. One
  encoding fact forces a specific fixture technique: `TextEncoder` is UTF-8-only
  (verified: `new TextEncoder().encoding === "utf-8"`; the WHATWG Encoding spec removed
  legacy encoders), so a windows-1250 page **cannot be produced by encoding a JS
  string** — it must be stored as literal bytes. Verified the decode side: Deno's
  `TextDecoder("windows-1250")` maps bytes `E8 9A 9E F9 E1` → `čšžůá` (and
  `{ fatal: true }` is accepted).
- **Evidence** — DESIGN §7 (charset order, "Legacy central-European sites still serve
  windows-1250 — there must be a test fixture"), §10; `deno eval` decode check 2026-08-23.
  Module names below follow DESIGN §12's build order; the authoritative src layout is the
  01/architecture dimension doc (pointer only).
- **Proposed change.** `tests/fixtures/bytes.ts` builds cp1250 fixtures by concatenation:
  ASCII HTML skeleton via `TextEncoder` (ASCII bytes are identical in cp1250) spliced with
  a hard-coded high-byte word:
  ```ts
  /** "čšžůá" in windows-1250 — NOT producible via TextEncoder (utf-8 only) */
  export const CP1250_WORD = new Uint8Array([0xe8, 0x9a, 0x9e, 0xf9, 0xe1]);
  export function cp1250Page(opts?: { metaOnly?: boolean }): Uint8Array; // skeleton + word
  export const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);
  export async function gzipBytes(input: Uint8Array): Promise<Uint8Array>; // CompressionStream
  ```
  Test files and their key cases (fixture-server tests marked ⓕ, pure-unit ⓤ):

  | File                                              | Key cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
  | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `tests/http-adapter.test.ts` ⓕ                    | 200 basics; `ok:false` on 404/500 (no throw — the README decision, DESIGN §4); `throwOnHttpError` opt-in; redirect chain content + `finalUrl` + `redirects` excludes final; relative Location resolution; `maxRedirects` → `too-many-redirects`; loop detection; **Authorization dropped on cross-origin redirect, kept same-origin** (`/redirect-cross` + `/echo-headers`); default UA sent & overridable (`/echo`); HEAD; POST body; gzip transparently decoded (`/gzip`); `meta` echo |
  | `tests/charset.test.ts` ⓕ                         | header charset (`/cp1250`); meta charset in cp1250 body (`/cp1250-meta`); `<meta charset>` utf-8 (`/meta-charset`); BOM (`/bom`); precedence header > BOM > meta > fallback; unknown label → utf-8 fallback, no throw; assert decoded text equals `"čšžůá"`                                                                                                                                                                                                                              |
  | `tests/guards.test.ts` ⓕ+ⓤ                        | `maxBytes` aborts mid-stream (`/big`, assert bytes read ≈ maxBytes, kind `too-large`, retryable false); content-type allow list; `onUnsupportedType: "skip-body"` returns headers-only result (`/binary`); per-attempt `timeout` (`/hang`, FakeTime where wired ⓤ, real 50 ms integration ⓕ); `deadline` < timeout interplay; caller `AbortSignal` propagates pre-response (`/hang`) and mid-body (`/trickle`) → kind `aborted`                                                          |
  | `tests/retry.test.ts` ⓤ                           | finding 2's list — stub `next` + FakeTime only                                                                                                                                                                                                                                                                                                                                                                                                                                           |
  | `tests/circuit-breaker.test.ts` ⓤ                 | finding 2's list                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
  | `tests/cache.test.ts` ⓕ+ⓤ                         | `createMemoryCache` store contract ⓤ; dev-cache hit → `fromCache: true`, no second network hit (server counter via `token`); key = method+URL+adapter (DESIGN §8 — key semantics owned by the cache dimension doc, pointer); ETag → `If-None-Match` → 304 → full result + `notModified: true` (`/etag`); `Last-Modified` variant                                                                                                                                                         |
  | `tests/fetcher.test.ts` ⓕ+ⓤ                       | `createFetcher` default stack composition order; multi-adapter + `selectAdapter(req)`; per-request `adapter` override; `FetcherEvents` fired per attempt with stable `requestId` across events of one logical request (DESIGN §9); `logger` calls when provided, silent default (finding 9's Logger — assert via array-collecting fake logger); `dispose()` idempotent + fans out to adapters                                                                                            |
  | `tests/errors.test.ts` ⓤ                          | `PageFetchError` shape: every `kind` constructible, `retryable` defaults per DESIGN §6 table, `cause` preserved                                                                                                                                                                                                                                                                                                                                                                          |
  | `tests/browser-pool.test.ts` ⓤ                    | **fake driver** (in-memory implementation of the §5.2 driver interface): acquire/release queue order; concurrency cap; per-page max-reuse recycling; crash mid-fetch → attempt marked retryable + relaunch on next acquire; a crashed browser never wedges waiting acquirers; dispose during in-flight; double-dispose idempotent. This file must not import any real driver                                                                                                             |
  | `tests/browser/browser-adapter.test.ts` (flagged) | real driver: goto + content; wait strategies incl. `networkidle` separate timeout; resource blocking on by default (count blocked requests); `onPage` hook `extra` passthrough; console-error capture                                                                                                                                                                                                                                                                                    |
  | `tests/browser/leak.test.ts` (flagged)            | launch → fetch N pages → `dispose()` → assert no orphaned browser processes (spec in finding 5)                                                                                                                                                                                                                                                                                                                                                                                          |
  | `tests/mod.test.ts` ⓤ                             | public surface smoke: the three barrels export exactly the documented names (guards against accidental API drift; replaces the placeholder sanity test)                                                                                                                                                                                                                                                                                                                                  |

- **Affected files** — all files named above; delete `tests/page-fetcher.test.ts` and
  `src/page-fetcher.ts` placeholders (verified contents: `name() → "it works"`).
- **Effort / Value / Risk** — M (spec) → L (writing them, spread across implementation
  steps per DESIGN §12) / high / low.
- **Implementation notes.** Follow DESIGN §12's order — each implementation step lands
  with its test file. Keep ⓤ files import-clean of `tests/fixtures/server.ts` so a
  failure bisects instantly to "logic vs I/O". `@std/assert` is already pinned
  (deno.json:17).

### 5. Browser suite: directory + env-flag double gate; pool logic tested against a fake driver; best-effort ps-scan leak test

- **Problem / observation.** DESIGN §10: browser tests behind a flag; explicit leak test.
  Two mechanics need care: (a) a merely-`ignore`d `Deno.test` still has its **module
  imported** during collection — a static `import ... from "npm:playwright"` in a test
  file would download the driver even in the default run, breaking "installing this
  package must never pull a browser" hygiene for contributors; (b) leak detection must
  not depend on driver internals (Playwright's `launch()` does not expose the process;
  Puppeteer's `browser.process()` does — driver-specific).
- **Evidence** — DESIGN §5.2, §10; `deno test --ignore` verified 2026-08-23 with a
  side-effect probe: a test module under the ignored directory that writes a marker file
  at module load was **neither run nor imported** (no marker), while the sibling ran.
  Env-prefix assignment in `deno task` verified (`BROWSER_TESTS=1 deno eval ...` printed
  the value). Also verified the failure mode the gate must avoid: a top-level
  `Deno.env.get(...)` under a permissionless non-interactive `deno test` run fails the
  file at collection (uncaught NotCapable) — hence the permission-safe gate below.
  `ps -eo pid,ppid,comm` verified on darwin ("assumed — verify on linux CI at
  implementation time"; both BSD and procps ps accept `-eo`).
- **Proposed change.**
  - Layout: flagged tests live in `tests/browser/`; the default task passes
    `--ignore=tests/browser` (finding 8) so they are neither run **nor imported**.
  - Belt-and-braces inside each browser test file (protects direct `deno test tests/`
    runs), permission-safe — query before reading so a permissionless run degrades to
    "ignored" instead of erroring (and never triggers an interactive prompt):
    ```ts
    const enabled =
    	Deno.permissions.querySync({ name: "env", variable: "BROWSER_TESTS" })
    		.state === "granted" && Deno.env.get("BROWSER_TESTS") === "1";
    Deno.test({ name: "...", ignore: !enabled, fn: async () => {
    	const { chromium } = await import("npm:playwright@^1"); // dynamic — never at module load
    	...
    }});
    ```
    Keep the driver specifier **out of deno.json `imports`** so `deno install` never
    pre-caches it.
  - Task: `"test:browser": "BROWSER_TESTS=1 deno test -A tests/browser/"` (env-prefix
    assignment verified in the deno task shell; `-A` because driver launch needs
    run/read/write/env/net).
  - Leak test (`tests/browser/leak.test.ts`), best-effort darwin/linux, skipped elsewhere:
    ```ts
    async function browserChildrenOf(pid: number): Promise<number[]> {
    	const out = await new Deno.Command("ps", { args: ["-eo", "pid,ppid,comm"] })
    		.output();
    	// filter rows: ppid === pid (or transitive) && /chrom|headless_shell|firefox|webkit/i
    }
    // launch adapter → fetch 3 fixture pages → dispose() → poll up to ~3s → assert []
    ```
    Best-effort by design: it catches the actual #1 complaint (orphaned Chromium after
    dispose, DESIGN §5.2) without pinning to one driver's API.
  - **Design win to state explicitly** (docs/architecture.md + this plan): because the
    browser adapter is written against the tiny internal driver interface, the pool,
    recycling, and crash-recovery logic — the hardest, flakiest part of browser tooling —
    is fully unit-tested by `tests/browser-pool.test.ts` against a fake driver in the
    **default, browserless** run. The flagged suite only proves the thin real-driver
    binding. This inverts the usual "browser tests are the only pool coverage" failure mode.
- **Affected files** — tests/browser/browser-adapter.test.ts, tests/browser/leak.test.ts,
  tests/browser-pool.test.ts, tests/fixtures/fake-driver.ts (new — in-memory driver with
  scriptable failures: `crashOnNthGoto(n)`, `hangOnGoto()`), deno.json (tasks).
- **Effort / Value / Risk** — M / high / med (real-driver flakiness is inherent; contained
  to the flagged suite).
- **Implementation notes.** The fake driver doubles as the reference implementation of the
  driver interface — document it in docs/tasks.md "add an adapter". Browser tests also
  consume the fixture server (real pages, zero external network): `-A` covers the net
  permission. Leak-poll uses real time (no FakeTime) — keep the poll short.

### 6. Agent docs: AGENTS.md + docs/{architecture,conventions,tasks}.md + CLAUDE.md redirect — with one guide-path correction

- **Problem / observation.** Owner explicitly requires agent docs. The guide's structure
  and token budgets are concrete (entry ~1,000 tokens; domain docs 500–2,000 each;
  declarative, tables, imperative mood). **Design gap in the guide itself:** §9 step 4 says
  `cp /Users/mm/projects/@marianmeres/marianmeres/mm-local-docs/CLAUDE_TEMPLATE.md CLAUDE.md`
  — that directory does not exist (verified: `ls` fails). The actual template is
  `/Users/mm/projects/@marianmeres/agents/mm-local-docs/CLAUDE_TEMPLATE.md` (verified: a
  3-line file redirecting to AGENTS.md). Sibling precedent confirms the shape: clog ships
  root-level AGENTS.md + CLAUDE.md + README.md + API.md (verified `ls`).
- **Evidence** — /Users/mm/projects/@marianmeres/agents/mm-local-docs/AGENT_DOCUMENTATION_GUIDE.md:17
  (budgets), :29-41 (structure), :47-74 (AGENTS.md template), :246-255 (§9, stale path);
  .../CLAUDE_TEMPLATE.md:1-3; /Users/mm/projects/@marianmeres/clog (root doc files).
- **Proposed change.** EXECUTE-phase doc tasks (written after the code stabilizes, per
  guide "examples match conventions"):
  - `AGENTS.md` (~1,000 tokens): Quick Reference (Stack: TypeScript/Deno-first/ESM,
    zero runtime deps; Test: `deno task test`; Browser tests: `deno task test:browser`;
    Build: `deno task npm:build`), Project Structure (src/ barrels + subdirs, tests/,
    tests/browser/ flagged), Critical Conventions (numbered: layers are
    `(next: FetchFn) => FetchFn`; no Deno APIs in src/; non-2xx resolves `ok:false`;
    single `PageFetchError` with `kind`; browser driver only ever dynamically imported;
    emit events — `logger` is optional and silent by default), Before Making Changes
    checklist, Documentation Index linking the three docs/ files + docs/design.md.
  - `docs/architecture.md` (≤2,000 tokens): the DESIGN §3 layer stack as an ASCII
    diagram; component map (adapters / guards / retry / breaker / cache / fetcher /
    events); data flow of one request incl. per-attempt event granularity; External
    Dependencies section stating the zero-runtime-dep rule + the type-only clog exception;
    the fake-driver testability property (finding 5).
  - `docs/conventions.md` (≤1,500 tokens): Do/Don't pairs — return `ok:false` vs throw;
    `import type { Logger }` vs value import; dynamic driver import vs static; error
    `kind` discrimination vs message matching; tabs / lineWidth 90 (deno.json fmt);
    explicit return types on all exports (JSR no-slow-types); tests: unit files must not
    import the fixture server.
  - `docs/tasks.md`: three procedures with Steps/Template/Checklist per guide §3.4 —
    "Add an adapter" (implement `Adapter`, register, test against fixture server; fake
    driver as reference), "Add a cache store" (implement `CacheStore`, contract tests),
    "Add a fixture route" (route table + token-keyed state + abortable delays).
  - `CLAUDE.md`: copy of the verified template (redirect to AGENTS.md), from the
    **corrected** path.
  - No docs/domains/ initially — the package is one domain; the guide's structure is
    explicitly adaptable ("Adapt to project needs").
- **Affected files** — AGENTS.md, CLAUDE.md, docs/architecture.md, docs/conventions.md,
  docs/tasks.md; remove docs/.gitkeep.
- **Effort / Value / Risk** — M / high / low.
- **Implementation notes.** Validate per guide §8 by tracing "add an adapter" through the
  docs. Do not fix the guide's stale §9 path from inside this repo — it lives in
  agents/mm-local-docs; flagged as an open question for the owner.

### 7. Human docs: README with the two required recipes and the two required "loud" notes, plus complete API.md

- **Problem / observation.** DESIGN itself mandates specific README content: the §5.3
  adapter-routing recipe and §8 cache-backing recipe ("Document how to back it with
  SQLite or the filesystem"), the §5.2 resource-blocking default "with a loud note in the
  docs", and the §4 decision "non-2xx is not an error" ("Decision to make explicit in the
  README"). The human guide fixes badges, section set, and README/API.md separation.
- **Evidence** — DESIGN §4 (decision callout), §5.2 (loud note), §5.3 (recipe), §7
  (default UA "document that users should set a contact URL"), §8 (recipe), §12 step 10;
  /Users/mm/projects/@marianmeres/agents/mm-local-docs/HUMAN_DOCUMENTATION_GUIDE.md:24-28
  (badges), :32-40 (required sections), :88 (API.md is not a JSDoc dump).
- **Proposed change.** EXECUTE-phase; README.md outline (order):
  1. Title + badges (exact guide form): NPM shield `page-fetcher`, JSR badge
     `@marianmeres/page-fetcher`, license shield.
  2. One-liner + 3-sentence positioning ("transport primitive; a crawler sits on top;
     knows nothing about links").
  3. Install: `deno add jsr:@marianmeres/page-fetcher`, `npx jsr add`, `npm i` — plus a
     **loud note**: the browser driver is an optional peer, never installed with the
     package; HTTP-only usage needs nothing else.
  4. Quick start: `createFetcher` + one `fetch()` + reading `finalUrl`/`text()`.
  5. **Not-an-error note** (blockquote): non-2xx resolves with `ok: false`;
     `throwOnHttpError` opt-in. Verbatim per DESIGN §4.
  6. Browser adapter section incl. the **resource-blocking loud note** (blocked by
     default: image/media/font/stylesheet; why; how to disable) and the zombie-cleanup /
     dispose contract.
  7. Recipe: adapter routing (§5.3) — cheap HTTP first, escalate to browser on
     JS-rendered HTML, or route by URL pattern; runnable snippet.
  8. Recipe: backing the cache (§8) — `CacheStore` is 3 methods; filesystem-backed
     example sketch and a note on SQLite, no dependency taken.
  9. Logging: default silent; pass any console-compatible logger —
     `createFetcher({ logger: createClog("fetcher") })` and `logger: console`; note
     events (`FetcherEvents`) remain the structured channel, logger is convenience.
  10. Default User-Agent note: identify your tool, set a contact URL (DESIGN §7).
  11. `## API` → link to API.md; `## License` → MIT.

  API.md: complete reference per guide structure — Functions (`createFetcher`,
  `createHttpAdapter`, `createBrowserAdapter`, `createMemoryCache`, the standalone layer
  factories), Types (`FetchRequest`, `FetchResult`, `FetchTiming`, `Adapter`,
  `RetryOptions`, `CacheStore`, `FetcherEvents`, `PageFetchError` kinds table from
  DESIGN §6), Constants (default allow-list, default UA, defaults table). One example per
  function, parameters with defaults.
- **Affected files** — README.md (currently empty scaffold), API.md (new).
- **Effort / Value / Risk** — M / high / low.
- **Implementation notes.** README examples must be copy-paste runnable against JSR
  specifiers. npmbuild ships both files automatically (finding 1). Keep README ≲ 250
  lines; everything exhaustive goes to API.md (guide: "link, don't duplicate").

### 8. deno.json: dependency pins and scoped test-task permissions

- **Problem / observation.** The scaffold lacks: the clog pin (owner requirement),
  @std/testing (finding 2), a permission-scoped test task (fixture server needs net), and
  browser-suite exclusion. Bare `deno test` would also discover future stray test files
  outside tests/.
- **Evidence** — deno.json:5-20 (current tasks/imports); clog version verified:
  /Users/mm/projects/@marianmeres/clog/deno.json:3 (`3.21.0`); pin style precedent:
  /Users/mm/projects/@marianmeres/collection/deno.json:16
  (`"@marianmeres/clog": "jsr:@marianmeres/clog@^3.21.0"`); @std/testing pin precedent:
  tracker/deno.json:25 (`^1.0.18`); scoped `--allow-net=127.0.0.1` verified sufficient
  for listen+connect (finding 3); `--ignore` verified (finding 5).
- **Proposed change** (deno.json deltas only):
  ```jsonc
  "tasks": {
  	"test": "deno test --allow-net=127.0.0.1 --ignore=tests/browser tests/",
  	"test:watch": "deno test --watch --allow-net=127.0.0.1 --ignore=tests/browser tests/",
  	"test:browser": "BROWSER_TESTS=1 deno test -A tests/browser/",
  	// npm:build, npm:publish, release, publish, rp, rpm — unchanged
  },
  "imports": {
  	"@marianmeres/clog": "jsr:@marianmeres/clog@^3.21.0",
  	"@marianmeres/npmbuild": "jsr:@marianmeres/npmbuild@^1.16.0",
  	"@std/assert": "jsr:@std/assert@^1.0.19",
  	"@std/fs": "jsr:@std/fs@^1.0.24",
  	"@std/path": "jsr:@std/path@^1.1.6",
  	"@std/testing": "jsr:@std/testing@^1.0.18"
  }
  ```
  No `--allow-env` in the default task: browser files are excluded by `--ignore` before
  collection (verified — not even imported, finding 5), and no other test reads env —
  smallest possible grant. The in-file env gate (finding 5, permission-safe form) only
  matters under `test:browser`/manual runs, which grant `-A`.
- **Affected files** — deno.json.
- **Effort / Value / Risk** — S / med (unblocks everything else) / low.
- **Implementation notes.** `Logger` is imported type-only
  (`import type { Logger } from "@marianmeres/clog"`) — verified the interface exists and
  is console-shaped: clog/src/clog.ts:186-217 (`debug/log/warn/error`, arg-variadic,
  `any`-returning so `console` structurally satisfies it), re-exported via clog/src/mod.ts:10
  (`export * from "./clog.ts"`). Re-export it from our mod.ts for consumers:
  `export type { Logger } from "@marianmeres/clog";`. Do NOT add a playwright/puppeteer
  entry to `imports` (finding 5). The `logger?: Logger` option threading itself (which
  factories, what gets logged at which level) belongs to the core-API dimension doc —
  pointer only.

### 9. npm packaging of the type-only clog dependency — precedent says "regular dependency", but it bends DESIGN §2's wording (owner call)

- **Problem / observation.** The user requirement accepts clog as a compile-time dep in
  deno.json, but is silent on the **npm artifact**. The emitted `.d.ts` will contain
  `import type { Logger } from "@marianmeres/clog"` — consumers' tsc must resolve it, so
  it cannot simply be omitted. Options: (A) declare as a regular npm dependency —
  exactly what sibling packages do for clog (fts and connection-monitor both pass
  `versionizeDeps(["@marianmeres/clog", ...])`); clog's npm artifact is tiny and itself
  dependency-free, but `npm install @marianmeres/page-fetcher` then installs one package,
  technically bending DESIGN §2's "zero required runtime dependencies" (the runtime
  import is erased; the dep is types-only in effect). (B) optional peerDependency
  (npmbuild supports `peerDependencies` string[] with `--no-save` build-time install +
  `peerDependenciesMeta`, npm-build.ts:141-167, 449-455): package.json stays
  dependency-free, but consumers without `skipLibCheck` who don't install clog hit TS2307
  on our `.d.ts` — consumer-hostile, rejected. (C) vendor a structurally identical local
  `Logger` interface (no clog import at all): literal zero deps everywhere; clog loggers
  still satisfy it structurally; but it deviates from the stated "import type from
  @marianmeres/clog" requirement.
- **Evidence** — /Users/mm/projects/@marianmeres/fts/scripts/build-npm.ts and
  .../connection-monitor/scripts/build-npm.ts (both list `"@marianmeres/clog"` in
  `dependencies: versionizeDeps([...])`); npmbuild npm-build.ts:141-167 (peer-dep
  contract), :449-455 (`--no-save` install), :445-446 (dep install); DESIGN §2 ("Zero
  required runtime dependencies"); shared-context user requirement (type-only import,
  "accepted" for deno.json).
- **Proposed change.** **Recommend (A)**: `dependencies:
  versionizeDeps(["@marianmeres/clog"], denoJson)` in scripts/build-npm.ts (as already
  shown in finding 1), and one README sentence: "the only dependency is
  `@marianmeres/clog`, used purely for its `Logger` type — no code from it runs unless
  you pass a clog logger yourself." Note the JSR side is equivalent either way: JSR
  publishes the TS source, so the jsr dependency on clog is visible there regardless —
  (C) is the only option that removes it, which is precisely why the owner should confirm.
  **Design deviation (flagged, not silent):** (A) means the npm `package.json` lists one
  dependency, against the literal DESIGN §2 sentence. Rationale for accepting: ecosystem
  precedent, robust consumer type-checking, and the requirement's own acceptance of clog
  as a compile-time dep. If the owner wants the literal zero, switch to (C) — a 6-line
  local interface — with zero code impact elsewhere (structural typing).
- **Affected files** — scripts/build-npm.ts, README.md (one sentence), src/types.ts (only
  under option C).
- **Effort / Value / Risk** — S / med / low.
- **Implementation notes.** Under (A), npmbuild's string[] form runs
  `npm install @marianmeres/clog@^3.21.0` in the out dir during build, so tsc resolves the
  `.d.ts` import naturally — no tsconfig tricks needed.

### 10. Promote the design sketch to `docs/design.md` — `tmp/` is gitignored and the repo has zero commits

- **Problem / observation.** `.gitignore:5` is `tmp/*`. The authoritative design doc
  currently lives at `tmp/page-fetcher-DESIGN.md`, so the first commit will silently
  exclude the package's founding document. There is no git history to recover it from
  (pre-first-commit scaffold, no commits — verified git status).
- **Evidence** — /Users/mm/projects/@marianmeres/page-fetcher/.gitignore:5; repo status
  (no commits); npmbuild rootFiles default includes `docs/` (npm-build.ts:222-229) so a
  promoted copy also ships to npm.
- **Proposed change.** During EXECUTE, copy to `docs/design.md` with a short prepended
  header: original design sketch, date, and a "deviations" list linking the accepted
  findings from these analysis docs (at minimum finding 9's dependency decision and
  whatever other dimensions' accepted deviations are). Keep `tmp/` as scratch. Do not
  edit the sketch's substance — it documents intent; `docs/architecture.md` documents
  what was built.
- **Affected files** — docs/design.md (new).
- **Effort / Value / Risk** — S / med / low.
- **Implementation notes.** If the owner prefers a leaner npm tarball, docs/ can be
  excluded via an explicit `rootFiles` override — not recommended; sibling packages ship
  docs. Note the default also ships `docs/plan/` (these analysis docs) once committed —
  covered by the same open question below.

### 11. JSDoc on every public export + `@module` docs on all three entry points (JSR score)

- **Problem / observation.** JSR's package score rewards symbol-level docs and
  module-level docs on every entrypoint, and JSR's "no slow types" rule requires explicit
  types on exported symbols. The scaffold has none. clog shows the house style: a
  `@module` block on mod.ts (clog/src/mod.ts:1-9) and rich JSDoc with `@example` /
  `@param` / `@returns` on public symbols (clog/src/clog.ts:178-215).
- **Evidence** — clog/src/mod.ts:1-9, clog/src/clog.ts:178-215; JSR scoring/slow-types:
  "assumed — verify current JSR scoring rubric at publish time" (rubric is remote; the
  convention holds regardless).
- **Proposed change.** Convention (enforce via docs/conventions.md + review checklist):
  - `@module` JSDoc atop `src/mod.ts`, `src/adapters.ts`, `src/cache.ts` (2–5 lines,
    what + primary factory link via `{@linkcode ...}`).
  - Every exported function/class/interface/type: one-sentence summary, `@param`/
    `@returns` where non-obvious, and a runnable `@example` on the four factories
    (`createFetcher`, `createHttpAdapter`, `createBrowserAdapter`, `createMemoryCache`)
    plus `PageFetchError` (branching on `kind`).
  - Explicit return type annotations on all exports (slow-types); worth a
    `deno publish --dry-run` in the pre-release checklist to catch violations early.
- **Affected files** — all src/ entry + public-surface files (written alongside
  implementation, not as a docs afterthought).
- **Effort / Value / Risk** — M (amortized) / med / low.
- **Implementation notes.** `deno doc --lint src/mod.ts src/adapters.ts src/cache.ts`
  (verified: `--lint` exists on Deno 2.9.5 — "Output documentation diagnostics") can gate
  missing JSDoc in the pre-release checklist.

### 12. Release flow is already correct — confirm and freeze; nothing to build here

- **Problem / observation.** The scaffold's `release` / `publish` / `rp` / `rpm` tasks are
  byte-identical to clog's published setup (compared side by side): `release` via
  `jsr:@marianmeres/release`, `publish` = `deno publish && deno task npm:publish`
  (JSR primary, npm secondary), `rp`/`rpm` compose them. No CI publishing exists in the
  ecosystem (clog, collection, demino have no `.github/` — verified); releases are
  local-first. This part of the scaffold is sound — no change beyond finding 1's build
  script cleanup.
- **Evidence** — page-fetcher deno.json:5-14 vs clog deno.json:9-18 (identical task set);
  `.github` absence verified via `ls` on three siblings.
- **Proposed change.** Keep tasks unchanged. Process guardrails only: stay at `0.x` with
  no `deno task rp` / `publish` until the owner explicitly green-lights the first release;
  before that first release run the PRE_RELEASE_DOCS_UPDATE.md checklist plus
  `deno publish --dry-run` and a scratch-dir `npm i` smoke test of the `.npm-dist`
  tarball's three subpath imports (`.`, `./adapters`, `./cache`) under Node.
- **Affected files** — none (process note; lands in AGENTS.md "Before Making Changes").
- **Effort / Value / Risk** — S / med / low.
- **Implementation notes.** JSR + subpath exports on the Deno side need no npmbuild
  involvement — `deno publish` reads the deno.json exports map directly (finding 1's map
  is the single source of truth for both registries).

## Open questions / decisions needed

- **clog in the npm artifact** (finding 9): accept option A — declare
  `@marianmeres/clog@^3.21.0` as a regular npm dependency (ecosystem precedent: fts,
  connection-monitor), bending DESIGN §2's literal "zero required runtime dependencies"
  for a type-only, runtime-erased import — or require option C (vendored structural
  `Logger` interface, literal zero deps on both registries, deviating from the stated
  "import type from @marianmeres/clog" instruction)?
- **Design-doc promotion** (finding 10): promote `tmp/page-fetcher-DESIGN.md` to
  `docs/design.md` (it then also ships in the npm tarball via npmbuild's default
  rootFiles)? And should these analysis docs be committed under `docs/analysis/` the way
  @marianmeres/collection does (verified: collection has docs/analysis/)?
- **Leak-test rigor** (finding 5): is the best-effort `ps -eo pid,ppid,comm` scan
  (darwin/linux, skipped elsewhere) acceptable, or do you want a driver-pinned assertion
  (e.g. Puppeteer's `browser.process().pid` liveness check), accepting driver lock-in for
  that one test?
- **First real driver for the flagged suite** (finding 5): Playwright, Puppeteer, or both
  from day one? (Affects only `tests/browser/`; the fake-driver unit suite is
  driver-agnostic either way.)
- **Stale guide path** (finding 6): AGENT_DOCUMENTATION_GUIDE.md §9 points at
  `/Users/mm/projects/@marianmeres/marianmeres/mm-local-docs/CLAUDE_TEMPLATE.md`, which
  does not exist; the real template is under `.../agents/mm-local-docs/`. Fixing the
  guide is outside this repo — do you want that corrected in agents/mm-local-docs?

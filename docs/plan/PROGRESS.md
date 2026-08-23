<!--
GENERATED ANALYSIS — @marianmeres/page-fetcher implementation plan
Produced 2026-08-23 by multi-agent research -> adversarial verify -> synthesize.
Claims verified against the design doc (tmp/page-fetcher-DESIGN.md), local ecosystem
sources, and platform checks. Repo is a pre-first-commit scaffold; no code was changed.
-->

# Implementation Progress — page-fetcher v1

Living tracker for acting on [`00-overview-and-roadmap.md`](./00-overview-and-roadmap.md).
A fresh conversation should read this file first, then the relevant `NN-*.md` section
for the verified detail.

**Status legend:** ⬜ not started · 🚧 in progress · ⏸️ blocked/awaiting decision ·
✅ done · ⏭️ deferred

> Convention: one commit per task. Each task resolves its source doc's "Open questions"
> first (record the call in the Decisions log below), then implement → test → tick here
> **immediately as the task completes** — never batch status updates.

> **Branching note (repo has ZERO commits):** the very first act is the initial commit
> of the scaffold + this plan (task 1). Work proceeds directly on `master` — greenfield,
> nothing to break, no reviewer to isolate from (decision 1 below).

---

## First sprint (contracts + a complete, tested HTTP-only fetcher core)

Branch: `master`

| # | Task                                                                                                                                                                                                                                                                                                               | Source                                                                                         | Status | Commit    |
| - | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------ | --------- |
| 1 | Repo groundwork: initial commit of scaffold + plan; deno.json exports map + flat barrels, clog/@std/testing pins, scoped test tasks; replace build-npm.ts `[""]` placeholder; decide `docs/design.md` promotion                                                                                                    | [06](./06-testing-docs-tooling.md) #1/#8/#10/#12                                               | ✅     | `187ee5b` |
| 2 | Public contracts: `src/types.ts` + `src/errors.ts` + `src/internal.ts` (`requestId` end-to-end, eager-bytes/lazy-decode body, `retainBody`/`hasBody`, kind union incl. `circuit-open`/`no-body`, `ObservabilityOptions`, `mod.ts` surface) + `tests/errors.test.ts`, `tests/mod.test.ts`                           | [01](./01-public-contracts.md) #1–#10                                                          | ✅     | `db25e24` |
| 3 | Fixture server + test helpers: `tests/fixtures/server.ts` (port 0, dual origin, kill switch, hand-gzip, token-keyed routes), `tests/fixtures/bytes.ts` (raw windows-1250), `tests/helpers.ts` (stub `FetchFn`s, fake logger)                                                                                       | [06](./06-testing-docs-tooling.md) #2/#3/#4                                                    | ✅     | `e27a909` |
| 4 | HTTP adapter + stream helpers: `src/read-body.ts`, `src/content-type.ts`, `src/charset.ts`, `src/adapters/http.ts` (redirect loop, UA, timing) + `tests/http-adapter.test.ts`, `tests/charset.test.ts`                                                                                                             | [02](./02-http-adapter-and-guards.md) #1/#2/#4/#6/#7/#8                                        | ✅     | `df183a7` |
| 5 | Wrapper guards + retry: `src/guards.ts` (timeout/deadline, `composeSignal`, typed abort reasons), `src/utils.ts` (`sleep`, `resolveDeadline`), `src/retry.ts` (`RetryOutcome` either/or, classification table, `Retry-After`, deadline fail-fast) + FakeTime tests (`tests/guards.test.ts`, `tests/retry.test.ts`) | [02](./02-http-adapter-and-guards.md) #3/#5; [03](./03-resilience-and-composition.md) #3/#4/#9 | ✅     | `1012aad` |

**Sprint complete (2026-08-23).** The HTTP-only core is implemented and tested: 66
tests / 57 steps green, `deno lint`, `deno fmt --check` and `deno publish --dry-run`
(no slow types) all clean. The unit suites (`retry`, `guards`, `errors`, `internal`,
`mod`) never open a socket; the integration suites run against the local fixture server
only. Not yet built, by design: the circuit breaker, `compose()`/`createFetcher`, the
browser subsystem, and the cache — see the backlog.

---

## Backlog (ranked, post-sprint — full path to v1)

| Rank | Task                                                                                                                                                                                                                                                                                    | Source                                                                                      | Status |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------ |
| 6    | Circuit breaker: `src/circuit-breaker.ts` (per-instance `Map`, logical-outcome counting, half-open single probe, map hygiene, `circuit-open` rejections) + FakeTime tests                                                                                                               | [03](./03-resilience-and-composition.md) #5, [06](./06-testing-docs-tooling.md) #2          | ✅     |
| 7    | Composition: `src/compose.ts`, `src/events.ts` (+ `safeEmit`), `src/fetcher.ts` (`createFetcher`, adapter routing, dispose + `Symbol.asyncDispose`, event/logger bridging) + `tests/fetcher.test.ts`. Resolves the 01/03 event-granularity call first (see overview completeness check) | [03](./03-resilience-and-composition.md) #1/#2/#6/#7/#10; [01](./01-public-contracts.md) #3 | ✅     |
| 8    | Browser driver: `src/adapters/browser/driver.ts` (structural `BrowserDriver`), `drivers/playwright.ts` + `drivers/puppeteer.ts` bridges, `tests/fixtures/fake-driver.ts` (scriptable in-memory driver)                                                                                  | [04](./04-browser-adapter.md) #1/#2                                                         | ✅     |
| 9    | Browser adapter (single context): `browser-adapter.ts` orchestration, `wait.ts` (soft-hybrid networkidle), `blocking.ts` (on by default), result mapping (`finalUrl`/`extra.pageUrl`, serialized-DOM `bytes()`), `onPage` + bounded capture + unit tests vs fake driver                 | [04](./04-browser-adapter.md) #4/#5/#6/#8                                                   | ✅     |
| 10   | Browser pool + lifecycle: `pool.ts` (epochs, recycling, waiter queue, "never wedge" invariant), `exit-hook.ts` (feature-detected, re-raise protocol) + `tests/browser-pool.test.ts` vs fake driver                                                                                      | [04](./04-browser-adapter.md) #3/#7                                                         | ✅     |
| 11   | Flagged real-browser suite: `tests/browser/` (double gate: `--ignore` + `BROWSER_TESTS=1`), adapter smoke vs fixture server, ps-scan leak test                                                                                                                                          | [06](./06-testing-docs-tooling.md) #5; [04](./04-browser-adapter.md) #7                     | ✅     |
| 12   | Cache layer: `src/cache/{types,key,memory,layer,serialize}.ts` (versioned `CachedEntry`, GET-only keys, dev/conditional state machine, 304 freshen, synthesis matrix, LRU memory store) + `tests/cache.test.ts`; wire `cache` option into `createFetcher`                               | [05](./05-cache-layer.md) #1–#8                                                             | ⬜     |
| 13   | JSDoc pass: `@module` docs on all three entry points, `@example` on the factories + `PageFetchError`, explicit return types (JSR no-slow-types), `deno doc --lint` gate                                                                                                                 | [06](./06-testing-docs-tooling.md) #11                                                      | ⬜     |
| 14   | Agent docs: `AGENTS.md` (~1k tokens), `docs/architecture.md`, `docs/conventions.md`, `docs/tasks.md`, `CLAUDE.md` redirect (from the corrected template path)                                                                                                                           | [06](./06-testing-docs-tooling.md) #6                                                       | ⬜     |
| 15   | Human docs: `README.md` (badges, §5.3 routing + §8 cache-backing recipes, resource-blocking + non-2xx loud notes, logger section, UA contact note) + complete `API.md`                                                                                                                  | [06](./06-testing-docs-tooling.md) #7                                                       | ⬜     |
| 16   | Promote `tmp/page-fetcher-DESIGN.md` → `docs/design.md` with the accepted-deviations list (finalize once backlog decisions are recorded)                                                                                                                                                | [06](./06-testing-docs-tooling.md) #10                                                      | ⬜     |
| 17   | Pre-release checks (NO publish without explicit owner green-light): PRE_RELEASE_DOCS_UPDATE checklist, `deno publish --dry-run`, scratch-dir `npm i` smoke of the three subpath imports under Node                                                                                      | [06](./06-testing-docs-tooling.md) #12                                                      | ⬜     |

---

## Decisions log

- **2026-08-23** — Plan reviewed; first sprint (tasks 1–5) executed. All open questions
  blocking the sprint were resolved by taking each source doc's own recommendation
  (rationale restated below, so a later reader need not re-derive it). Decisions that
  only affect backlog tasks are listed at the end as still open.

  1. **Branch model → `master` directly.** Repo had zero commits; there is nothing to
     isolate a greenfield sprint from, and a sprint branch would only add a merge.
  2. **clog in the npm artifact → option A, regular npm dependency**
     (`@marianmeres/clog@^3.21.0` in `scripts/build-npm.ts`). The import is type-only
     and erased at runtime, but the emitted `.d.ts` references `Logger`, so consumers'
     `tsc` must resolve it; the alternatives are consumer-hostile (peer dep → TS2307
     without `skipLibCheck`) or drift-prone (vendored copy). Bends DESIGN §2's literal
     "zero required runtime dependencies" — recorded as an accepted deviation in
     [`docs/design.md`](../design.md). ([06](./06-testing-docs-tooling.md) #9)
  3. **Observability contract → doc 01's reading, ratified.** `requestId` is a public
     field on `FetchRequest`/`FetchResult`/`PageFetchError` and every event payload;
     `onRequest`/`onRetry` fire per attempt, `onResponse`/`onError` are terminal
     (exactly one per logical request); `onCircuitOpen` takes an object bag
     `{ host, until, requestId? }`. An `onCircuitReject` event is **deferred** — the
     crawler's accounting contract is not known yet, and adding an event later is
     additive. ([01](./01-public-contracts.md) #1/#3/#4)
  4. **POST + non-replayable bodies → never retry POST by default** (opt-in via a
     custom `isRetryable`); `body` is typed to replayable values plus a factory form,
     so a `ReadableStream` cannot be passed directly. A factory-produced stream that
     hits a 307/308 replay fails then, not at request-validation time — rejecting
     up-front would forbid legitimate single-shot streaming POSTs that never redirect.
     That failure reuses `kind: "network"` (`retryable: false`) with an explicit
     message rather than growing the frozen kind union.
     ([01](./01-public-contracts.md) #7, [02](./02-http-adapter-and-guards.md) #4)
  5. **Charset precedence → BOM above the HTTP header** (WHATWG/browser order), then
     `<meta>`, then `utf-8` fallback. A BOM is ground truth written by the encoder;
     `charset=` params are routinely stale server config. Unknown labels never throw.
     ([02](./02-http-adapter-and-guards.md) #2)
  6. **`onUnsupportedType` default → `"error"`.** Loud beats silent for a transport
     primitive; `"skip-body"` stays available for link checking.
     ([02](./02-http-adapter-and-guards.md) #6)
  7. **Default User-Agent → `marianmeres-page-fetcher (+https://github.com/marianmeres/page-fetcher)`,
     version-less in v1.** A truthful embedded version needs a generated constant kept
     in sync by the release task — not worth the npmbuild risk yet. The README carries
     DESIGN §7's "set a contact URL" note. ([02](./02-http-adapter-and-guards.md) #8)
  8. **`retainBody: false` → abort the read right after headers** (`size` stays
     `undefined`). Saving the bandwidth is the entire point of the option; draining to
     report an exact size defeats it. ([01](./01-public-contracts.md) #6)
  9. **Design doc → promoted to [`docs/design.md`](../design.md)** with a prepended
     accepted-deviations table (`tmp/` is gitignored, so the founding document would
     never have entered history). These plan docs are committed in place under
     `docs/plan/`, not under `docs/analysis/`.
     ([06](./06-testing-docs-tooling.md) #10)
  10. **Exports map grows with the code** (deviation from [06](./06-testing-docs-tooling.md) #1's
      one-shot map): `deno.json` `exports` and `build-npm.ts` `entryPoints` list only
      subpaths whose flat barrel actually exists — `.` now, `./adapters` with task 4,
      `./cache` with backlog task 12. An empty published subpath is worse than a
      late-added one, and every commit stays type-checkable. The barrel _pattern_
      (flat `src/adapters.ts`, `src/cache.ts`; internals in subdirectories) is adopted
      as specified, because it is what keeps the JSR and npm maps in sync.

  11. **Reading a `skip-body` result rejects with `kind: "no-body"`**
      (`details.reason: "skip-body"`), not with `unsupported-type` — resolving the one
      real 01/02 conflict via the ownership rule ([01](./01-public-contracts.md) #6 owns
      the error shape, [02](./02-http-adapter-and-guards.md) #6 owns the policy). One
      kind plus a `reason` detail keeps all four body-absence causes regular; using
      `unsupported-type` would force `retainBody: false` and HEAD to invent different
      kinds for the identical condition.
  12. **Two test files beyond the 12-file matrix:** `tests/internal.test.ts` (covers
      `ensureRequestId` and `createBodyResult` — the single enforcement point of the id
      and body contracts) and `tests/fixtures.test.ts` (smoke-tests the fixture server
      itself, so a later adapter failure bisects to "adapter" and not "fixture").
  13. **Three fixture routes beyond [06](./06-testing-docs-tooling.md) #3's table:**
      `/redirect-status/:code?to=` (301/302/303 vs 307/308 method-rewrite and
      body-replay cases), `/redirect-bad-location` (a `Location` that fails `new URL()`,
      which the adapter must treat as a final response) and `/counter?token=` (reads the
      per-token hit counters back, for the cache layer's "no second network hit"
      assertions). Every route is served on both origins, since the two servers share
      one handler.

  14. **The adapter never leaks a raw platform error.** Its outer `catch` maps
      anything that is not already a `PageFetchError`: an abort (from the fetch _or_
      from the body reader, after the headers) becomes `kind: "aborted"` — or the
      guard's own `PageFetchError` when that is the abort reason — and everything else
      becomes `kind: "network"`, since Deno/undici report transport failures as plain
      `TypeError`s and the retry layer must be able to classify them. Adapter-thrown
      errors are stamped `attempts: 1`.
  15. **A 304 from the bare adapter reports `hasBody: false`, reason `not-modified`**
      (and `ok: false`, `notModified: false`) — only the cache layer may resolve a 304
      into a body and flip those flags. A bodyless 200/204 still reports
      `hasBody: true` with `size: 0`; the four absence reasons stay exactly the four
      the contract names.

  16. **`composeSignal` returns `AbortSignal | undefined`**, not always an
      `AbortSignal` ([02](./02-http-adapter-and-guards.md) #5 sketched the latter):
      when there is nothing to listen to, attaching no signal at all is cheaper and
      keeps the stub-adapter assertions honest.
  17. **The per-attempt timeout budget is `min(timeout, deadline remaining)`, and
      whichever constraint binds names the failure** — a request cut off by its overall
      deadline reports `kind: "deadline"` (not retryable) even though the timeout guard
      is the layer that aborted it. Without this, a deadline-bound attempt would look
      retryable and the retry layer would keep going.
  18. **`safeEmit` lives in `src/internal.ts` for now**, and the retry layer already
      emits `onRequest` (per attempt) and `onRetry` — that is the emission ownership
      doc 01 #3 assigns to it, so wiring it now avoids editing `retry.ts` again at
      backlog task 7. Task 7's `src/events.ts` should re-home/expand the helper rather
      than duplicate it.
  19. **Test trap worth remembering:** under `FakeTime`, a large `tickAsync(ms)` moves
      `Date.now()` to the far end _before_ the due callbacks run, so every deadline
      under test looks expired and timers scheduled during the jump never fire. The
      shared `settleWithFakeTime` helper steps timer-by-timer via `nextAsync()`
      instead — use it for anything involving sleeps or deadlines.

  **Still open (backlog tasks only, not needed for the sprint):**
  serve-stale-on-circuit-open / `stale-if-error` — v2 candidate;
  browser defaults bundle — tasks 8–10; cache defaults bundle — task 12; leak-test
  rigor and the first real driver for the flagged suite — task 11; the stale
  `CLAUDE_TEMPLATE.md` path in `agents/mm-local-docs` — task 14. Also noted for task
  17: `deno publish` currently includes `tests/` in the tarball — decide then whether
  to add a `publish.exclude`.

- **2026-08-23 (backlog task 6 — circuit breaker)** — built as doc
  [03](./03-resilience-and-composition.md) #5 specs it (per-instance `Map`, host+port
  key, consecutive-failure trip, single half-open probe, map hygiene). Four calls the
  doc left implicit:

  20. **Outcomes are classified three ways, not two:** failure / success /
      **inconclusive**. `aborted`, `deadline` and a nested `circuit-open` prove nothing
      about the host, so they neither increment the failure count nor reset it — and an
      aborted _probe_ releases its slot without opening or closing the circuit (the next
      arrival becomes the new probe). Treating "not a failure" as "the host is healthy"
      would let a cancelled probe close a circuit on a host that is still down.
  21. **The breaker emits `events.onCircuitOpen` itself**, alongside its own
      `onStateChange` callback — the same double-emission retry already does for
      `onRetry` (decision 18). Task 7 wires the sink, it does not bridge the callback.
      Only closed→open and half-open→open transitions emit; refusals while open are
      silent by design (an open circuit under load would otherwise emit thousands of
      events per second, and the caller already has the rejection in hand).
  22. **`defaultIsFailure` also treats an `http`-kind error with `status >= 500` as a
      failure**, so the breaker behaves identically whether or not the stack opted into
      `throwOnHttpError`. 4xx (429 included) never counts: the host is up and answering,
      and rate limiting is retry/backoff's business, not outage detection's.
  23. **Refusals name the state in `details`:** `{ host, state: "open", until }` while
      the cooldown runs, `{ host, state: "half-open" }` (no `until`) for requests that
      arrive while the single probe is in flight. Same `kind: "circuit-open"`,
      `attempts: 0`, `retryable: false` for both.

- **2026-08-23 (backlog task 7 — composition, events, `createFetcher`)** — the
  event-granularity call was resolved first, as the task requires, and it moved one
  layer:

  24. **Composition order, final** (deviates from [03](./03-resilience-and-composition.md)
      #1's `cache → breaker → retry → events → guards → routing`), outermost first:
      `cache → circuit breaker → events → [http error guard] → deadline guard → retry →
      timeout guard → routing`. Doc 03 put the events layer _below_ retry so its
      `onRequest`/`onResponse`/`onError` would fire per attempt; decision 3 had already
      ratified doc 01's reading instead — `onResponse`/`onError` are **terminal**
      (exactly one per logical request). A terminal emitter has to sit _above_ the
      attempt loop, so it moved up. It stays _below_ the breaker so refusals emit
      nothing but the `onCircuitOpen` transition, and _above_ the deadline guard so a
      deadline failure is still reported as `onError`.
  25. **The retry layer is always composed; `retry: false` means `attempts: 1`.** Retry
      owns the attempt loop and therefore the per-attempt `onRequest`/`onRetry` events
      (decision 18) — dropping the layer would silently drop those events for anyone who
      turned retries off. One extra frame that never sleeps is the cheaper trade.
  26. **Circuit breaker default → OFF** (the doc 03 open question, resolved as spec'd).
      It is the one layer that refuses requests the caller asked for; a crawler enables
      it with `circuitBreaker: true`, a script fetching one page has no use for it.
  27. **`throwOnHttpError` is `httpErrorGuard`, placed above retry** — which resolves the
      other open question (`Retry-After` on the throwing path): retry keeps seeing the
      raw `ok: false` **result**, so a server-directed backoff still applies, and the
      throw happens once at the end. The whole result rides on `details.result`, so the
      headers and the (still readable) body are not lost — no new fields on the frozen
      error shape.
  28. **`safeEmit` re-homed from `internal.ts` to `src/events.ts` and made public**
      (decision 18 called for the move). Anyone writing a custom layer needs the same
      "a handler must not break the fetch" guarantee.

  Smaller calls, recorded so they are not re-litigated: the deadline is anchored exactly
  once, in `createFetcher`'s outer wrapper, so no layer can restart the clock; an unknown
  adapter name throws a `TypeError`, not a `PageFetchError` (a config error is not a
  fetch outcome, and both retry and the breaker pass non-`PageFetchError`s through
  untouched); `dispose()` memoizes its promise rather than just flagging, so a second
  caller awaits real completion, and a post-dispose `fetch()` rejects with a plain
  `Error`; fetcher-level `headers`/`userAgent` merge case-insensitively under the
  per-request ones and apply to every adapter.

- **2026-08-23 (backlog task 8 — browser driver interface + bridges)** — built to
  [04](./04-browser-adapter.md) #1/#2: injection-required drivers (no lazy import — it
  has no spelling that works for both JSR and npm consumers), a structural
  `BrowserDriver` that imports no third-party type, the two bridges, and the in-memory
  fake. Calls made along the way:

  29. **The fake driver lives in `tests/fixtures/fake-driver.ts`**, not
      `tests/browser/fake-driver.ts` as doc 04's affected-files list has it. The
      `tests/browser/` directory is `--ignore`d by `deno task test` (it is the flagged
      real-browser suite), and the pool/adapter unit tests must always run.
  30. **The bridges' `source` parameter types declare every member as `unknown`** and
      validate the shape at call time. A structurally precise stand-in for Playwright's
      or Puppeteer's own declarations would reject perfectly good module shapes over an
      irrelevant signature detail — and would be a compile-time dependency on those
      packages in all but name. The narrow interfaces the bridges actually work against
      are internal, reached by one cast after the runtime check. A wrong argument throws
      a `TypeError` naming what was expected, at wiring time rather than at first fetch.
  31. **Both bridges unwrap `.default`** (namespace-vs-default import is the most common
      injection mistake), and the Puppeteer bridge falls back from
      `createBrowserContext` to `createIncognitoBrowserContext` — renamed in Puppeteer
      22, and plenty of installs are older.
  32. **`normalizeHeaders` is exported** from the adapters barrel: the "header keys are
      lowercased" half of `DriverNavResult`'s contract is something a custom driver
      author has to satisfy, so hand them the function that does it.
  33. **New test file beyond doc 06's matrix: `tests/browser-drivers.test.ts`** (the
      precedent is decision 12). The bridges are this package's mapping table between one
      internal interface and two third-party APIs, so they are tested against hand-built
      mock modules — neither Playwright nor Puppeteer is installed, which is exactly what
      the structural interface buys.

  Fake-driver semantics the later tasks depend on: closing a page cancels an in-flight
  `goto` (that is how the adapter will implement cancellation, since neither driver's
  `goto` accepts a signal); a `killBrowser` route makes the navigation fail rather than
  return; `crashAfterPages` and `failLaunches` script the pool's recovery paths; and
  every delay is a `setTimeout`, so the whole suite runs under `FakeTime`.

- **2026-08-23 (backlog task 9 — browser adapter, single context)** — doc
  [04](./04-browser-adapter.md)'s five open questions that this task owns were resolved
  by taking the doc's own recommendation in each case: soft-hybrid `"networkidle"` as
  the default wait (load → bounded idle wait → proceed and set
  `extra.networkidleTimedOut`), `finalUrl` = end of the HTTP redirect chain with
  `extra.pageUrl` for client-side drift, capture on by default with `captureLimit: 50`,
  `idleMs: 500` / idle `timeout: 10_000`, and the Playwright engine option kept (the
  README will promise chromium as the tested one). The pool numbers stay open for task
  10. Calls the doc did not make:

  34. **The browser adapter sets no `User-Agent` by default** — the opposite of the HTTP
      adapter, which announces itself (decision 7). Replacing a real browser's UA with a
      bot string is what gets a headless browser served different HTML or blocked
      outright, which defeats the reason to run one; fidelity is the browser adapter's
      entire value. `userAgent` is one option away for callers who prefer politeness,
      and the README carries the note.
  35. **A request that changes context-affecting options gets its own one-off context**
      (`ContextProvider.acquire(signal, contextOptions)`), created and closed with that
      request. Per-request `headers`, a per-request `user-agent` and
      `adapterOptions.contextOptions` are all in that set. The alternative — applying
      them per page via `applyPageOptions` — works on Puppeteer and is a **silent no-op
      on Playwright**, whose contexts take options only at creation. One driver honoring
      a header and the other ignoring it is the worst outcome available; paying for a
      context (cheap, by design) is the honest one.
  36. **`maxBytes` measures the serialized DOM, post-hoc** — `DEFAULT_MAX_DOM_BYTES`,
      named distinctly from the HTTP adapter's `DEFAULT_MAX_BYTES` because both land in
      the same flat `adapters` barrel, and because they genuinely measure different
      things (re-serialized DOM vs decoded wire bytes). Same reasoning for
      `DEFAULT_BROWSER_MAX_REDIRECTS`: the HTTP adapter aborts a chain, this one reports
      on a completed one.
  37. **Non-GET is refused** with `kind: "network"`, `retryable: false` ("route non-GET
      to the http adapter") — a navigation is a GET, and inventing a kind for a request
      shape the transport cannot send is what `network` already covers.
  38. **Cancellation closes the page _and_ stops waiting for it.** Neither driver's
      `goto` takes a signal, so the abort listener closes the page (which does cancel the
      navigation) while the fetch rejects immediately. The abandoned navigation is still
      unwinding, so its page-close and lease-release are deferred until it settles, and
      the lease goes back marked `broken` — otherwise a cancelled fetch would leak a page
      or hand a half-cancelled context to the next caller.
  39. **`browserErrorFrom` checks the signal before it classifies the message.** Because
      cancelling _is_ closing the page, an abort surfaces as whatever unrelated-looking
      driver error the in-flight operation produced; only the signal knows the truth, and
      a guard's own error (a timeout, a deadline) rides on the abort reason and is
      returned unchanged. Everything else is classified by message — `net::ERR_`/`NS_ERROR_`
      → `network`, `timeout` → `timeout`, the rest → `browser` — because neither driver
      exposes machine-readable navigation error codes.
  40. **`ContextProvider` / `ContextLease` are introduced now**, in `browser-adapter.ts`,
      with a trivial single-browser/single-context implementation. Task 10's
      `createContextPool` implements the same two interfaces, so the pool is a swap
      rather than an adapter rewrite. The provider memoizes **promises**, not handles:
      `shared ??= await newContext()` lets every concurrent racer past the check and
      opens N contexts — a bug the concurrency test now pins.

  Also settled while wiring: the request filter and page options are installed before
  `goto` (the order the drivers require); `onPage` runs after the wait and before
  `content()`, its result merged into `extra` last, and a throwing hook lands in
  `extra.onPageError` instead of failing the fetch; `ttfb` for a browser fetch includes
  launch/context/page setup, so a cold first fetch says so honestly; a `"document"`
  request is never blocked whatever the patterns say; and per-request blocking options
  **replace** the adapter's rather than merging.

- **2026-08-23 (backlog task 10 — context pool + exit hooks)** — the remaining doc
  [04](./04-browser-adapter.md) open questions are resolved as proposed: `poolSize: 3`,
  `maxPagesPerContext: 50`, `acquireTimeout: 30_000`, and `"per-request"` **does** stay
  capped at `poolSize` (an uncapped mode is a footgun, not a feature). Calls made while
  building it:

  41. **One implementation, three strategies.** `createSingleContextProvider` (task 9) is
      deleted, not kept alongside the pool: `"shared"` is exactly `size: 1` +
      `maxPagesPerContext: Infinity`, and `"per-request"` is `maxPagesPerContext: 1`, so
      `poolShapeFor()` turns the strategy into two numbers and the pool covers all three.
      `ContextLease`/`ContextProvider` moved with it into `pool.ts`, which is their real
      owner and removes the import cycle the task-9 placement would have created.
  42. **Acquire is a condition-variable loop, not a hand-off queue.** Every waiter
      re-checks the pool state after being woken, which is what makes the crash path
      simple: the crash wakes everyone rather than resolving specific slots to specific
      callers. A re-queued waiter goes to the **front**, so a caller that loses a race
      for the slot it was woken for cannot starve behind arrivals that showed up after
      it, and a fresh arrival never jumps an existing queue.
  43. **A crash never rejects waiters — a failed relaunch does.** The doc's wording
      ("reject all current waiters if relaunch fails") is implemented per waiter: each
      woken waiter re-tries, which relaunches through the single-flight, and fails with
      that relaunch's error if it cannot come back. Same observable contract, no separate
      "reject everyone" bookkeeping to get wrong. A failed launch is never memoized, so
      the next request tries again.
  44. **The pool throws plain errors; the adapter classifies them.** An acquire timeout
      is `Error("Timed out …")` → `kind: "timeout"`, dispose and aborts are
      `DOMException(AbortError)` → `kind: "aborted"`, a launch failure → `kind: "browser"`,
      all via `browserErrorFrom`. Keeping `PageFetchError` construction in the adapter is
      what lets the error carry the URL and `requestId` the pool has never heard of.
      **This closed a task-9 defect:** `contexts.acquire()` sat outside the adapter's
      `try`/`catch`, so a launch failure escaped as a raw `Error`, contradicting decision
      14 ("the adapter never leaks a raw platform error"). It is now wrapped.
  45. **The exit hook takes an injectable `ExitHookHost`.** Feature detection picks Deno
      (signal listeners + `unload`) or Node (`process`), but the register → run →
      unregister → **re-raise** protocol is unit-tested against a fake host, so no test
      ever sends a real signal. Re-raise prefers the true signal (`Deno.kill` /
      `process.kill`, which preserves other handlers), and falls back to exiting with the
      conventional `128 + n` — because `Deno.kill` needs `--allow-run`, and a transport
      library has no business demanding that permission. The re-raise itself is
      mandatory, not optional: installing a SIGINT listener suppresses default
      termination on both runtimes, so skipping it would break Ctrl-C.
  46. **Per-request dedicated contexts live outside the pool's size accounting** — they
      are rare by construction (decision 35) and blocking them behind pool capacity would
      make a stray header able to deadlock a saturated pool. They are still closed on
      `dispose()` if one is out.

  The "never wedge" invariant is now four named tests — timeout, signal, dispose, failed
  relaunch — plus a fifth for the mid-fetch crash, all against the fake driver in the
  default browserless run.

- **2026-08-23 (backlog task 11 — flagged real-browser suite)** — `tests/browser/`
  behind the double gate doc [06](./06-testing-docs-tooling.md) #5 specifies: the
  directory is `--ignore`d by `deno task test` (so its modules are neither run nor
  imported), and each case also checks the `BROWSER_TESTS` **permission** before reading
  the variable, so a permissionless run degrades to "skipped" instead of failing at
  collection. The driver specifier stays out of `deno.json` imports and is imported
  dynamically inside the test body. The open question is answered:

  47. **Both bridges are the first real drivers, not one.** `BROWSER_DRIVER=puppeteer`
      switches the suite over (`deno task test:browser:puppeteer`); Playwright/chromium
      is the default and the engine the README will promise. Ten cases pass against each
      — verified on this machine, 6 s for Playwright and 19 s for Puppeteer. Testing both
      is what makes the structural driver interface's claim ("two bridges, one adapter")
      an assertion rather than a hope.
  48. **The leak test asserts the scan works before asserting the leak is gone.** It
      first requires at least one browser descendant while the adapter is live —
      otherwise a broken `ps` parse, a renamed executable or a driver that never
      launched would make the post-dispose assertion pass for entirely the wrong reason.
      It scans transitive children of `Deno.pid` for browser-looking commands rather than
      a pid, because Playwright's `Browser` exposes no process; skipped off darwin/linux.
  49. **Three fixture routes added** (`/spa`, `/spa.css`, `/spa.png`) — a page that is
      only complete after its scripts run, plus two token-carrying subresources. That one
      page is what lets the suite prove the two claims no HTTP fixture can: the returned
      DOM is post-hydration, and a blocked resource was **never requested** (asserted via
      the fixture's per-token hit counters, so blocking is verified end to end through a
      real browser rather than through our own filter's bookkeeping).

  **Bug found by the real suite, fixed here:** a `{ fn }` wait resolved instantly.
  Both drivers evaluate a **string** `waitForFunction` argument as an _expression_, so
  the documented "self-contained function source" (`"() => done"`) evaluates to a
  function **object** — truthy — and the wait returned the un-waited-for page silently.
  `toPageExpression()` in `wait.ts` now wraps a function-looking source in a call and
  passes anything else through unchanged; `DriverPage.waitForFunction`'s contract is
  restated as "an expression", and both forms are pinned by a unit test plus a real-
  browser case whose assertions are no longer satisfiable by the serialized script tag.
  This is exactly the class of defect the flagged suite exists to catch — the fake driver
  cannot see it, because it never evaluates anything.

  Noted for task 17: `tests/browser/` **is** in the `deno publish` tarball (the dry run
  passes — JSR does not type-check files outside the exported graph, so the `npm:` dynamic
  imports are never resolved), which strengthens the case for a `publish.exclude` on
  `tests/`. A plain `deno check` of those files does download Playwright and Puppeteer;
  that is fine as an explicit act, and the default test task never touches them.

## How to resume (for a fresh conversation)

1. Read this file + [`00-overview-and-roadmap.md`](./00-overview-and-roadmap.md).
2. Pick the next ⬜ task; open its source doc section for the verified detail.
3. Resolve that task's "Open questions" with the owner; record the call in the
   Decisions log (date + rationale, including anything deferred and why).
4. Work on `master` (decision 1) → implement → run `deno task test` (and
   `deno task test:browser` when touching the browser subsystem) → update this file →
   commit (one commit per task).

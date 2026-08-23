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
| 7    | Composition: `src/compose.ts`, `src/events.ts` (+ `safeEmit`), `src/fetcher.ts` (`createFetcher`, adapter routing, dispose + `Symbol.asyncDispose`, event/logger bridging) + `tests/fetcher.test.ts`. Resolves the 01/03 event-granularity call first (see overview completeness check) | [03](./03-resilience-and-composition.md) #1/#2/#6/#7/#10; [01](./01-public-contracts.md) #3 | ⬜     |
| 8    | Browser driver: `src/adapters/browser/driver.ts` (structural `BrowserDriver`), `drivers/playwright.ts` + `drivers/puppeteer.ts` bridges, `tests/fixtures/fake-driver.ts` (scriptable in-memory driver)                                                                                  | [04](./04-browser-adapter.md) #1/#2                                                         | ⬜     |
| 9    | Browser adapter (single context): `browser-adapter.ts` orchestration, `wait.ts` (soft-hybrid networkidle), `blocking.ts` (on by default), result mapping (`finalUrl`/`extra.pageUrl`, serialized-DOM `bytes()`), `onPage` + bounded capture + unit tests vs fake driver                 | [04](./04-browser-adapter.md) #4/#5/#6/#8                                                   | ⬜     |
| 10   | Browser pool + lifecycle: `pool.ts` (epochs, recycling, waiter queue, "never wedge" invariant), `exit-hook.ts` (feature-detected, re-raise protocol) + `tests/browser-pool.test.ts` vs fake driver                                                                                      | [04](./04-browser-adapter.md) #3/#7                                                         | ⬜     |
| 11   | Flagged real-browser suite: `tests/browser/` (double gate: `--ignore` + `BROWSER_TESTS=1`), adapter smoke vs fixture server, ps-scan leak test                                                                                                                                          | [06](./06-testing-docs-tooling.md) #5; [04](./04-browser-adapter.md) #7                     | ⬜     |
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

  **Still open (backlog tasks only, not needed for the sprint):** circuit-breaker
  default in `createFetcher` (OFF as spec'd vs ON for the crawler) — task 6/7;
  serve-stale-on-circuit-open / `stale-if-error` — v2 candidate; `Retry-After` on the
  `throwOnHttpError` path (needs headers reachable from an `http`-kind error) — task 7;
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

## How to resume (for a fresh conversation)

1. Read this file + [`00-overview-and-roadmap.md`](./00-overview-and-roadmap.md).
2. Pick the next ⬜ task; open its source doc section for the verified detail.
3. Resolve that task's "Open questions" with the owner; record the call in the
   Decisions log (date + rationale, including anything deferred and why).
4. Work on `master` (decision 1) → implement → run `deno task test` (and
   `deno task test:browser` when touching the browser subsystem) → update this file →
   commit (one commit per task).

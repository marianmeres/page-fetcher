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
| 1 | Repo groundwork: initial commit of scaffold + plan; deno.json exports map + flat barrels, clog/@std/testing pins, scoped test tasks; replace build-npm.ts `[""]` placeholder; decide `docs/design.md` promotion                                                                                                    | [06](./06-testing-docs-tooling.md) #1/#8/#10/#12                                               | ✅     | _initial_ |
| 2 | Public contracts: `src/types.ts` + `src/errors.ts` + `src/internal.ts` (`requestId` end-to-end, eager-bytes/lazy-decode body, `retainBody`/`hasBody`, kind union incl. `circuit-open`/`no-body`, `ObservabilityOptions`, `mod.ts` surface) + `tests/errors.test.ts`, `tests/mod.test.ts`                           | [01](./01-public-contracts.md) #1–#10                                                          | ⬜     | —         |
| 3 | Fixture server + test helpers: `tests/fixtures/server.ts` (port 0, dual origin, kill switch, hand-gzip, token-keyed routes), `tests/fixtures/bytes.ts` (raw windows-1250), `tests/helpers.ts` (stub `FetchFn`s, fake logger)                                                                                       | [06](./06-testing-docs-tooling.md) #2/#3/#4                                                    | ⬜     | —         |
| 4 | HTTP adapter + stream helpers: `src/read-body.ts`, `src/content-type.ts`, `src/charset.ts`, `src/adapters/http.ts` (redirect loop, UA, timing) + `tests/http-adapter.test.ts`, `tests/charset.test.ts`                                                                                                             | [02](./02-http-adapter-and-guards.md) #1/#2/#4/#6/#7/#8                                        | ⬜     | —         |
| 5 | Wrapper guards + retry: `src/guards.ts` (timeout/deadline, `composeSignal`, typed abort reasons), `src/utils.ts` (`sleep`, `resolveDeadline`), `src/retry.ts` (`RetryOutcome` either/or, classification table, `Retry-After`, deadline fail-fast) + FakeTime tests (`tests/guards.test.ts`, `tests/retry.test.ts`) | [02](./02-http-adapter-and-guards.md) #3/#5; [03](./03-resilience-and-composition.md) #3/#4/#9 | ⬜     | —         |

---

## Backlog (ranked, post-sprint — full path to v1)

| Rank | Task                                                                                                                                                                                                                                                                                    | Source                                                                                      | Status |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------ |
| 6    | Circuit breaker: `src/circuit-breaker.ts` (per-instance `Map`, logical-outcome counting, half-open single probe, map hygiene, `circuit-open` rejections) + FakeTime tests                                                                                                               | [03](./03-resilience-and-composition.md) #5, [06](./06-testing-docs-tooling.md) #2          | ⬜     |
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
  12. **One test file beyond the 12-file matrix:** `tests/internal.test.ts`, covering
      `ensureRequestId` and `createBodyResult`. They are the single enforcement point of
      the id-generation and body contracts, so they get direct tests rather than being
      exercised only through adapters.

  **Still open (backlog tasks only, not needed for the sprint):** circuit-breaker
  default in `createFetcher` (OFF as spec'd vs ON for the crawler) — task 6/7;
  serve-stale-on-circuit-open / `stale-if-error` — v2 candidate; `Retry-After` on the
  `throwOnHttpError` path (needs headers reachable from an `http`-kind error) — task 7;
  browser defaults bundle — tasks 8–10; cache defaults bundle — task 12; leak-test
  rigor and the first real driver for the flagged suite — task 11; the stale
  `CLAUDE_TEMPLATE.md` path in `agents/mm-local-docs` — task 14.

## How to resume (for a fresh conversation)

1. Read this file + [`00-overview-and-roadmap.md`](./00-overview-and-roadmap.md).
2. Pick the next ⬜ task; open its source doc section for the verified detail.
3. Resolve that task's "Open questions" with the owner; record the call in the
   Decisions log (date + rationale, including anything deferred and why).
4. Work on `master` (decision 1) → implement → run `deno task test` (and
   `deno task test:browser` when touching the browser subsystem) → update this file →
   commit (one commit per task).

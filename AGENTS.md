# @marianmeres/page-fetcher — Agent Guide

Fetch one web page by URL and get a normalized result, whether the bytes came from a
headless browser or a plain `fetch`. Transport only — it knows nothing about links,
recursion, sites or crawling.

## Quick Reference

- **Stack**: TypeScript, Deno-first, ESM, published to JSR + npm. **Zero runtime
  dependencies** (`@marianmeres/clog` is a type-only import).
- **Test**: `deno task test` — never opens a socket except to the local fixture server.
- **Browser tests**: `deno task test:browser` (needs Playwright) /
  `deno task test:browser:puppeteer`. Excluded from `deno task test` by `--ignore`.
- **Docs gate**: `deno task doc:lint` — `deno doc --lint` plus `deno check --doc`, which
  type-checks the code inside every `@example`.
- **Build**: `deno task npm:build` (runs `tsc`, which is stricter than `deno check`).
- **Format/lint**: `deno fmt` / `deno lint`. Tabs, `lineWidth: 90`.
- **Example app**: `deno task example` (a local Deno server at :8000 — the demo pages and
  the fetch endpoint), `deno task example:build` after editing `example/src/`.

## Project Structure

```
src/mod.ts        — flat barrel, export "."         (layers, compose, createFetcher, errors)
src/adapters.ts   — flat barrel, export "./adapters" (http + browser subsystem)
src/cache.ts      — flat barrel, export "./cache"    (store, layer, serialization)
src/adapters/     — internals: http.ts, browser/{browser-adapter,pool,wait,blocking,
                    exit-hook,driver}.ts, browser/drivers/{playwright,puppeteer}.ts
src/cache/        — internals: types, key, memory, layer, serialize
tests/            — one file per module; unit files must not import the fixture server
tests/fixtures/   — server.ts (dual-origin local HTTP), fake-driver.ts, bytes.ts
tests/browser/    — flagged real-browser suite (double gate: --ignore + BROWSER_TESTS=1)
example/          — the interactive example: server.ts (static + /demo/* + /api/fetch),
                    index.html (templates + token-driven CSS), src/main.ts (vanilla app),
                    dist/bundle.js (committed, built by deno-build)
scripts/          — build-npm.ts, gen-example-{version,theme}.ts
docs/_archive/plan/ — the original implementation plan and its decisions log
```

Barrels are flat and stay in sync with `deno.json` `exports` **and**
`scripts/build-npm.ts` `entryPoints`. A new subpath means editing all three.

## Critical Conventions

1. **Every layer is `(next: FetchFn) => FetchFn`** (`FetchLayer`). No classes, no plugin
   registry, no privileged layer. `createFetcher` is one `compose()` call.
2. **A non-2xx response is data, not an error** — it resolves with `ok: false`. Only
   `throwOnHttpError` turns it into a throw, via `httpErrorGuard`.
3. **One error type**: `PageFetchError`, discriminated by `kind`. Never branch on a
   message. Adapters never leak a raw platform error.
4. **No direct `Deno.*` / `process.*` in `src/`** — the package must run unchanged on
   Node. The single exception is `exit-hook.ts`, which feature-detects both behind an
   injectable `ExitHookHost`.
5. **The browser is injected, never imported.** `BrowserDriver` is structural and this
   package imports no Playwright/Puppeteer type. The bridges validate their argument's
   shape at call time.
6. **Explicit return types on every export** (JSR "no slow types"). `deno publish
   --dry-run` is the gate.
7. **`logger` is optional and silent by default**; `events` is the machine channel with
   defined granularity. Emit through `safeEmit` — a handler must never break a fetch.
8. **`requestId` is end-to-end**: stamped by the outermost layer that sees it missing
   (`ensureRequestId`), stable across attempts, present on every result and error.

## Before Making Changes

- [ ] Read [docs/architecture.md](./docs/architecture.md) for where your change belongs
      in the layer stack.
- [ ] Check the sibling module — every layer follows the same shape.
- [ ] `deno task test` (and `deno task test:browser` when touching the browser subsystem).
- [ ] `deno lint && deno fmt && deno task doc:lint`.
- [ ] `deno publish --dry-run` before anything that changes the public surface.
- [ ] Update `tests/mod.test.ts` when adding or removing a barrel export.

## Documentation Index

- [Architecture](./docs/architecture.md) — the layer stack, component map, data flow
- [Conventions](./docs/conventions.md) — Do/Don't pairs for code and tests
- [Tasks](./docs/tasks.md) — add an adapter, a cache store, a fixture route, a layer
- [Design](./docs/design.md) — the founding design document
- [Example](./example/README.md) — what the demo pages prove, and why the fetch runs
  server-side rather than in the page
- [Implementation plan](./docs/_archive/plan/PROGRESS.md) — status and the full decisions log
  (read this before re-litigating a design call; it records what was decided and why)

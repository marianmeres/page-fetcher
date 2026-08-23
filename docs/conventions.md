# Conventions

## File organisation

- Flat barrels only: `src/mod.ts`, `src/adapters.ts`, `src/cache.ts`. Internals live in
  subdirectories and are never exported by path.
- A new subpath means three edits: the barrel, `deno.json` `exports`, and
  `scripts/build-npm.ts` `entryPoints`. Keep them in sync or the JSR and npm surfaces
  diverge.
- Option interfaces live next to the layer they configure (`RetryOptions` in `retry.ts`).
  Only genuinely shared types go in `src/types.ts`.
- Every module opens with a `@module` JSDoc block stating what it owns and — for a layer —
  **why it sits where it sits** in the stack.

## Naming

| Thing                   | Shape                                                          |
| ----------------------- | -------------------------------------------------------------- |
| Layer / adapter factory | `createX(options)` returning a `FetchLayer`/`Adapter`          |
| Default constants       | `DEFAULT_SCREAMING_SNAKE`, exported                            |
| Overridable policy fns  | `defaultIsRetryable`, `defaultIsFailure`, `defaultIsCacheable` |
| Files                   | kebab-case `.ts`                                               |

`DEFAULT_*` constants are exported so callers can wrap rather than restate them.

## Patterns

**Layers are functions, not classes.**

✅ Do:

```ts
export function createThing(options: ThingOptions = {}): FetchLayer {
	return (next: FetchFn): FetchFn =>
	async (input: FetchRequest): Promise<FetchResult> => {
		const req = ensureRequestId(input);
		return await next(req);
	};
}
```

❌ Don't: `class ThingLayer extends BaseLayer` — there is no base, no registry, and no
privileged layer.

**A non-2xx is data.**

✅ Do:

```ts
return { ok: res.status >= 200 && res.status < 300, status: res.status /* … */ };
```

❌ Don't: `if (!res.ok) throw new Error(...)` inside an adapter. Only `httpErrorGuard`
converts, and only when the caller asked for it.

**Branch on `kind`, never on a message.**

✅ Do:

```ts
if (PageFetchError.is(e) && e.kind === "circuit-open") backOff(e.url);
```

❌ Don't: `if (e.message.includes("circuit"))`.

Use `PageFetchError.is()` rather than `instanceof` — the same package can legitimately
appear twice in one module graph (JSR + npm side by side).

**Never leak a platform error out of an adapter.**

✅ Do: map an abort to `kind: "aborted"` (or the guard's own error, carried on the abort
reason) and everything else to `kind: "network"`, stamped `attempts: 1`.

❌ Don't: let a `TypeError` from `fetch` escape — the retry layer cannot classify it.

**Type-only imports of clog.**

✅ Do: `import type { Logger } from "@marianmeres/clog";`

❌ Don't: import any clog value. The zero-runtime-dependency promise is load-bearing.

**No runtime globals in `src/`.**

✅ Do: feature-detect behind an injectable seam, as `exit-hook.ts` does with
`ExitHookHost`.

❌ Don't: reference `Deno.` or `process.` anywhere else — the package must run unchanged
on Node.

**The browser is injected.**

✅ Do: `createBrowserAdapter({ driver: playwrightDriver(playwright) })`, with the caller
importing `playwright`.

❌ Don't: `import("playwright")` inside `src/` — there is no specifier that works for both
JSR and npm consumers, and it would make the browser a de-facto dependency.

**Explicit return types on every export.** JSR rejects "slow types"; `deno publish
--dry-run` is the gate. This includes arrow functions assigned to exported consts.

## Error handling

| Situation                          | Response                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Non-2xx response                   | resolve with `ok: false`                                                                                            |
| Transport failure                  | throw `PageFetchError` `kind: "network"`                                                                            |
| Our timeout fired                  | `kind: "timeout"`; the guard is the abort **reason**                                                                |
| Overall deadline bound the attempt | `kind: "deadline"`, not retryable — the binding constraint names the failure                                        |
| Caller's signal fired              | `kind: "aborted"`                                                                                                   |
| Body absent and read anyway        | `kind: "no-body"` + `details.reason`                                                                                |
| Misconfiguration (unknown adapter) | plain `TypeError` — a config error is not a fetch outcome, and both retry and the breaker pass it through untouched |

## Observability

- `logger` is optional and **silent** when absent. Never default to `console`, never
  allocate a no-op logger — guard each call site with `logger?.debug(...)`.
- Emit every user callback through `safeEmit`: a throwing handler is reported via
  `logger.warn` and otherwise swallowed.
- Errors are thrown and reported via `onError`. Inner layers do not _also_ log them at
  `error` level — nothing double-reports.

## Testing

- **Unit files must not import `tests/fixtures/server.ts`.** A socket-free unit suite is
  what makes a failure bisect instantly to "logic" vs "I/O".
- Use `settleWithFakeTime` from `tests/helpers.ts` for anything involving sleeps or
  deadlines. A large `tickAsync(ms)` moves `Date.now()` to the far end _before_ the due
  callbacks run, so every deadline under test looks expired.
- Fixture routes key their state by a caller-supplied `?token=`, so parallel cases never
  share counters.
- Anything needing a real browser goes in `tests/browser/` — `--ignore`d by
  `deno task test`, and gated again on the `BROWSER_TESTS` env var (check the permission
  before reading it).
- Adding or removing a barrel export means updating `tests/mod.test.ts`, which pins the
  exact runtime surface of all three entry points.

## Formatting

Tabs, `lineWidth: 90`, `indentWidth: 4`, `proseWrap: preserve` — all from `deno.json`.
Run `deno fmt`; do not hand-format.

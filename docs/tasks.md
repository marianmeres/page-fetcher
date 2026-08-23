# Common procedures

## Add an adapter

### Steps

1. Create `src/adapters/<name>.ts` (or `src/adapters/<name>/` for a subsystem, as the
   browser one does).
2. Implement `Adapter` from `src/types.ts`: `name`, `fetch`, optional `dispose` and
   `health`. `dispose` must be idempotent.
3. Start `fetch` with `ensureRequestId(input)` and finish it with `createBodyResult` —
   that helper is the single implementation of the body contract (eager bytes, lazy
   memoized decode, `kind: "no-body"` on an absent body).
4. Wrap the whole thing in a `try`/`catch` that maps every escape to a `PageFetchError`
   stamped `attempts: 1`. Nothing platform-shaped may leak out.
5. Export the factory, its options interface and its `DEFAULT_*` constants from
   `src/adapters.ts`.
6. Add the new export names to `tests/mod.test.ts`.
7. Test it: unit cases against an injected transport stub, integration cases against
   `tests/fixtures/server.ts`.

### Template

```ts
export function createThingAdapter(options: ThingAdapterOptions = {}): Adapter {
	const { name = "thing", logger, events } = options;

	async function thingFetch(req: IdentifiedRequest): Promise<FetchResult> {
		// … I/O …
		const body = createBodyResult(bytes, {
			url: req.url,
			requestId: req.requestId,
			charset,
		});
		return {
			ok,
			url: req.url,
			finalUrl,
			status,
			headers,
			redirects,
			requestId: req.requestId,
			hasBody: body.hasBody,
			text: body.text,
			bytes: body.bytes,
			size,
			fromCache: false,
			notModified: false,
			timing,
			attempts: 1,
			adapter: name,
			meta: req.meta,
		};
	}

	return {
		name,
		fetch: async (input: FetchRequest): Promise<FetchResult> => {
			const req = ensureRequestId(input);
			try {
				return await thingFetch(req);
			} catch (e) {
				if (PageFetchError.is(e)) throw withAttempts(e, 1);
				if (isAbortError(e) || req.signal?.aborted) {
					throw withAttempts(
						abortErrorFrom(req.signal, {
							url: req.url,
							requestId: req.requestId,
							cause: e,
						}),
						1,
					);
				}
				throw new PageFetchError({
					kind: "network",
					url: req.url,
					requestId: req.requestId,
					attempts: 1,
					cause: e,
				});
			}
		},
	};
}
```

### Checklist

- [ ] `attempts: 1` on every result and every error it throws.
- [ ] `retainBody: false` aborts the read right after the headers; `size` stays undefined.
- [ ] `HEAD`, `skip-body`, `retain-body` and `not-modified` are the only four body-absence
      reasons — do not invent a fifth.
- [ ] Honors `req.signal`, `req.timeout` is _not_ its business (the guard owns it), but it
      must propagate the composed signal into its I/O.
- [ ] `deno task test` + `deno task doc:lint` + `deno publish --dry-run`.

## Add a layer

### Steps

1. Create `src/<name>.ts` exporting `createX(options): FetchLayer`.
2. Open the module JSDoc by stating **where in the stack it belongs and why** — placement
   is the part a later reader cannot re-derive.
3. `ensureRequestId(input)` first, so a standalone layer behaves like a composed one.
4. Pass non-`PageFetchError` throws through untouched — they are config errors.
5. Wire it into `createFetcher` in `src/fetcher.ts`, in the right position, and update the
   ASCII diagram in that module's JSDoc **and** in `docs/architecture.md`.
6. Export from `src/mod.ts`; update `tests/mod.test.ts`.

### Checklist

- [ ] Emits nothing the events contract does not assign to it (see `src/events.ts`).
- [ ] Its unit test uses stub `FetchFn`s from `tests/helpers.ts` and opens no socket.
- [ ] Its module JSDoc states why it sits where it does (the original ordering
      calls are recorded in `docs/_archive/plan/PROGRESS.md`).

## Add a cache store

### Steps

1. Implement `CacheStore` from `src/cache/types.ts`: `get` / `set` / `delete`, all async.
2. Keep it **dumb**: no freshness logic, no entry inspection, no TTL. All policy lives in
   `createCacheLayer`.
3. For a persistent store, split entries with `serializeCachedEntry` — `meta` is JSON,
   `body` is raw bytes that must be kept out-of-band. `Headers` and `Uint8Array` both
   JSON-stringify to garbage, which is the entire reason those helpers exist.
4. Hash the key yourself if it must be filename-safe; the helpers deliberately do not.
5. `get` resolves `undefined` for a miss and never throws for one. A store that throws
   degrades the layer to a bypass with a `logger.warn`, so failures are survivable but
   silent-ish — do not rely on it.

### Template

```ts
const store: CacheStore = {
	async get(key) {
		const row = await db.get(key);
		return row ? deserializeCachedEntry(row.meta, row.body) : undefined;
	},
	async set(key, entry) {
		const { meta, body } = serializeCachedEntry(entry);
		await db.put(key, { meta, body });
	},
	async delete(key) {
		await db.delete(key);
	},
};
```

### Checklist

- [ ] Round-trips through `serializeCachedEntry`/`deserializeCachedEntry` unchanged.
- [ ] Drops entries whose `v` this build does not know (`deserializeCachedEntry` throws
      `kind: "decode"` — treat it as a miss).
- [ ] Bounded somehow. `createMemoryCache`'s bound is `maxEntries`; a disk store needs its
      own answer.

## Add a fixture route

### Steps

1. Add a `case` to the `switch (true)` in `tests/fixtures/server.ts`. Both origins share
   one handler, so the route exists on both automatically.
2. For stateful routes, key counters on the caller-supplied `?token=` via
   `bump(ctx.counts, key)` — parallel cases must never share state.
3. For any delay, use `abortableDelay(ms, ctx.kill, req.signal)`. A bare `setTimeout`
   deadlocks `shutdown()`, which waits for in-flight handlers.
4. Document the route's purpose in a comment if it is not self-evident.
5. Add a case to `tests/fixtures.test.ts` so a later failure bisects to "adapter", not
   "fixture".

### Checklist

- [ ] Works under `HEAD` too (`stripHeadBody` handles that, but check the headers).
- [ ] No unbounded delay without the kill switch.
- [ ] Token-keyed if it counts anything.

## Add a demo scenario to the example

### Steps

1. Add a `case` to the `switch (true)` in `example/server.ts` under `/demo/…`. Keep it
   self-contained — the example must never import `tests/fixtures/`, which is not
   published and not part of the example's build.
2. For a stateful route (fails N times, then succeeds), key the counter on the
   caller-supplied `?token=` via `bump(key)`, and mark the scenario `fresh: true` so the
   app mints a new token per run; otherwise it only demos once.
3. For any delay, use `delay(ms, req.signal)` so a closed tab does not hold the handler.
4. Add the matching entry to `SCENARIOS` in `example/src/main.ts`: `label`, `path`,
   a `hint` saying **what to watch for**, and `apply` for the options that make the point
   visible (a `timeout` for a slow page, a `maxBytes` for a large one).
5. `deno task example:build`, then `deno task example` and click it.

### Checklist

- [ ] The scenario proves one specific behavior, and the hint names it.
- [ ] Stateful routes are token-keyed **and** marked `fresh`.
- [ ] Nothing in `example/` imports from `tests/`.
- [ ] The bundle is rebuilt and committed (`example/dist/bundle.js`).

## Add a browser capability

### Steps

1. Extend the structural interface in `src/adapters/browser/driver.ts` — never a
   Playwright or Puppeteer type.
2. Implement it in **both** bridges (`drivers/playwright.ts`, `drivers/puppeteer.ts`).
   Both unwrap `.default`; Puppeteer's context creation has a pre-22 fallback.
3. Script it in `tests/fixtures/fake-driver.ts` so the default (browserless) suite covers
   it.
4. Add a real case to `tests/browser/` — the fake driver evaluates nothing, so anything
   involving page evaluation needs a real browser to be trustworthy.
5. Run **both** real suites: `deno task test:browser` and
   `deno task test:browser:puppeteer`.

### Checklist

- [ ] No third-party type reaches the public surface.
- [ ] Passes against both bridges.
- [ ] The fake-driver version keeps every delay a `setTimeout` (the pool suite runs under
      `FakeTime`).

## Release

Follow [PRE_RELEASE_DOCS_UPDATE.md](/Users/mm/projects/@marianmeres/agents/mm-local-docs/PRE_RELEASE_DOCS_UPDATE.md),
then:

```
deno task test && deno task test:browser && deno task test:browser:puppeteer
deno lint && deno fmt --check && deno task doc:lint
deno publish --dry-run  # also: read the file list, `publish.exclude` keeps tests out
deno task npm:build     # runs tsc, which is stricter than deno check
```

Two checks that are not tasks yet, and are worth the five minutes:

- **Nothing undocumented ships.** Diff `deno doc --json src/mod.ts src/adapters.ts
  src/cache.ts` against `API.md` — every exported symbol name must appear there. It has
  caught gaps twice.
- **Install the npm artifact, do not just read it.** `cd .npm-dist && npm pack`, install
  the tarball in a scratch project, import all three subpaths from a `.mjs` script and
  run one real fetch, then `tsc --strict` (NodeNext) over a consumer file. That last step
  is what proves a consumer can resolve clog's `Logger` out of our `.d.ts`.

Publishing is `deno task rp` / `deno task rpm`. **Never publish without an explicit
green-light from the owner** — a JSR/npm release is irreversible.

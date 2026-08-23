<!--
GENERATED ANALYSIS — @marianmeres/page-fetcher implementation plan
Produced 2026-08-23 by multi-agent research -> adversarial verify -> synthesize.
Claims verified against the design doc (tmp/page-fetcher-DESIGN.md), local ecosystem
sources, and platform checks. Repo is a pre-first-commit scaffold; no code was changed.
-->

# Cache layer & conditional requests

> This doc specs the optional cache layer of DESIGN §8: the `CacheStore` interface, the
> shipped `createMemoryCache()`, and a new `createCacheLayer()` wrapper that provides the
> two modes the design demands through one interface — **dev cache** (serve any hit,
> ignore freshness) and **conditional revalidation** (`If-None-Match` /
> `If-Modified-Since`, synthesize a full result from the store on 304).

> The single most important finding: **the design names `CachedEntry` but never defines
> it, and the naive definition is broken twice over** — `FetchResult.headers` is a
> `Headers` object that JSON-stringifies to `{}` (verified), and `Uint8Array` bodies
> stringify to index-keyed junk (verified). A `CachedEntry` that persistent stores can
> actually implement must use a plain lowercased header record, carry the body as a
> `Uint8Array` that stores persist out-of-band, and be versioned. A second, quieter trap
> verified locally: `Object.fromEntries(headers)` silently keeps only the **last**
> `Set-Cookie` value — so `Set-Cookie` must be stripped at store time (which RFC 9111
> would advise anyway).

> Headline recommendation: ship `src/cache/` as four small modules (types, key, memory
> store, layer) with a dumb KV store and **all policy in the layer** — TTL, mode,
> cacheability, key derivation. No background timers, GET-only caching in v1, `Vary`
> explicitly out of scope, status-200-only storage by default, and caching stays off
> unless `createFetcher` is handed a store. Everything else is a documented extension
> point, not code.

## Summary of recommendations

| # | Recommendation                                                                                                                                  | Value | Effort | Risk |
| - | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | ---- |
| 1 | Define `CachedEntry` fully: versioned, JSON-safe except `body`, plain header record, `Set-Cookie` stripped                                      | high  | S      | low  |
| 3 | Key derivation from the request only (`adapter?:GET:url`), GET-only caching, explicit bypass rules, `Vary` out of scope v1                      | high  | S      | low  |
| 4 | Synthesized-result semantics: `fromCache`/`notModified` matrix, `attempts: 0` on pure hits, real network timing on 304s                         | high  | S      | low  |
| 2 | `createCacheLayer({ store, mode, ttl?, ... })`: full dev/conditional state machine incl. 304 flow with RFC 9111 §4.3.4-lite header merge        | high  | M      | low  |
| 5 | Memory store: `Map` + reorder-on-get LRU, `maxEntries` cap, zero timers                                                                         | med   | S      | low  |
| 6 | Cacheability policy: store `status === 200` and no `Cache-Control: no-store` by default; `isCacheable` override documented for negative caching | med   | S      | low  |
| 7 | `serializeCachedEntry`/`deserializeCachedEntry` helpers + README recipe for fs/SQLite-backed stores                                             | med   | S      | low  |
| 8 | `logger?: Logger` (from `@marianmeres/clog`, type-only import) on layer and store; silent by default                                            | med   | S      | low  |

(Numbers are stable finding IDs; the table is ordered by value desc, effort asc.)

## Findings & recommendations (detailed)

### 1. `CachedEntry` — undefined in the design; must be specced serialization-first

- **Problem / observation.** DESIGN §8 shows `CacheStore` returning `CachedEntry` but
  never defines the shape. **Design gap.** Two platform facts make the "obvious"
  shape (stuff a `FetchResult` in the store) wrong:
  - `JSON.stringify(new Headers({...}))` → `"{}"` — verified via `deno eval`. A
    persistent store round-tripping through JSON would silently lose all headers,
    including the `ETag`/`Last-Modified` validators the conditional mode depends on.
  - `JSON.stringify(new Uint8Array([1,2,3]))` → `{"0":1,...}` — verified. Bodies cannot
    ride along in the JSON blob.
  - Bonus trap, verified: Headers iteration yields `set-cookie` entries individually
    (per WHATWG spec), so `Object.fromEntries(headers)` keeps only the **last**
    `Set-Cookie`; other multi-value headers are combined with `", "` (fine). Storing
    cookies in a shared cache is also a security hazard RFC 9111's security
    considerations warn about.
- **Evidence** — DESIGN §8 (`CacheStore` sketch, `CachedEntry` never defined);
  `deno eval` checks above run 2026-08-23 (Deno, this machine; re-run in the
  adversarial verify pass); DESIGN §4 `FetchResult.headers: Headers`.
- **Proposed change** — in `src/cache/types.ts`:

  ```ts
  /** Everything except `body` is JSON-serializable by construction. */
  export interface CachedEntry {
  	/** Entry format version. Stores should drop entries with an unknown version. */
  	v: 1;
  	url: string; // requested URL (the key's URL component)
  	finalUrl: string; // after redirects, for correct synthesis
  	redirects: string[];
  	status: number; // v1 default policy stores 200 only, but the field is general
  	statusText?: string;
  	/**
  	 * Response headers as a plain, lowercase-keyed record
  	 * (`Headers` is not JSON-serializable). `set-cookie` is stripped at store time.
  	 */
  	headers: Record<string, string>;
  	/** Raw body bytes. NOT JSON-serializable — persistent stores keep it out-of-band. */
  	body: Uint8Array;
  	contentType?: string; // resolved values copied from FetchResult so synthesis
  	charset?: string; //     never re-sniffs
  	size: number;
  	adapter: string; // adapter that produced the original response (provenance)
  	/** Validators, extracted from `headers` for convenience. */
  	etag?: string;
  	lastModified?: string;
  	/** Epoch ms when stored or last revalidated (ttl math anchors here). */
  	storedAt: number;
  }

  export interface CacheStore {
  	get(key: string): Promise<CachedEntry | undefined>;
  	set(key: string, entry: CachedEntry): Promise<void>;
  	delete(key: string): Promise<void>;
  }
  ```

  Construction rule (in the layer, not the store): `headers` =
  `Object.fromEntries(res.headers)` minus `set-cookie`; `etag` = `headers["etag"]`;
  `lastModified` = `headers["last-modified"]`. The store never inspects entries — it is
  a dumb KV. `bytes()` on a synthesized result returns `entry.body` **without a
  defensive copy**; document it as read-only shared memory (copying multi-MB bodies per
  hit defeats the purpose).
- **Affected files** — `src/cache/types.ts` (new); re-export from `src/cache/mod.ts`
  and the package root `src/mod.ts`.
- **Effort / Value / Risk** — S / high / low.
- **Implementation notes** — keep `v` a literal `1` type so a future `v: 2` becomes a
  discriminated union. Do not store `meta` (caller payload is per-request, echoed from
  the live request at synthesis time, DESIGN §4) and do not store `extra`
  (adapter-specific, often non-serializable — browser screenshot handles etc.).

### 2. `createCacheLayer` — one wrapper, two modes, full 304 flow

- **Problem / observation.** DESIGN §8 names the two purposes but not the wrapper, its
  options, or the 304 mechanics ("resolve 304 into a full result from the store" is one
  sentence). **Design gap** — the whole state machine needs a spec. Also note DESIGN §3
  stack order (retry → cache → guards → adapter) is **sound** for this layer: synthesized
  hits bypass guards (already enforced at store time), real revalidations still pass
  through them, and a retried attempt re-enters the cache layer idempotently. One line of
  confirmation is enough there.
- **Evidence** — DESIGN §8, §3 (layer rule `(next: FetchFn) => FetchFn`), §4
  (`fromCache`, `notModified` fields); RFC 9111 §4.3.4 (freshening stored responses on
  304 — "lite" subset below); RFC 9111 §4.3 (a cache constructing a conditional request
  sends the validators it has stored — both when it has both); RFC 9110 §13.1.3 (a
  recipient MUST ignore `If-Modified-Since` when the request carries `If-None-Match`,
  so sending both is safe and ETag wins).
- **Proposed change** — type declarations land in `src/cache/types.ts` (module layout
  below); the factory in `src/cache/layer.ts`. Shown together for locality:

  ```ts
  export type CacheMode = "dev" | "conditional";

  export interface CacheLayerOptions {
  	store: CacheStore;
  	/** Default "conditional" — the correct-by-default mode. */
  	mode?: CacheMode;
  	/**
  	 * Freshness window in ms, anchored at `storedAt`.
  	 * dev: entries older than ttl are refetched (no ttl = serve forever).
  	 * conditional: entries younger than ttl are served WITHOUT revalidation
  	 * (a caller-driven max-age); no ttl = revalidate on every request.
  	 */
  	ttl?: number;
  	/** Key override; return undefined to bypass caching for a request. */
  	key?: (req: FetchRequest) => string | undefined;
  	/** Which results get stored. Default: see finding 6. */
  	isCacheable?: (res: FetchResult) => boolean;
  	logger?: Logger; // type-only import from @marianmeres/clog; silent when absent
  }

  export function createCacheLayer(
  	options: CacheLayerOptions,
  ): (next: FetchFn) => FetchFn;
  ```

  Flow (per request):
  1. Bypass → `next(req)` untouched when: method is not `GET` (finding 3); `key(req)`
     returns `undefined`; the request already carries `if-none-match`,
     `if-modified-since`, or `range` headers (the caller is running its own conditional
     or partial dance — never answer it from our store).
  2. `entry = await store.get(key)`.
  3. **Fresh hit** (entry exists AND (mode "dev" with no/unexpired ttl, OR mode
     "conditional" with unexpired ttl)) → synthesize (finding 4), no network.
  4. **Conditional revalidation** (mode "conditional", entry exists, has `etag` or
     `lastModified`) → call `next` with a shallow-cloned request adding `If-None-Match`
     and/or `If-Modified-Since` (send both when both exist).
     - `status === 304` → freshen the entry **RFC 9111 §4.3.4-lite**: merge the 304's
       headers over `entry.headers` (skip `content-length`; re-strip `set-cookie`),
       refresh `etag`/`lastModified` from the merged record, `storedAt = Date.now()`,
       `store.set`, then synthesize with `notModified: true` (finding 4).
     - `status === 200` and `isCacheable` → build a fresh entry (`await res.bytes()`),
       `store.set`, return the live result.
     - anything else (4xx/5xx, `ok: false`) → return the live result as-is and **leave
       the stored entry in place** (a flaky origin must not evict a good cache; we do
       NOT serve stale on error — no `stale-if-error` in v1, document).
  5. **Miss** (or dev-expired, or conditional entry without validators) → `next(req)`;
     if `isCacheable` → build entry, `store.set`; return the live result.

  Errors thrown by `next` propagate unchanged — the cache layer never converts errors,
  and never serves a hit to mask one.

  Explicit scope statement for the README + module JSDoc: **this is not an RFC 9111
  HTTP cache.** No `Cache-Control` freshness parsing, no heuristic freshness, no
  `Vary`, no `stale-while-revalidate`. `ttl` is caller policy; the only header-derived
  behaviors are the validators and the `no-store` courtesy check (finding 6).
- **Affected files** — `src/cache/layer.ts` (new), `src/cache/types.ts`,
  `src/cache/mod.ts` (re-export). `createFetcher` wiring: caching stays **off by
  default** (confirming DESIGN §8 "off by default") — `createFetcher` composes this
  layer only when given `cache: CacheLayerOptions | CacheStore` (bare store ⇒ defaults,
  mode "conditional"); exact option plumbing belongs to the composition dimension doc —
  pointer only.
- **Effort / Value / Risk** — M / high / low.
- **Implementation notes** — buffering for storage calls `await res.bytes()`;
  **dependency on doc 01**: `bytes()`/`text()` must be memoized/idempotent so an
  intermediate layer can read the body without consuming it for downstream callers.
  Consequence to document loudly: enabling the cache layer forces full body retention
  in memory for cacheable responses (defeats lazy/streaming bodies) — that is inherent,
  not a bug. Never `store.delete` on revalidation failure. The 304 header merge is a
  plain object spread: `{ ...entry.headers, ...fromEntries304 }` minus the skip list.
  The step-1 bypass check must be **case-insensitive** — `FetchRequest.headers` is a
  plain `Record<string, string>` (DESIGN §4), so a caller may spell `If-None-Match`
  any way it likes.

### 3. Key derivation, GET-only caching, and the `Vary` non-goal

- **Problem / observation.** DESIGN §8 says keys are "method+URL+adapter". Two wrinkles:
  (a) **Design gap** — adapter _routing_ may be dynamic (`selectAdapter(req)`, DESIGN
  §5.3) and resolves _below_ the cache layer in the §3 stack, so the resolved adapter
  name is unknowable at `get()` time; keying on the response's adapter at `set()` time
  would never match at `get()` time. The key must derive from the **request only**.
  (b) Caching POST would require keying on a body hash and reasoning about
  idempotency — pure cost for a page fetcher.
- **Evidence** — DESIGN §8 (key sketch), §5.3 (`selectAdapter`), §3 (stack order), §4
  (`FetchRequest.adapter?: string`).
- **Proposed change** — `src/cache/key.ts`:

  ```ts
  /** Default key: `${req.adapter ?? "*"}:GET:${req.url}`. Undefined = do not cache. */
  export function cacheKey(req: FetchRequest): string | undefined;
  ```

  - Returns `undefined` for any method other than `GET` (default `method` is `GET`
    when absent). POST/HEAD pass through the layer untouched. **Design deviation
    (narrowing):** the design's "method+URL+adapter" key implies HEAD could be cached;
    v1 caches GET only — a cached HEAD entry would be bodyless, breaking the
    `CachedEntry` invariant and complicating synthesis for ~zero savings (HEAD is cheap
    by construction). The method stays in the key string anyway so a future widening
    needs no migration.
  - Uses `req.adapter ?? "*"` — the _requested_ adapter, not the resolved one. When
    routing is dynamic, entries from different adapters for the same URL share a key;
    document this and point users at the `key` override (e.g. bake their routing rule
    into the key) if it matters to them.
  - The URL goes in verbatim — no normalization (DESIGN §1 non-goals: URL normalization
    is the crawler's job). `?a=1&b=2` vs `?b=2&a=1` are distinct keys; document.
  - **`Vary` handling is explicitly out of scope for v1.** Two requests for the same
    URL with different `Accept-Language`/`User-Agent` hit the same entry. Document in
    README + JSDoc; the `key` override callback is the escape hatch (a user can fold
    chosen request headers into the key themselves).
- **Affected files** — `src/cache/key.ts` (new); consumed by `src/cache/layer.ts`.
- **Effort / Value / Risk** — S / high / low.
- **Implementation notes** — plain string concat, no hashing (keys are debuggable and
  memory-store friendly; a persistent store that needs filename-safe keys can hash on
  its side — mention in the recipe, finding 7).

### 4. Synthesized-result semantics — the `fromCache`/`notModified` matrix

- **Problem / observation.** DESIGN §4 defines both flags but not their joint meaning,
  and says nothing about `attempts`/`timing`/`adapter` on a result that never touched
  the network. **Design gap** — left unspecced, the crawler cannot distinguish "served
  from dev cache" from "revalidated, unchanged", and `attempts` would lie.
- **Evidence** — DESIGN §4 (`fromCache`, `notModified: // 304 path taken`, `attempts`,
  `timing`, `adapter`); DESIGN §9 (attempts/timing "carry the aggregate").
- **Proposed change** — normative matrix (README table + JSDoc on both flags; the type
  fields themselves live in doc 01's `types.ts` — coordinate, pointer only):

  | Scenario                                  | `fromCache` | `notModified` | `attempts`                        | `timing`                                          | `adapter`                    |
  | ----------------------------------------- | ----------- | ------------- | --------------------------------- | ------------------------------------------------- | ---------------------------- |
  | Live network fetch                        | false       | false         | ≥1, real                          | real                                              | resolved adapter             |
  | Pure hit (dev, or conditional within ttl) | true        | false         | **0**                             | store-lookup wall time (near-zero; no dns/ttfb/…) | `entry.adapter` (provenance) |
  | 304 revalidation                          | true        | true          | from the revalidation result (≥1) | from the revalidation result (real network)       | from the revalidation result |
  | Fresh 200 stored this request             | false       | false         | real                              | real                                              | resolved adapter             |

  - `attempts: 0` is the honest value for a pure hit — zero network attempts were made.
    Doc 01 must word `attempts` as "network attempts; 0 for a pure cache hit".
  - A 304's `attempts`/`timing` are **real** — a conditional request genuinely hit the
    network; only status/headers/body/finalUrl/redirects/contentType/charset/size come
    from the (freshened) entry. Synthesized `status` is the stored one (200), not 304;
    `ok: true`.
  - `adapter` on a pure hit reports the entry's originating adapter rather than a
    sentinel like `"cache"` — provenance is more useful downstream and `fromCache`
    already flags the hit. (Deliberate choice; the sentinel alternative was rejected.)
  - Synthesis mechanics: `headers: new Headers(entry.headers)`; `bytes()` resolves to
    `entry.body` (shared, see finding 1); `text()` decodes via
    `new TextDecoder(entry.charset ?? "utf-8")`, memoized; `meta` echoed from the
    **live request**, not the entry; `extra` absent.
- **Affected files** — `src/cache/layer.ts` (a private `entryToResult(entry, req,
  overrides)` helper); doc-01-owned JSDoc wording on `attempts`/`fromCache`/
  `notModified` (pointer).
- **Effort / Value / Risk** — S / high / low.
- **Implementation notes** — build `FetchTiming` for a pure hit as
  `{ startedAt, endedAt, total }` measured around the `store.get` await; leave the
  optional phase fields unset. Never fabricate `dns`/`ttfb`.

### 5. Memory store — `Map` with reorder-on-get LRU, no timers

- **Problem / observation.** DESIGN §8 ships `createMemoryCache()` only, unspecced. An
  unbounded `Map` in a long crawl with ~MB bodies is an OOM generator; a full LRU
  library contradicts zero-deps. Is LRU overkill here? A _real_ LRU structure yes, but
  `Map` insertion-order abuse gives LRU behavior in ~6 lines (on `get` hit: `delete` +
  re-`set` to move the key to the end; on `set` over capacity: evict
  `map.keys().next().value`). That is not overkill; it is the cheapest correct bound.
  Also: **no background TTL sweeper** — a library must not own `setInterval` timers
  (Deno test sanitizers flag leaked timers; event-loop hygiene). TTL is layer policy
  anyway (finding 2): expired entries are simply overwritten, and memory is bounded by
  `maxEntries`, so a sweeper buys nothing.
- **Evidence** — DESIGN §8 ("Ship `createMemoryCache()` only"); DESIGN §10 (zero-leak
  test posture); `Map` iteration-order guarantee (ES spec, insertion order — safe).
- **Proposed change** — `src/cache/memory.ts`:

  ```ts
  export interface MemoryCacheOptions {
  	/** Max entries kept; least-recently-used evicted first. Default 1000. */
  	maxEntries?: number;
  	logger?: Logger; // debug-logs evictions; silent when absent
  }

  export interface MemoryCache extends CacheStore {
  	/** Current entry count (bodies dominate actual memory — see docs). */
  	readonly size: number;
  	clear(): void;
  }

  export function createMemoryCache(options?: MemoryCacheOptions): MemoryCache;
  ```

  Store is a dumb KV: no ttl awareness, no entry inspection, `get`/`set`/`delete`
  wrapped in `Promise.resolve` to satisfy the async interface. Document the memory
  math bluntly: 1000 entries × ~100 KB average page ≈ 100 MB; with pathological 10 MB
  bodies (`maxBytes` default, DESIGN §7) the worst case is 10 GB — size `maxEntries`
  to your corpus, or write a persistent store (finding 7). A byte-budget cap
  (`maxBytesTotal`) is deliberately omitted in v1 — `maxEntries` + the guards layer's
  `maxBytes` bound the product well enough; note as a possible v2 knob.
- **Affected files** — `src/cache/memory.ts` (new).
- **Effort / Value / Risk** — S / med / low.
- **Implementation notes** — `set` on an existing key must also reorder (delete first).
  Eviction happens synchronously inside `set`. `structuredClone` is NOT used — entries
  are stored and returned by reference (verified `structuredClone` handles
  `Uint8Array`, but copying MB bodies per op is the wrong default; documented shared
  ownership per finding 1).

### 6. Cacheability policy — store 200s (and honor `no-store`); negative caching is an override

- **Problem / observation.** DESIGN §8 never says _what_ is cacheable. Caching every
  `ok: false` result would make the dev cache faithfully replay yesterday's 500s;
  caching 3xx is meaningless (redirects are followed below this layer, DESIGN §5.1);
  yet a crawler may legitimately want negative caching of 404s. Also, silently caching
  responses the origin marked `Cache-Control: no-store` is the one RFC 9111 directive
  worth a two-line courtesy check even in a non-HTTP-cache.
- **Evidence** — DESIGN §8 (silent), §4 (`ok: false` non-2xx are data, not errors),
  §5.1 (redirects handled in-adapter).
- **Proposed change** — default in `src/cache/layer.ts`:

  ```ts
  function defaultIsCacheable(res: FetchResult): boolean {
  	if (res.status !== 200) return false;
  	const cc = res.headers.get("cache-control")?.toLowerCase() ?? "";
  	return !/(^|[\s,])no-store($|[\s,=])/.test(cc);
  }
  ```

  v1 default: **status 200 only**. Not 2xx-wide: 204/206 are bodyless/partial and 201
  &c. are non-GET territory anyway. Negative caching (404s for the crawler) is the
  documented extension point — `isCacheable: (res) => res.status === 200 ||
  res.status === 404` works today because `CachedEntry.status` is general (finding 1)
  and synthesis replays whatever status was stored; only the default is conservative.
  No other `Cache-Control` directive is interpreted (finding 2 scope statement).
- **Affected files** — `src/cache/layer.ts`; README "recipes" section (DESIGN §12 item
  10 already plans §8 recipes).
- **Effort / Value / Risk** — S / med / low.
- **Implementation notes** — the check runs on live results only; 304 freshening never
  re-evaluates it (the entry was cacheable when stored). Keep the regex (behavior
  verified against `no-store`, list-separated forms, and `no-store-policy`); a naive
  `includes("no-store")` would false-positive on `no-store-policy`-style extensions.

### 7. Serialization helpers + persistent-store recipe (docs, not deps)

- **Problem / observation.** DESIGN §8: "Document how to back it with SQLite or the
  filesystem; do not depend on either." With `CachedEntry` specced serialization-first
  (finding 1), two pure functions make every persistent store trivial and freeze the
  contract — without them, each user re-discovers the Headers/Uint8Array traps this doc
  opened with.
- **Evidence** — DESIGN §8; platform checks in finding 1;
  `Uint8Array.prototype.toBase64` exists in Deno (verified) but its Node baseline is
  newer — assumed available in current Node LTS targets; verify at implementation time,
  which is exactly why the helpers below avoid base64 and hand bytes back raw.
- **Proposed change** — `src/cache/serialize.ts`:

  ```ts
  /** Split an entry into a JSON string (everything but body) and the raw bytes. */
  export function serializeCachedEntry(
  	entry: CachedEntry,
  ): { meta: string; body: Uint8Array };

  /** Inverse. Throws PageFetchError kind "decode" on version mismatch / bad JSON. */
  export function deserializeCachedEntry(meta: string, body: Uint8Array): CachedEntry;
  ```

  The store decides where each half goes: fs recipe (README) — `sha256(key).json` +
  `sha256(key).body` under a cache dir; SQLite recipe — `meta TEXT, body BLOB` keyed by
  the raw key. Both recipes are README code blocks using `Deno.writeFile`/`node:fs` in
  _user_ code — the package itself stays dependency-free and Node-compatible.
- **Affected files** — `src/cache/serialize.ts` (new); README.
- **Effort / Value / Risk** — S / med / low.
- **Implementation notes** — `meta` JSON is `{ ...entry, body: undefined }` with the
  `v` field enabling forward-compat drops. Keep the helpers dependency-free (no
  hashing inside; recipes hash keys with `crypto.subtle.digest` — verified in Deno,
  and a global in Node since v19, so safe for current Node LTS).

### 8. Logger integration (user requirement) + observability seam

- **Problem / observation.** Per the binding user requirement, the `Logger` interface
  from `@marianmeres/clog` is a first-class optional on every factory; DESIGN §9's
  events remain the structured channel. One genuine gap the logger conveniently
  papers over: **DESIGN §9 events are emitted per attempt, so a pure cache hit —
  zero attempts — is invisible to `FetcherEvents`** (no `onCacheHit`, and `onResponse`
  under per-attempt granularity never fires). Whether to extend `FetcherEvents` is the
  observability dimension's call — pointer, not duplicated here; the cache layer's
  `logger` guarantees hits are at least _observable_ in v1 either way.
- **Evidence** — `/Users/mm/projects/@marianmeres/clog/src/clog.ts:186-218` (`Logger`
  interface: `debug`/`log`/`warn`/`error`, structurally satisfied by `console`);
  DESIGN §9 ("emit per attempt, not per logical request").
- **Proposed change** — `logger?: Logger` on `CacheLayerOptions` (finding 2) and
  `MemoryCacheOptions` (finding 5). Import as
  `import type { Logger } from "@marianmeres/clog";` — type-only, erased at runtime;
  zero-runtime-dep promise holds (clog listed as a compile-time import in deno.json —
  accepted per shared context). Default: silent (no logging when absent; never default
  to `console`). Debug-level lines, all prefixed with the cache key:
  `hit (dev)`, `hit (fresh, ttl)`, `revalidate → 304 (freshened)`,
  `revalidate → 200 (replaced)`, `miss → stored`, `miss → not cacheable (<status>)`,
  `bypass (<reason>)`, and `evict <key>` from the memory store. `warn` only for a
  store `get`/`set` that throws (see open questions).
- **Affected files** — `src/cache/layer.ts`, `src/cache/memory.ts`; `deno.json`
  (add `"@marianmeres/clog"` to imports — the scaffold's import map does not have it
  yet, verified; shared with every other dimension, pointer to the packaging doc).
- **Effort / Value / Risk** — S / med / low.
- **Implementation notes** — guard every call site with `logger?.debug(...)` — no
  no-op logger object allocation.

## Module layout (src/cache/)

```
src/cache/mod.ts        — public re-exports (types, cacheKey, createMemoryCache,
                          createCacheLayer, serialize helpers)
src/cache/types.ts      — CachedEntry, CacheStore, CacheMode, CacheLayerOptions
src/cache/key.ts        — cacheKey(req)
src/cache/memory.ts     — createMemoryCache
src/cache/layer.ts      — createCacheLayer + entryToResult + defaultIsCacheable
src/cache/serialize.ts  — serializeCachedEntry / deserializeCachedEntry
```

Note for the packaging dimension (pointer): DESIGN §2 suggests a
`@marianmeres/page-fetcher/cache` subpath export; the scaffold `deno.json` currently
has a single `"exports": "./src/mod.ts"` (verified) — the exports map needs the
`./cache` entry when that doc lands its decision. Everything here is also re-exported
from the root `src/mod.ts` regardless, so the subpath is ergonomics, not access.

Tests (tests/cache/, names only — test dimension owns the fixture server): key
derivation & bypass matrix; dev hit/expiry; conditional 304 freshen (assert merged
headers + bumped `storedAt`); 304-synthesis flag matrix incl. `attempts: 0` vs real;
revalidation 500 leaves entry intact; LRU eviction order; `set-cookie` stripped;
serialize round-trip; no-store skip. The DESIGN §10 fixture server already plans a
"304 flow" endpoint — this dimension consumes it.

## Overlaps with other dimension docs (pointers)

- **Doc 01 (types):** `bytes()`/`text()` idempotency requirement; `attempts` wording
  ("network attempts; 0 for a pure cache hit"); `fromCache`/`notModified` JSDoc.
- **Composition doc:** `createFetcher({ cache })` plumbing; confirmed here only that
  caching stays off by default and a bare `CacheStore` gets conditional-mode defaults.
- **Observability doc:** cache-hit visibility in `FetcherEvents` (per-attempt emission
  makes pure hits invisible — needs a decision there).
- **Packaging doc:** `./cache` subpath export; `@marianmeres/clog` compile-time import.

## Open questions / decisions needed

- Cache `HEAD` responses too (bodyless entries, per the literal "method+URL+adapter"
  key sketch) or GET-only as recommended here? Recommendation: GET-only v1.
- Default mode when `createFetcher` receives a bare `CacheStore`: `"conditional"`
  (recommended, correct-by-default) or `"dev"` (matches the likeliest first use case —
  iterating on extraction logic)?
- Should a throwing `store.get`/`store.set` fail the request or degrade to a cache
  bypass with a `logger.warn`? Recommendation: degrade + warn (a broken persistent
  store should not take fetching down), but it hides real bugs — owner's call.
- Ship `serializeCachedEntry`/`deserializeCachedEntry` in v1 (recommended, S effort)
  or keep the persistent-store contract README-only?

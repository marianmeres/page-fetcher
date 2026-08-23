<!--
GENERATED ANALYSIS — @marianmeres/page-fetcher implementation plan
Produced 2026-08-23 by multi-agent research -> adversarial verify -> synthesize.
Claims verified against the design doc (tmp/page-fetcher-DESIGN.md), local ecosystem
sources, and platform checks. Adversarial re-verification 2026-08-23 re-ran all live
platform checks (Deno 2.9.5, Node v26.7.0, localhost-only fixture servers); one
evidence correction was applied (gzip Content-Length behavior, finding 1).
Repo is a pre-first-commit scaffold; no code was changed.
-->

# HTTP adapter & correctness guards

> This dimension covers `createHttpAdapter` (DESIGN §5.1) and the correctness guards of
> DESIGN §7 that live at or near the adapter: manual redirect handling, streaming with
> `maxBytes`, content-type policy, charset detection/decoding, per-attempt timeout vs
> total deadline, `AbortSignal` composition, and the default User-Agent. All
> platform-behavior claims below were verified live against Deno 2.9.5 and Node v26.7.0
> (undici fetch) with network-free localhost servers, and re-run during adversarial
> review.

> The single most important takeaway: **DESIGN §3's rule that "guards are composable
> `(next: FetchFn) => FetchFn` wrappers" cannot hold for the stream-level guards.**
> `maxBytes`, content-type policy and charset decoding must run _inside_ the adapter,
> between receiving headers and reading the body — a wrapper around `FetchFn` only sees a
> finished `FetchResult`, which is too late to abort a 2 GB download or to skip a body.
> Ship these as small reusable helper modules (`src/read-body.ts`, `src/content-type.ts`,
> `src/charset.ts`) that any adapter calls internally, and keep only timeout / deadline /
> abort-composition as true wrapper layers. Additionally, §3's sketch places all guards
> _under_ retry — correct for the per-attempt timeout, wrong for the total deadline,
> which must sit _outside_ retry. (Finding 3.)

> Headline good news: the design's riskiest platform assumption holds. `redirect:
> "manual"` on server-side fetch returns the real 3xx (status 302, readable `Location`,
> readable body, `type: "basic"`) on **both** Deno and Node — no browser-style
> `opaqueredirect` filtering — so the observable, cappable manual redirect loop of §5.1
> is implementable exactly as designed. One trap found that the design is silent on:
> with `Content-Encoding: gzip`, the body reader yields **decoded** bytes while
> `Content-Length` — when the response carries one — still reports the **compressed**
> wire size (verified on both runtimes). `maxBytes` therefore counts DECODED bytes, and
> the Content-Length fast-fail must be gated on the absence of a `Content-Encoding`
> header.

> Logger note (user requirement, overrides doc silence): every factory in this dimension
> accepts `logger?: Logger` (type-only import from `@marianmeres/clog`, local source
> v3.21.0, published to JSR), default silent. This complements — does not replace — the
> §9 `FetcherEvents`.

## Summary of recommendations

(Ordered by value desc, then effort asc. `#` = detailed finding number below.)

| #  | Recommendation                                                                                                                                                              | Value | Effort | Risk                                             |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | ------------------------------------------------ |
| 1  | Streaming `readBodyLimited`: decoded-byte counting, `reader.cancel()` on exceed → `too-large`; Content-Length fast-fail only for identity encoding                          | high  | S      | low — behavior verified on both runtimes         |
| 2  | Charset pipeline: BOM → HTTP header → meta (first 2 KB) → fallback utf-8; unknown label never throws (RangeError caught)                                                    | high  | S      | low — windows-1250 verified on both runtimes     |
| 3  | Split guards: stream guards (maxBytes, content-type, charset) as in-adapter helpers; timeout/deadline/abort as wrapper layers; deadline OUTSIDE retry                       | high  | M      | low — design clarification, no contract change   |
| 4  | Manual redirect loop: cap 5, visited-set loop detection, chain recording, 301/302/303 method rewrite vs 307/308 preserve, drop Authorization+Cookie cross-origin            | high  | M      | low — behavior verified on both runtimes         |
| 5  | Timeout/deadline signal spec: own `setTimeout`+controller (not `AbortSignal.timeout`), typed abort reasons discriminated via `signal.reason`, `AbortSignal.any` composition | high  | M      | low — `any()` + reason propagation verified      |
| 6  | Content-type policy: `parseContentType` (lowercase, strip params), fixed `+json` default-list gap, `skip-body` semantics, HEAD exempt                                       | med   | S      | low                                              |
| 7  | `FetchTiming` honesty: adapter fills `startedAt/endedAt/total/ttfb/download` only; `dns`/`connect` stay undefined — §4 sketch over-promises                                 | med   | S      | low — verified: no resource timing in Deno fetch |
| 8  | Default User-Agent constant + header merge rules (platform defaults are `Deno/2.9.5` / `node`; Accept-Encoding must NOT be set manually)                                    | med   | S      | low                                              |
| 9  | Logger integration map for adapter + guards (debug/warn only; errors are thrown, never double-logged)                                                                       | med   | S      | low                                              |
| 10 | Cookie jar: confirm DESIGN §11.3 — leave out of v1 entirely; a caller-supplied `cookie` header is enough (and is dropped cross-origin like Authorization)                   | med   | S      | low — confirmation, not deviation                |

## Proposed module layout (this dimension's slice of src/)

```
src/
  adapters/
    http.ts        createHttpAdapter — redirect loop, header merge, UA, orchestrates helpers
  guards.ts        timeoutGuard, deadlineGuard (true (next)=>FetchFn layers), composeSignal
  read-body.ts     readBodyLimited — streaming reader with maxBytes enforcement
  content-type.ts  parseContentType, isAllowedContentType
  charset.ts       sniffCharset, decodeText
```

`src/types.ts` / `src/errors.ts` (FetchFn, FetchRequest, FetchResult, PageFetchError) are
owned by the types dimension (doc 01) — this doc only consumes them. Retry/backoff and
circuit breaker → doc 03. `createFetcher` composition order and `throwOnHttpError` → the
composition dimension. Cache/304 handling → the cache dimension; the adapter passes 304
through as a final response untouched.

## Findings & recommendations (detailed)

### 1. `readBodyLimited` — maxBytes counts DECODED bytes; Content-Length fast-fail gated on identity encoding

- **Problem / observation.** §5.1 says "streams the body and aborts as soon as maxBytes
  is exceeded" and "lets the platform decompress", but never states which byte count
  `maxBytes` refers to, and §7's implicit Content-Length fast-fail is unsound under
  compression. Verified: serving 1000 bytes gzipped (29 bytes on the wire), **both**
  runtimes deliver 1000 decoded bytes from the body reader while `Content-Length` — when
  the response carries one — still reports the compressed size (29). Both retain the
  `Content-Encoding: gzip` response header. Whether `Content-Length` survives at all
  under a compressed transfer is a runtime/server implementation detail — do not rely on
  it in either direction. So a naive `Content-Length > maxBytes` check compares
  compressed size against a decoded-bytes budget.

  > **Cut from the draft:** the claim that "Deno strips `Content-Length` entirely" on
  > compressed responses (a Deno/Node divergence) — it did not reproduce: re-verification
  > against both a Deno-served and a Node-served gzip endpoint shows Deno 2.9.5 keeping
  > the compressed `Content-Length` (42 and 29 respectively). The corrected, stronger
  > statement above yields the same rule.
- **Evidence.** Live localhost gzip tests, both runtimes as client (Deno client also
  cross-checked against a Node-served endpoint): decoded length 1000, `content-length`
  reports the compressed wire size, `content-encoding: gzip` retained. Also verified:
  `response.body === null` for HEAD and 204 responses (Deno). DESIGN §5.1, §7.
- **Proposed change.** `src/read-body.ts`:
  ```ts
  export async function readBodyLimited(
  	body: ReadableStream<Uint8Array> | null,
  	opts: {
  		maxBytes: number; // counts DECODED (post-decompression) bytes — document loudly
  		url: string; // for error construction
  		signal?: AbortSignal;
  		logger?: Logger;
  	},
  ): Promise<Uint8Array>;
  ```
  Behavior: `body === null` → return `new Uint8Array(0)` (HEAD/204/304 path, verified).
  Otherwise `body.getReader()`, accumulate chunks, running total of chunk lengths; on
  `total > maxBytes` → `await reader.cancel()` then throw `PageFetchError`
  `kind: "too-large"`, `retryable: false`, with bytes-read-so-far in the message.
  Concatenate once at the end (single allocation from collected chunks).
  Fast-fail in the adapter _before_ reading: iff the response has NO `Content-Encoding`
  header (or `identity`) AND `Content-Length` parses AND exceeds `maxBytes` → throw
  `too-large` without touching the body (`res.body?.cancel()` first). When
  `Content-Encoding` is present, skip the fast-fail entirely and rely on streaming
  enforcement — state in the README that `maxBytes` is a decoded-bytes budget.
- **Affected files.** src/read-body.ts (new), src/adapters/http.ts (fast-fail call
  site), tests (oversized fixture per DESIGN §10, plus a gzip fixture asserting decoded
  counting).
- **Effort / Value / Risk.** S / high / low.
- **Implementation notes.** Do not pass an AbortController into the reader for the
  exceed case — `reader.cancel()` is sufficient and cleaner than aborting the fetch
  (cancel propagates). The `signal` option is only observed to bail early between reads.
  Accept-Encoding must NOT be set manually: verified both platforms already send it
  (Deno `gzip,br`, Node `gzip, deflate`) and decompress transparently — §5.1's "sends
  Accept-Encoding" should read "the platform already does; do not override it".

### 2. Charset pipeline — BOM should outrank the HTTP header (design deviation); unknown labels never throw

- **Problem / observation.** §7 orders detection as HTTP header → BOM → meta → fallback.
  The WHATWG encoding standard (and every browser) puts the **BOM above the header**: a
  BOM is ground truth written by the encoder, while `charset=` params are routinely
  stale server config. Header-first re-creates the classic mojibake case (server says
  `iso-8859-1`, file is UTF-8 with BOM).
- **Evidence.** DESIGN §7 (Charset). Live checks: `new TextDecoder("windows-1250")`
  decodes `[0x9e,0xe8,0x9a,0xef]` → `"žčšď"` on Deno AND Node; `new
  TextDecoder("x-bogus")` throws `RangeError` on both (so the fallback path must catch);
  utf-8 decoding of invalid bytes with default `fatal: false` yields U+FFFD replacement
  chars, never throws. Content-Type header arrives verbatim
  (`TEXT/HTML; Charset=WINDOWS-1250; foo=bar` preserved — verified) — parser must
  lowercase.
- **Proposed change** (**Design deviation:** BOM first — approve or veto, open q. 1).
  `src/charset.ts`:
  ```ts
  /** Decide the charset label. Inspects at most the first 2048 bytes.
   * Precedence: BOM (utf-8 / utf-16le / utf-16be) → headerCharset → <meta> sniff → fallback. */
  export function sniffCharset(
  	bytes: Uint8Array,
  	opts?: { headerCharset?: string; sniffMeta?: boolean; fallback?: string }, // fallback: "utf-8"
  ): string;

  /** Decode with the label; unknown label (RangeError) falls back to utf-8, never throws.
   * Returns the charset actually used. */
  export function decodeText(
  	bytes: Uint8Array,
  	label: string,
  	logger?: Logger,
  ): { text: string; charset: string };
  ```
  Details: BOM table — `EF BB BF` → utf-8, `FF FE` → utf-16le, `FE FF` → utf-16be
  (TextDecoder's default `ignoreBOM: false` strips the BOM from output — verified;
  utf-16 must select the matching decoder). Meta sniff only when the mime is an HTML/XML
  family type: ASCII-decode the first 2 KB and match `<meta charset="...">` and `<meta
  http-equiv="content-type" content="...charset=...">` case-insensitively. Unknown label
  anywhere in the chain → next precedence level, ultimately utf-8, with `logger?.warn`.
  Consequence worth documenting: with `fatal: false` decoding, the `"decode"` error
  kind is effectively unreachable on the HTTP path — it stays in the union for adapters
  that decode differently.
- **Affected files.** src/charset.ts (new), src/adapters/http.ts (calls sniff+decode for
  the `text()` path), tests (the mandated windows-1250 fixture, DESIGN §7/§10, plus
  BOM-vs-header and meta-sniff fixtures).
- **Effort / Value / Risk.** S / high / low.
- **Implementation notes.** `FetchResult.charset` = the label `decodeText` actually
  used; `text()` memoizes (decode once). Per §11.1, HTTP `text()` is lazy: retain bytes,
  decode on first call — bytes are already fully in memory post-`readBodyLimited`, so
  laziness costs nothing and `bytes()` is free.

### 3. Stream guards cannot be `(next) => FetchFn` wrappers — restructure where guards live

- **Problem / observation.** DESIGN §3 declares "layers are `(next: FetchFn) =>
  FetchFn`" and sketches guards (content-type, size, timeout) as one wrapper in the
  stack. A wrapper sees only the resolved `FetchResult`. By that point the adapter has
  already read the body — enforcing `maxBytes` there means the 2 GB download already
  happened, and `skip-body` cannot cancel a body that was already consumed. §5.1's own
  requirement ("streams the body and aborts as soon as maxBytes is exceeded — never
  buffer first") is only satisfiable _inside_ the adapter, between headers and body read.
  The same applies to content-type policy (must decide before reading the body) and
  charset decoding (needs the raw bytes + headers).
- **Evidence.** DESIGN §3 (layer rule + stack sketch), §5.1 (streaming requirement), §7
  (guards list). Contradiction is structural, not empirical.
- **Design deviation (recommended).** Keep the §3 wrapper rule for the _control-flow_
  guards only — per-attempt timeout, total deadline, abort composition (finding 5) — and
  reclassify the _stream_ guards as plain helper functions the adapters call internally:
  `readBodyLimited` (src/read-body.ts), `parseContentType`/`isAllowedContentType`
  (src/content-type.ts), `sniffCharset`/`decodeText` (src/charset.ts). They stay
  independently exported and unit-testable (satisfying the "every layer usable
  standalone" intent), they are just not `FetchFn` wrappers. The browser adapter reuses
  `charset.ts`/`content-type.ts` where applicable; the maxBytes reader is fetch-specific.
- **Second half of the finding: deadline placement.** §3's sketch puts guards _under_
  retry. Correct for per-attempt timeout (it must re-arm per attempt, and retry calling
  `next()` per attempt gives that for free). Wrong for the total deadline, which spans
  attempts and must also bound retry sleeps (§6: "never sleep past it"). Stack order
  must be: `events → deadline → cache → retry → timeout → adapter` (outermost first).
  The deadline guard normalizes `deadline: number | Date` into an absolute epoch-ms
  value re-attached to the request, so the retry layer (doc 03) can compute remaining
  budget before sleeping without re-deriving it.
- **Affected files.** src/adapters/http.ts, src/guards.ts, src/read-body.ts,
  src/content-type.ts, src/charset.ts; composition order lands in the createFetcher doc.
- **Effort / Value / Risk.** M / high / low.
- **Implementation notes.** Nothing in the public §4 types changes; this is purely
  internal placement. Document the split in README ("guards" section) so users composing
  their own stacks know timeout/deadline are wrappers while maxBytes/content-type are
  adapter options.

### 4. Manual redirect loop — verified viable; full hop-by-hop spec

- **Problem / observation.** §5.1 mandates `redirect: "manual"`; the browser fetch spec
  would return an `opaqueredirect` filtered response (status 0, no headers), which would
  kill the design. Verified this does NOT apply server-side: both runtimes return the
  real 3xx.
- **Evidence.** Live localhost test, Deno 2.9.5: `status: 302, type: "basic", location:
  "/b", redirected: false`, redirect body readable. Node v26.7.0: identical (`status:
  302, type: "basic"`, body readable). DESIGN §5.1, §7 (cap, chain, loop, Authorization
  rule).
- **Proposed change.** In `src/adapters/http.ts`, the redirect loop spec:
  1. `for (let hop = 0; ; hop++)` starting at `current = req.url`; a `Set<string>` of
     `"METHOD url"` strings for loop detection.
  2. Call `platformFetch(current, { method, headers, body, redirect: "manual", signal })`.
  3. A response is a redirect iff `status ∈ {301, 302, 303, 307, 308}` AND it has a
     `Location` header. **304 is 3xx but never a redirect** — pass through as final
     (cache dimension consumes it). A 301/302/etc _without_ Location → final response
     as-is (`ok: false` data, not an error).
  4. On redirect: `await res.body?.cancel()` (frees the connection — verified redirect
     bodies are real and readable, so they must be explicitly discarded), push `current`
     onto `redirects[]`, resolve `next = new URL(location, current).href`. A Location
     that fails `new URL()` → treat the 3xx as the final response and `logger?.warn`
     (data-preserving for crawlers; browsers error here — documented choice).
  5. Loop/cap: if `hop === maxRedirects` (default 5) or the `"METHOD next"` key was
     already visited → throw `PageFetchError` `kind: "too-many-redirects"`,
     `retryable: false`, with the accumulated chain on the error.
  6. Method rewrite (mirrors the WHATWG fetch algorithm):
     - `303` and method ≠ HEAD → method = GET, body dropped, `Content-Type` request
       header stripped.
     - `301`/`302` and method === POST → same rewrite to GET (spec-mandated for POST).
     - `307`/`308` → method and body preserved. If the body is a one-shot
       `ReadableStream`, replay is impossible → throw `kind: "network"`,
       `retryable: false`, message naming the real cause ("non-replayable body on 307
       redirect"). See open question 4; also flagged to doc 01 that a dedicated
       request-shape kind may be worth adding to the `kind` union.
  7. Credential hygiene: before each hop where `new URL(next).origin !==
     new URL(req.url).origin`, delete `authorization` AND `cookie` from the outgoing
     headers (compare every hop against the ORIGINAL origin; once dropped, stays
     dropped). DESIGN §7 names only Authorization; a caller-set Cookie header carries
     the same session-leak risk — same rule, `logger?.debug` when dropped.
  8. `finalUrl` = URL of the final (non-redirect) response; `redirects[]` excludes it
     (per §4 comment).
- **Affected files.** src/adapters/http.ts (all of it); tests/fixtures need a redirect
  chain + loop + cross-origin (dual-port) fixture per DESIGN §10.
- **Effort / Value / Risk.** M / high / low.
- **Implementation notes.** Keep the loop in http.ts rather than a shared module — the
  browser adapter delegates redirects to the browser and only reports the chain, so
  there is no second consumer. `headers` merge order per hop: adapter-level `headers` <
  request `headers` < loop-managed mutations (UA fill-in, credential drops, rewrite
  strips). Timing spans the whole chain (finding 7).

### 5. Timeout vs deadline: wrapper guards with typed abort reasons; `AbortSignal.any` verified

- **Problem / observation.** §7 requires per-attempt `timeout` and cross-attempt
  `deadline` as separate enforced concepts, and caller-signal propagation via
  `AbortSignal.any`. Two spec gaps: (a) _where_ each lives given retry re-invocation
  (resolved in finding 3: timeout below retry, deadline above), and (b) _how_ the catch
  side distinguishes "timeout" vs "deadline" vs "aborted" when all three surface as the
  same `AbortError` from the platform fetch.
- **Evidence.** `AbortSignal.any` is a function on Deno 2.9.5 and Node v26.7.0
  (verified; Node has it since 20.3 — floor satisfied). Reason propagation verified:
  `AbortSignal.any([...])` adopts the first-aborted source's custom abort reason.
  `AbortSignal.timeout` also exists on both. DESIGN §7 (Timeouts, Cancellation).
- **Proposed change.** `src/guards.ts`:
  ```ts
  export type FetchLayer = (next: FetchFn) => FetchFn;

  /** Per-attempt timeout; sits BELOW retry so it re-arms each attempt. Reads req.timeout. */
  export function timeoutGuard(
  	opts?: { defaultTimeout?: number; logger?: Logger },
  ): FetchLayer;

  /** Total deadline; sits ABOVE retry. Normalizes req.deadline (ms | Date) to absolute
   * epoch ms once per logical request and re-attaches it, so retry can budget sleeps. */
  export function deadlineGuard(
  	opts?: { defaultDeadline?: number; logger?: Logger },
  ): FetchLayer;

  /** Compose caller signal + guard-owned controllers into one signal. */
  export function composeSignal(
  	signals: (AbortSignal | undefined | null)[],
  ): AbortSignal; // thin, filtering wrapper over AbortSignal.any
  ```
  Discrimination protocol: each guard owns an `AbortController` armed with a plain
  `setTimeout`, and calls `controller.abort(reason)` with a **`PageFetchError` as the
  reason** (`kind: "timeout"` / `kind: "deadline"`, `retryable: true` / `false` per §6).
  The composed signal (via `AbortSignal.any`) adopts that reason (verified). On catch of
  the platform `AbortError`, inspect `composedSignal.reason`: `instanceof PageFetchError`
  → rethrow it; anything else → the caller's signal fired → `kind: "aborted"`,
  `retryable: false`.
  Cleanup rule: `clearTimeout` in a `finally` on every path. Do NOT use
  `AbortSignal.timeout()` for these — its timer cannot be canceled, so a completed fast
  attempt would keep the signal (and every `any()` listener attached to it) alive until
  the timer fires; with retries that accumulates. (Node/Deno document these timers as
  unref'ed — assumed, not load-bearing here since we avoid the API.)
- **Affected files.** src/guards.ts (new), src/adapters/http.ts (accepts the composed
  signal via `req.signal` only — the adapter itself implements NO timeout logic).
- **Effort / Value / Risk.** M / high / low.
- **Implementation notes.** `timeoutGuard` with no `req.timeout` and no `defaultTimeout`
  is a pass-through (zero cost). The deadline guard checks `Date.now() >= deadlineAt`
  _before_ calling next and fails fast with `kind: "deadline"` — this is what makes §6's
  "never sleep past the deadline" testable with fake timers (DESIGN §10). Retry-layer
  interplay (re-arming, sleep budgeting) is doc 03's to spec — pointer only.

### 6. Content-type policy — parse spec, a real gap in the default allow-list, `skip-body` semantics

- **Problem / observation.** §7's default list is `text/html, application/xhtml+xml,
  text/plain, application/xml, text/xml, +json`. Read literally as a suffix rule,
  **`+json` does not match plain `application/json`** (no `+` in its subtype) — the
  single most common JSON mime would be rejected by the defaults. Also unspecified:
  matching semantics, missing Content-Type header, and what `skip-body` returns.
- **Evidence.** DESIGN §7 (Content-type policy), §4 (`contentType` field: "parsed mime,
  lowercased, no params"). Verified the raw header keeps case and params, so parsing is
  mandatory.
- **Proposed change** (**Design gap:** defaults amended). `src/content-type.ts`:
  ```ts
  /** "TEXT/HTML; Charset=X; foo=bar" → { mime: "text/html", charset: "x" } */
  export function parseContentType(
  	header: string | null,
  ): { mime?: string; charset?: string };

  /** allow entries: exact mime ("text/html"), or "+suffix" matching subtypes ending
   * in that suffix ("+json" → "application/ld+json"). All lowercase. */
  export function isAllowedContentType(mime: string, allow: string[]): boolean;

  export const DEFAULT_ALLOW_CONTENT_TYPES: string[]; // §7 list + "application/json", "+xml"
  ```
  Policy behavior in the adapter (applied to the FINAL response only, after redirects;
  never applied to HEAD requests — there is no body to protect): missing Content-Type →
  allowed (cannot judge; charset sniffing still runs). Disallowed +
  `onUnsupportedType: "error"` (proposed default, open q. 3) → `res.body?.cancel()`,
  throw `kind: "unsupported-type"`, `retryable: false`. Disallowed + `"skip-body"` →
  `res.body?.cancel()`, resolve a normal `FetchResult` with headers/status intact,
  `size: undefined`, and `text()`/`bytes()` **rejecting** with the same
  `unsupported-type` error (explicit beats silently-empty; link checkers only read
  status/headers). `allowContentTypes: null` disables the check.
- **Affected files.** src/content-type.ts (new), src/adapters/http.ts.
- **Effort / Value / Risk.** S / med / low.
- **Implementation notes.** `FetchResult.contentType` is always the parsed lowercase
  mime regardless of policy outcome. The `+xml` addition keeps `application/rss+xml`
  and friends working out of the box — same rationale as `+json`.

### 7. `FetchTiming` honesty — §4 over-promises; adapter fills five fields, the rest stay undefined

- **Problem / observation.** §4 sketches `dns?` and `connect?` fields. Platform fetch
  exposes no per-phase network timing: verified `performance.getEntriesByType("resource")`
  is EMPTY after a completed fetch in Deno 2.9.5, and undici's fetch offers nothing
  equivalent without diagnostics_channel plumbing (out of scope for a zero-dep core).
  Shipping fields that are never populated is over-promising. Keep the optional fields
  (they cost nothing and the browser adapter may fill `render`), but document exactly
  who fills what.

  > **Cut from the draft:** a leaked reference to another reviewing agent's opinion —
  > plan docs carry conclusions, not inter-agent attribution.
- **Evidence.** Live Deno check (0 resource entries post-fetch). DESIGN §4
  (`FetchTiming`).
- **Proposed change.** The HTTP adapter fills, per logical adapter invocation (spanning
  the whole redirect chain):
  - `startedAt` — epoch ms at entry; `endedAt` — after body fully read (or skipped);
  - `total` = endedAt − startedAt;
  - `ttfb` = headers-received time of the FINAL response − startedAt (honest label:
    "time to final response headers", documented as such — platform fetch resolves when
    headers arrive, first body byte is not separately observable);
  - `download` = endedAt − that same headers-received timestamp.
  - `dns`, `connect`, `render`: never set by this adapter. JSDoc on the type (doc 01)
    must say "HTTP adapter: undefined".
- **Affected files.** src/adapters/http.ts; JSDoc in src/types.ts (pointer to doc 01).
- **Effort / Value / Risk.** S / med / low.
- **Implementation notes.** Retry aggregation of per-attempt timings is doc 03's
  concern; the adapter reports one attempt only.

### 8. Default User-Agent + header merge rules

- **Problem / observation.** §7 requires a descriptive, overridable default UA with a
  contact-URL note. Verified platform defaults are useless for polite crawling: Deno
  sends `User-Agent: Deno/2.9.5`, Node sends `User-Agent: node`.
- **Evidence.** Live localhost header echo on both runtimes. DESIGN §7 (Defaults).
- **Proposed change.** In src/adapters/http.ts:
  ```ts
  export const DEFAULT_USER_AGENT =
  	"marianmeres-page-fetcher (+https://github.com/marianmeres/page-fetcher)";
  ```
  Applied only when neither adapter-level `headers` nor request `headers` carry a
  `user-agent` (case-insensitive check — normalize via a `Headers` instance). Adapter
  option `userAgent?: string | false` — `false` leaves the platform UA untouched.
  README carries §7's "put a contact URL in it" note. No version number embedded in v1:
  a truthful version requires a generated constant synced by the release task (import
  attributes on deno.json are possible but add npmbuild risk) — owner call, open q. 2.
  Merge order (lowest to highest): `DEFAULT_USER_AGENT` fill-in < adapter `headers` <
  request `headers`; redirect-loop mutations (credential drops, rewrite strips) always
  win last.
- **Affected files.** src/adapters/http.ts.
- **Effort / Value / Risk.** S / med / low.

### 9. Logger (`@marianmeres/clog`) integration map — first-class, silent by default

- **Problem / observation.** User requirement (overrides doc silence): the clog `Logger`
  interface must be first-class in every factory, complementing §9 `FetcherEvents`.
  Verified: `Logger` at clog.ts:186–218 is `{ debug, log, warn, error }`, each
  `(...args: any[]) => any` — structurally satisfied by `console` and `createClog(ns)`.
  Local clog source is v3.21.0 (published to JSR).
- **Evidence.** /Users/mm/projects/@marianmeres/clog/src/clog.ts:186–218;
  /Users/mm/projects/@marianmeres/clog/deno.json (v3.21.0). User requirement in task
  brief.
- **Proposed change.** `import type { Logger } from "@marianmeres/clog";` (type-only —
  erased at runtime, zero-runtime-dep promise holds; add
  `"@marianmeres/clog": "jsr:@marianmeres/clog@^3.21.0"` to deno.json imports as a
  compile-time dep — accepted per brief). Every factory in this dimension takes
  `logger?: Logger`; default `undefined` = silent; every call site uses optional
  chaining (`logger?.debug(...)`) — no no-op logger object allocated. Level map for this
  dimension:
  - `debug`: redirect hop (`302 url → next`), charset resolution + which source won
    (bom/header/meta/fallback), Content-Length fast-fail trigger, credential-header
    drop on cross-origin hop, timeout/deadline arming;
  - `warn`: maxBytes exceeded, unknown charset label fallback, malformed Location
    treated as final, unsupported content-type in `skip-body` mode;
  - `error`/`log`: NEVER called by this dimension — errors are thrown to the caller,
    and logging them here too would double-log once the fetcher/events layer reports
    them. State this rule in the README's logging section.
- **Affected files.** src/adapters/http.ts, src/guards.ts, src/charset.ts (optional
  logger param on `decodeText`), deno.json (imports entry).
- **Effort / Value / Risk.** S / med / low.
- **Implementation notes.** Namespacing is the caller's job (`createClog("pf:http")`);
  the package never creates clog instances — it only accepts the interface. Do not
  thread the logger through `FetchRequest`; it is factory-level configuration.

### 10. Cookie jar — confirm "leave out of v1" (DESIGN §11.3)

- **Problem / observation.** §5.1 lists "cookie jar: optional, injected, off by
  default"; §11.3 already leans "leave out of v1, accept a cookies header/callback".
- **Evidence.** DESIGN §5.1, §11.3.
- **Proposed change.** Confirmed — no jar code in v1, not even an interface stub
  (designing a jar interface without a consumer risks locking in a wrong shape; the
  crawler will reveal the real requirements). A caller-supplied `cookie` request header
  passes through untouched, with two documented behaviors: (a) it is dropped on
  cross-origin redirect hops exactly like `Authorization` (finding 4.7); (b) `Set-Cookie`
  response headers are exposed as-is in `FetchResult.headers` — note the platform
  caveat that `Headers.getSetCookie()` is the reliable accessor for multiple
  `Set-Cookie` values (verified: a function on both Deno 2.9.5 and Node v26.7.0).
  Skip the "callback" half of §11.3 for v1 as well — it is a jar in disguise.
- **Affected files.** src/adapters/http.ts (only the redirect drop rule); README.
- **Effort / Value / Risk.** S / med / low — this is scope kept OUT, the value is not
  building the wrong thing.

### Soundness notes (no change proposed)

- §5.1 "thin wrapper over platform fetch" with DI (`fetch?: typeof globalThis.fetch` in
  `HttpAdapterOptions`) is sound and makes the whole dimension testable without any
  network per DESIGN §10 — the fixture server can still be localhost, but unit tests
  can stub fetch entirely.
- §4's non-2xx-resolves-with-`ok:false` decision is right for the crawler use case;
  `throwOnHttpError` belongs in the composition layer (a trivial wrapper), not in this
  adapter — one-line pointer to the createFetcher dimension doc.
- §11.2 (defer HTTP/2 / keep-alive tuning to the platform) — agreed, nothing to build.

## Open questions / decisions needed

1. Charset precedence — approve the **BOM-above-HTTP-header deviation** (WHATWG/browser
   order, finding 2), or keep DESIGN §7's header-first order?
2. Default User-Agent — exact contact URL (repo URL vs a marianmeres.sk page), and
   should it embed the package version (requires a generated version constant kept in
   sync by the release task) or stay version-less (recommended for v1)?
3. `onUnsupportedType` default — `"error"` (recommended: loud beats silent for a
   transport primitive) or `"skip-body"`?
4. Non-replayable POST bodies (`ReadableStream`) — reject up-front at request
   validation, or fail only when a 307/308 redirect actually requires a replay
   (recommended)? Related doc-01 question: add a dedicated request-shape error `kind`,
   or reuse `"network"` with a clear message?

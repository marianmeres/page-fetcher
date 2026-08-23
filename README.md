# @marianmeres/page-fetcher

[![NPM version](https://img.shields.io/npm/v/@marianmeres/page-fetcher.svg)](https://www.npmjs.com/package/@marianmeres/page-fetcher)
[![JSR version](https://jsr.io/badges/@marianmeres/page-fetcher)](https://jsr.io/@marianmeres/page-fetcher)
[![License](https://img.shields.io/npm/l/@marianmeres/page-fetcher)](LICENSE)

Fetch **one** web page by URL and get a normalized result, whether the bytes came from a
headless browser or a plain `fetch`.

This is a transport primitive. It knows nothing about links, recursion, sites or
crawling — a crawler sits on top of it. What it does know is the boring, load-bearing
part: redirect chains, byte budgets, charset detection, per-attempt timeouts vs. total
deadlines, retries that respect `Retry-After`, and a headless browser that gets torn
down even when you Ctrl-C.

- **One result shape**, whatever produced it. Swapping `fetch` for a real browser does
  not change a line of downstream code.
- **Every layer is a function** — `(next: FetchFn) => FetchFn`. No classes, no plugin
  registry. `createFetcher` is one `compose()` call; hand-roll the stack when you like.
- **A non-2xx response is data**, not an exception (see below).
- **Zero runtime dependencies.** The browser driver is yours to install and inject.

## Installation

```bash
deno add jsr:@marianmeres/page-fetcher
```

```bash
npx jsr add @marianmeres/page-fetcher
```

```bash
npm i @marianmeres/page-fetcher
```

> **The browser driver is never installed with this package.** Playwright and Puppeteer
> are neither dependencies nor peer dependencies here — installing page-fetcher never
> pulls down a browser binary. If you want the browser adapter, install one of them
> yourself and hand it in (see [below](#fetching-with-a-real-browser)). HTTP-only usage
> needs nothing else.

## Quick start

```ts
import { createFetcher } from "@marianmeres/page-fetcher";

// `await using` disposes the fetcher (and its adapters) at the end of the scope
await using fetcher = createFetcher({ timeout: 10_000, retry: { attempts: 3 } });

const res = await fetcher.fetch("https://example.com/");

console.log(res.status, res.ok, res.contentType, res.charset);
console.log(res.finalUrl); // resolve relative references against THIS, not `res.url`
console.log((await res.text()).length);
```

`fetch()` also takes a full request object — `fetcher.fetch({ url, method: "HEAD" })`,
`{ url, adapter: "browser" }`, `{ url, retainBody: false }` (link-check mode: headers
only, no bytes moved), `{ url, meta: { depth: 2 } }` (echoed back on the result).

### A non-2xx response is not an error

A 404 or a 503 **resolves** with `ok: false`. Crawlers need those as data, and wrapping
them in exceptions means writing `try`/`catch` around the normal case:

```ts
const res = await fetcher.fetch("https://example.com/missing");
if (!res.ok) console.warn(`${res.status} at ${res.finalUrl}`); // no throw
```

Opt into the other behavior with `createFetcher({ throwOnHttpError: true })`. The throw
is a `PageFetchError` with `kind: "http"` carrying the whole result on `details.result`,
so nothing is lost.

Everything this package _does_ throw is a `PageFetchError`, discriminated by `kind` —
never branch on a message:

```ts
import { PageFetchError } from "@marianmeres/page-fetcher";

try {
	await fetcher.fetch("https://example.com/");
} catch (e) {
	if (!PageFetchError.is(e)) throw e; // realm-safe; prefer it over `instanceof`
	if (e.kind === "circuit-open") console.warn(`host fenced off: ${e.url}`);
	else if (e.retryable) console.warn(`try again later: ${e.url}`);
	else console.error(`${e.kind}: ${e.message}`);
}
```

The full kind table is in [API.md](API.md#pagefetcherrorkind).

## Try it: the interactive example

```bash
git clone https://github.com/marianmeres/page-fetcher && cd page-fetcher
deno task example        # → http://127.0.0.1:8000
```

A control panel for one fetch. Pick a deliberately misbehaving page — a three-hop
redirect chain, a redirect loop, a 503, a flaky endpoint that fails twice, a `429` with
`Retry-After: 2`, a slow page, a 5 MB body, a windows-1250 page, an ETag'd page, an
image — or paste any URL, set the options, and watch what comes back: the recorded
redirect chain, the attempts actually made, the resolved charset, the timings, the cache
verdict, and every event the layer stack emitted, in order.

The fetch runs in the example's own Deno server rather than in the page, because a
browser cannot demo this honestly: CORS blocks cross-origin fetches, and
`redirect: "manual"` yields an _opaque_ response there — so the redirect chain would
always come back empty. See [example/README.md](example/README.md).

## Fetching with a real browser

Install a driver yourself, then inject it. The adapter imports neither package — the
driver interface is structural, so your own implementation works just as well.

```ts
import * as playwright from "playwright";
import { createFetcher } from "@marianmeres/page-fetcher";
import {
	createBrowserAdapter,
	playwrightDriver,
} from "@marianmeres/page-fetcher/adapters";

await using fetcher = createFetcher({
	adapters: createBrowserAdapter({ driver: playwrightDriver(playwright) }),
});

const res = await fetcher.fetch("https://example.com/");
console.log(res.extra?.title, (await res.text()).length);
```

Puppeteer is the same shape: `puppeteerDriver(puppeteer)`. Both bridges are tested
against a real browser; chromium is the engine we test on.

> **Images, media, fonts and stylesheets are blocked by default.** A page fetcher wants
> the DOM, not the pixels, and dropping those removes the large majority of a typical
> page's requests and bytes. This is a real behavior change, not a free optimization: a
> script that measures layout or reads computed styles can take a different branch
> without its stylesheets. Pass `blockResources: false` for full fidelity, or a custom
> list of [resource kinds](API.md#resourcekind).

Two more things the browser adapter does differently, on purpose:

- **`bytes()` is the serialized DOM, not the wire bytes** — by the time we see it the
  document has been parsed, scripted and re-serialized, so `charset` is always `utf-8`.
- **No `User-Agent` is set by default** (the opposite of the HTTP adapter). Replacing a
  real browser's UA with a bot string is what gets you served different HTML. Set
  `userAgent` when politeness matters more than fidelity.

### Disposal is not optional

`dispose()` closes the contexts and kills the browser. Orphaned Chromium processes are
the classic failure of tools like this, so: use `await using`, or a `try`/`finally`, and
let the built-in process-exit hook (on by default, `exitHooks: false` to opt out) cover
the Ctrl-C case.

By default the adapter runs a pool of 3 browsing contexts over one browser process,
recycling each after 50 pages, and relaunching after a crash. Tune with
`contextStrategy` (`"pooled"` / `"shared"` / `"per-request"`), `poolSize`,
`maxPagesPerContext`, `acquireTimeout`.

Waiting is per adapter and per request — `wait: "networkidle"` (the default: load, then
a bounded wait for quiet, then proceed anyway), `"load"`, `"domcontentloaded"`,
`{ selector: "#app .ready" }` or `{ fn: "document.title === 'ready'" }`:

```ts
await fetcher.fetch({
	url: "https://example.com/app",
	adapterOptions: { wait: { selector: "#results .item" } },
});
```

## Recipe: routing between adapters

`createFetcher` takes several adapters. The first is the default route, the rest are
reachable by name — explicitly per request, or through `selectAdapter`:

```ts
import { createFetcher } from "@marianmeres/page-fetcher";
import {
	createBrowserAdapter,
	createHttpAdapter,
} from "@marianmeres/page-fetcher/adapters";
import type { BrowserDriver } from "@marianmeres/page-fetcher/adapters";

declare const driver: BrowserDriver;

await using fetcher = createFetcher({
	adapters: [createHttpAdapter(), createBrowserAdapter({ driver })],
	// cheap by default, browser only where it is known to be needed
	selectAdapter: (req) => /\/app\/|\/dashboard\//.test(req.url) ? "browser" : undefined,
});
```

The other flavor is escalation: fetch cheaply, look at what came back, and re-fetch the
handful of pages that need JavaScript.

```ts
const res = await fetcher.fetch(url);
const html = res.ok && res.contentType === "text/html" ? await res.text() : "";

// crude but effective: markup that carries no text but plenty of script
const looksJsRendered = html.length > 0 &&
	html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, "").trim()
			.length < 200;

const final = looksJsRendered ? await fetcher.fetch({ url, adapter: "browser" }) : res;
```

## Recipe: caching

Off unless you hand it a store. Two modes through one interface:

| Mode                        | Behavior                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| `"dev"`                     | Serve any hit, ignore freshness. Crawl once, iterate on extraction a hundred times.         |
| `"conditional"` _(default)_ | Revalidate with `If-None-Match` / `If-Modified-Since`; a 304 resolves into the stored body. |

```ts
import { createFetcher } from "@marianmeres/page-fetcher";
import { createMemoryCache } from "@marianmeres/page-fetcher/cache";

await using fetcher = createFetcher({
	cache: { store: createMemoryCache({ maxEntries: 500 }), mode: "dev", ttl: 3_600_000 },
});

const res = await fetcher.fetch("https://example.com/");
console.log(res.fromCache, res.notModified, res.attempts); // true false 0 on a hit
```

It is deliberately **not** an RFC 9111 cache: no `Cache-Control` freshness parsing, no
`Vary`, no `stale-while-revalidate`. `ttl` is your policy, not the origin's. Only GET is
cached.

### Backing the store yourself

`CacheStore` is three methods, and `serializeCachedEntry` / `deserializeCachedEntry`
handle the two traps of persisting one (`Headers` and `Uint8Array` both JSON-stringify
to garbage). A filesystem store, complete:

```ts
import {
	deserializeCachedEntry,
	serializeCachedEntry,
} from "@marianmeres/page-fetcher/cache";
import type { CacheStore } from "@marianmeres/page-fetcher/cache";

const dir = "./.cache";

async function base(key: string): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(key));
	const hex = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0"));
	return `${dir}/${hex.join("")}`;
}

const store: CacheStore = {
	async get(key) {
		try {
			const path = await base(key);
			const meta = await Deno.readTextFile(`${path}.json`);
			return deserializeCachedEntry(meta, await Deno.readFile(`${path}.bin`));
		} catch {
			return undefined; // a miss, a half-written pair, or an older entry version
		}
	},
	async set(key, entry) {
		const path = await base(key);
		const { meta, body } = serializeCachedEntry(entry);
		await Deno.mkdir(dir, { recursive: true });
		await Deno.writeFile(`${path}.bin`, body);
		await Deno.writeTextFile(`${path}.json`, meta); // metadata last: it is the marker
	},
	async delete(key) {
		const path = await base(key);
		await Deno.remove(`${path}.json`).catch(() => {});
		await Deno.remove(`${path}.bin`).catch(() => {});
	},
};
```

SQLite, Redis or S3 are the same three methods — a BLOB column or a second key for
`body`, the JSON string for `meta`. No dependency is taken here either way.

## Logging and events

Silent by default. `logger` is the human channel and takes anything console-shaped
(`console` itself, or `createClog("fetcher")` from `@marianmeres/clog`); `events` is the
machine channel, with defined granularity:

```ts
import { createFetcher } from "@marianmeres/page-fetcher";

await using fetcher = createFetcher({
	logger: console,
	events: {
		onRequest: (_req, i) => console.debug(`attempt ${i.attempt} [${i.requestId}]`),
		onRetry: (i) => console.warn(`retrying ${i.url} in ${Math.round(i.delay)} ms`),
		onResponse: (res) => console.info(`${res.status} ${res.finalUrl}`),
		onError: (err) => console.error(`${err.kind} ${err.url}`),
	},
});
```

For one logical request with N attempts: N × `onRequest`, (N−1) × `onRetry`, and exactly
one terminal event — `onResponse` **or** `onError`. Every event, result and error
carries the same `requestId`, so log lines correlate. A throwing handler never affects
the fetch.

The events layer sits below the cache and the circuit breaker, which is visible in two
places: a request answered from the cache emits nothing (count hits off
`res.fromCache`), and a request refused by an open circuit emits only `onCircuitOpen`.

## The default User-Agent

The HTTP adapter announces itself as
`marianmeres-page-fetcher (+https://github.com/marianmeres/page-fetcher)`. **Set your
own with a real contact address** when you run this against sites you do not own —
`createFetcher({ userAgent: "acme-crawler (+https://acme.test/bot)" })` — it is the
cheapest courtesy there is, and the first thing an annoyed sysadmin looks for.

## Composing your own stack

Nothing in `createFetcher` is privileged: every layer is exported and usable alone.

```ts
import {
	compose,
	createCircuitBreaker,
	createRetry,
	timeoutGuard,
} from "@marianmeres/page-fetcher";
import { createHttpAdapter } from "@marianmeres/page-fetcher/adapters";

// layers are listed outermost first, exactly as a stack diagram draws them
const fetchFn = compose(
	[
		createCircuitBreaker({ threshold: 3 }),
		createRetry({ attempts: 4 }),
		timeoutGuard(),
	],
	createHttpAdapter({ maxBytes: 2_000_000 }).fetch,
);
```

Placement is a contract, not a preference (the timeout guard belongs _below_ retry so it
re-arms per attempt; the deadline guard belongs _above_ it because it also bounds the
sleeps). [docs/architecture.md](docs/architecture.md) draws the whole stack and says why
each layer sits where it does.

## API

See [API.md](API.md) for the complete reference — every function, type and constant of
the three entry points (`.`, `./adapters`, `./cache`).

Further reading: [example/README.md](example/README.md) (the interactive example),
[docs/architecture.md](docs/architecture.md) (the layer stack and data
flow), [docs/design.md](docs/design.md) (the founding design document and the accepted
deviations from it), [AGENTS.md](AGENTS.md) (for AI agents working on this package).

## License

[MIT](LICENSE)

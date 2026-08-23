# The interactive example

A control panel for one fetch: pick a deliberately misbehaving page (or paste any URL),
set the options `createFetcher` takes, and watch the normalized result come back — the
redirect chain, the attempts made, the resolved charset, the timings, whether the cache
answered, and every event the layer stack emitted along the way.

```bash
deno task example        # → http://127.0.0.1:8000
```

The bundle is committed, so that is all you need. If you change `example/src/main.ts`:

```bash
deno task example:build  # one-shot bundle → example/dist/bundle.js
deno task example:dev    # the same, in watch mode (run the server in another shell)
deno task example:theme mauveTeal   # regenerate theme.css from another bundled palette
```

## Why the fetch runs on the server

The library would technically bundle for a browser, but a browser cannot demo it
honestly:

- cross-origin `fetch` is blocked by CORS, so only same-origin pages could be fetched;
- `redirect: "manual"` yields an **opaque** response there — no status, no `Location`
  header — so the redirect chain this package exists to record would always come back
  empty.

So the browser holds the controls and [`server.ts`](./server.ts) does the fetching,
where a real `fetch` behaves like a real `fetch`. It exposes:

| Route             | What it does                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `GET /`           | the app (`index.html` + `dist/bundle.js` + the two stylesheets)                                                              |
| `POST /api/fetch` | runs one fetch with the posted options, answers with the result **and** the events                                           |
| `POST /api/reset` | drops the cached responses, the breaker state and the demo counters                                                          |
| `ANY /demo/*`     | the demo pages — redirect chains, flaky 500s, 429 + `Retry-After`, a slow page, a 5 MB body, windows-1250, an ETag, an image |

> ⚠️ **Local demo only.** `/api/fetch` fetches whatever URL it is handed, and
> `/demo/big` will happily generate megabytes. It binds to `127.0.0.1` on purpose — do
> not deploy it anywhere reachable by anyone else.

## What each demo page is there to show

| Scenario               | The point                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| 200                    | the baseline result shape                                                                                   |
| 302 ×3                 | `redirects` records every hop; resolve links against `finalUrl`                                             |
| 302 loop               | `too-many-redirects`, detected by repetition, not retryable                                                 |
| 404                    | a non-2xx is data (`ok: false`) — tick _Throw on HTTP error_ for the other behavior                         |
| 503                    | retryable: every attempt burns, still resolves. Turn the breaker on and repeat                              |
| flaky (500, 500, 200)  | `attempts` is the real count; the events show the backoff sleeps                                            |
| 429 + `Retry-After: 2` | the sleep comes from the header, not the backoff curve                                                      |
| slow (3 s)             | per-attempt `timeout` re-arms; a `deadline` spans the sleeps too                                            |
| 5 MB body              | `maxBytes` enforced while reading → `too-large`                                                             |
| windows-1250 ×2        | charset from the header, and from a sniffed `<meta>`                                                        |
| ETag                   | `conditional` → 304 + stored body; `dev` → a hit with **no events** (the cache sits above the events layer) |
| image                  | `unsupported-type`, refused before the body is read                                                         |

## How it is built

- [`@marianmeres/vanilla`](https://jsr.io/@marianmeres/vanilla) — `observable` state,
  markup in `<template>`s (`fromTemplate` / `refs`), one delegated listener tree.
- [`@marianmeres/design-tokens`](https://jsr.io/@marianmeres/design-tokens) — `theme.css`
  is generated (`deno task example:theme`) with the Bootstrap Reboot bridge that
  `reboot.css` consumes. Light/dark follows `:root.dark`.
- [`@marianmeres/deno-build`](https://jsr.io/@marianmeres/deno-build) — bundles
  `src/main.ts` into `dist/bundle.js`; no node_modules, no build config.

`src/version.generated.ts` is generated too (gitignored) — `deno task example:build`
writes it before bundling.

/// <reference no-default-lib="true" />
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/// <reference lib="esnext" />
/**
 * Example app for `@marianmeres/page-fetcher`.
 *
 * A control panel for one fetch: pick a deliberately misbehaving demo page (or paste
 * any URL), set the options `createFetcher` takes, and see the normalized result — the
 * redirect chain, the attempts made, the resolved charset, the timings, whether the
 * cache answered, and the events the layer stack emitted along the way.
 *
 * The fetch itself runs in `example/server.ts`, not here: a browser cannot demo this
 * package honestly (CORS blocks cross-origin fetches, and `redirect: "manual"` yields
 * an opaque response, so the recorded redirect chain would always be empty). So this
 * file is pure UI — it posts the options to `/api/fetch` and renders what comes back.
 *
 * Built with `@marianmeres/vanilla`: explicit reactive state (`observable`), markup in
 * `<template>`s (`fromTemplate` / `refs`), one delegated listener tree (`delegate`).
 *
 * This is browser code: the triple-slash lib references above type it against the DOM
 * (the repo's `deno.json` targets the Deno runtime for the library itself).
 *
 * Bundle with: `deno task example:build` (→ `example/dist/bundle.js`).
 */
import {
	createView,
	delegate,
	fromTemplate,
	observable,
	refs,
} from "@marianmeres/vanilla";
import { VERSION } from "./version.generated.ts";

/* ---- Config --------------------------------------------------------------- */

/** Must match the literal in the anti-FOUC inline script in index.html. */
const THEME_KEY = "page-fetcher-example-theme";

/** Options posted to `/api/fetch` — the subset of the library's knobs this demo drives. */
interface Options {
	url: string;
	method: "GET" | "HEAD";
	attempts: number;
	timeout: number | null;
	deadline: number | null;
	maxBytes: number;
	cache: "off" | "conditional" | "dev";
	retainBody: boolean;
	circuitBreaker: boolean;
	throwOnHttpError: boolean;
}

/** One entry of the "Demo page" picker. */
interface Scenario {
	id: string;
	label: string;
	/** Relative URL on this server; empty for the free-form entry. */
	path: string;
	/** What to watch for once it has run. */
	hint: string;
	/** Stateful route — needs a fresh token per run to replay from the start. */
	fresh?: boolean;
	/** Option overrides that make the point of this scenario visible. */
	apply?: Partial<Options>;
}

const SCENARIOS: Scenario[] = [
	{
		id: "ok",
		label: "200 — an ordinary page",
		path: "/demo/ok",
		hint:
			"The baseline. One attempt, no redirects, charset from the Content-Type header.",
	},
	{
		id: "redirect",
		label: "302 ×3 — a redirect chain",
		path: "/demo/redirect/3",
		hint:
			"Redirects are followed manually so the chain is recordable: `redirects` lists every hop that answered 3xx, `finalUrl` is where you landed. Resolve relative links against finalUrl, not url.",
	},
	{
		id: "redirect-loop",
		label: "302 ↔ 302 — a redirect loop",
		path: "/demo/redirect-loop",
		hint:
			"A repeated URL is detected before the cap is reached — throws `too-many-redirects`, which is deliberately NOT retryable.",
	},
	{
		id: "404",
		label: "404 — a missing page",
		path: "/demo/status/404",
		hint:
			"A non-2xx resolves with ok:false — it is data, not an exception. Tick “Throw on HTTP error” to get the other behavior (a `http` error carrying the whole result).",
	},
	{
		id: "503",
		label: "503 — a server error, retried",
		path: "/demo/status/503",
		hint:
			"5xx is retryable, so the retry layer burns every attempt (watch the events) and still resolves with ok:false. Turn on the circuit breaker and fetch a few times: the host gets fenced off.",
		apply: { attempts: 3 },
	},
	{
		id: "flaky",
		label: "500, 500, 200 — flaky, then fine",
		path: "/demo/flaky?fails=2",
		fresh: true,
		hint:
			"Fails twice, then succeeds. `attempts` on the result is the real count; the events show the exponential backoff sleeps between them.",
		apply: { attempts: 3 },
	},
	{
		id: "rate-limited",
		label: "429 + Retry-After: 2",
		path: "/demo/rate-limited?fails=1&after=2",
		fresh: true,
		hint:
			"The retry sleep comes from the Retry-After header (2 s), not from the backoff curve. Set a 1000 ms deadline to watch the deadline win instead.",
		apply: { attempts: 3 },
	},
	{
		id: "slow",
		label: "A slow page (3 s)",
		path: "/demo/slow?ms=3000",
		hint:
			"With a 1000 ms per-attempt timeout every attempt is cut short and re-armed; a total deadline instead spans every attempt AND the sleeps between them.",
		apply: { timeout: 1000, attempts: 2 },
	},
	{
		id: "big",
		label: "A 5 MB body",
		path: "/demo/big?bytes=5000000",
		hint:
			"Streamed with no Content-Length, so the budget is enforced while reading: throws `too-large` the moment maxBytes is passed. Raise maxBytes above 5 MB to let it through.",
		apply: { maxBytes: 1_000_000 },
	},
	{
		id: "cp1250",
		label: "windows-1250, declared in the header",
		path: "/demo/cp1250",
		hint:
			"charset comes from Content-Type and the bytes are decoded with it — the Czech diacritics come out intact.",
	},
	{
		id: "cp1250-meta",
		label: "windows-1250, only in <meta>",
		path: "/demo/cp1250-meta",
		hint:
			"No charset in the header. The first ~2 KB are sniffed for a <meta charset>, which wins over the utf-8 fallback.",
	},
	{
		id: "etag",
		label: "An ETag'd page (cache)",
		path: "/demo/etag",
		hint:
			"Fetch twice. In `conditional` mode the second request revalidates and the origin answers 304 — you get notModified with the stored body. In `dev` mode the second fetch never leaves the process (fromCache, and no events at all: the cache sits above the events layer).",
		apply: { cache: "conditional" },
	},
	{
		id: "image",
		label: "An image (unsupported type)",
		path: "/demo/image",
		hint:
			"image/gif is not in the adapter's allow list, so the body is refused before it is read: `unsupported-type`, not retryable.",
	},
	{
		id: "custom",
		label: "Any URL you like…",
		path: "",
		hint:
			"Type an absolute http(s) URL. It is fetched by the local Deno server, so no CORS is involved — but it does leave your machine.",
	},
];

/* ---- State ---------------------------------------------------------------- */

/** The last outcome: whatever `/api/fetch` answered, plus a transport-level failure. */
type Outcome =
	| { kind: "idle" }
	| { kind: "busy" }
	| { kind: "done"; data: ApiResponse }
	| { kind: "failed"; message: string };

interface ApiEvent {
	at: number;
	type: string;
	text: string;
}

interface ApiResult {
	ok: boolean;
	status: number;
	statusText: string;
	url: string;
	finalUrl: string;
	redirects: string[];
	contentType: string | null;
	charset: string | null;
	size: number | null;
	hasBody: boolean;
	fromCache: boolean;
	notModified: boolean;
	attempts: number;
	adapter: string;
	requestId: string;
	timing: { total: number; ttfb?: number; download?: number };
	headers: [string, string][];
	bodyPreview: string | null;
	bodyTruncated: boolean;
}

interface ApiError {
	kind: string;
	message: string;
	status: number | null;
	url: string;
	finalUrl: string | null;
	attempts: number;
	retryable: boolean;
	details: Record<string, unknown> | null;
	result: ApiResult | null;
}

interface ApiResponse {
	result?: ApiResult;
	error?: ApiError;
	events?: ApiEvent[];
}

const outcome = observable<Outcome>({ kind: "idle" });

/* ---- Theme (page-level, class-based: matches the design-tokens `.dark`) ----
 * The class is set pre-paint by the inline script in index.html; this keeps it
 * and the browser chrome color (<meta name="theme-color">) in sync afterwards. */

const prefersDark = (): boolean =>
	globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;

const applyTheme = (dark: boolean): void => {
	const root = document.documentElement;
	root.classList.toggle("dark", dark);
	const bg = getComputedStyle(root).getPropertyValue("--stuic-color-background").trim();
	if (bg) {
		document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg);
	}
};

let isDark = (() => {
	const stored = localStorage.getItem(THEME_KEY);
	return stored ? stored === "dark" : prefersDark();
})();
applyTheme(isDark);

const toggleTheme = (): void => {
	isDark = !isDark;
	applyTheme(isDark);
	localStorage.setItem(THEME_KEY, isDark ? "dark" : "light");
};

/* ---- Utils ---------------------------------------------------------------- */

const nf = new Intl.NumberFormat();

const bytes = (n: number): string =>
	n < 1024
		? `${n} B`
		: n < 1024 * 1024
		? `${(n / 1024).toFixed(1)} KB`
		: `${(n / 1024 / 1024).toFixed(2)} MB`;

const ms = (n: number): string => `${nf.format(Math.round(n))} ms`;

/** A `<dt>/<dd>` pair appended to a `dl.kv`. */
function appendKv(list: HTMLElement, k: string, v: string): void {
	const row = fromTemplate("tpl-kv");
	const r = refs(row);
	r.k.textContent = k;
	r.v.textContent = v;
	list.appendChild(row);
}

/** Absolute URL for a demo path, with a per-run token where the route is stateful. */
function scenarioUrl(s: Scenario): string {
	if (!s.path) return "";
	const url = new URL(s.path, location.href);
	if (s.fresh) url.searchParams.set("token", Math.random().toString(36).slice(2, 10));
	return url.href;
}

/* ---- View ----------------------------------------------------------------- */

const app = createView((track) => {
	const el = fromTemplate("tpl-app");
	const r = refs(el);

	const form = r.form as HTMLFormElement;
	const scenarioSel = r.scenario as HTMLSelectElement;
	const urlInput = r.url as HTMLInputElement;
	const fetchBtn = r.fetchBtn as HTMLButtonElement;

	/* -- the scenario picker -- */

	for (const s of SCENARIOS) {
		const opt = document.createElement("option");
		opt.value = s.id;
		opt.textContent = s.label;
		scenarioSel.appendChild(opt);
	}

	const current = (): Scenario =>
		SCENARIOS.find((s) => s.id === scenarioSel.value) ?? SCENARIOS[0];

	/** Push a scenario's suggested options into the form, so the knob that matters shows. */
	const applyScenario = (s: Scenario): void => {
		r.hint.textContent = s.hint;
		urlInput.value = s.path ? new URL(s.path, location.href).href : "";
		// reset to the defaults first — leftovers from the previous pick confuse
		const defaults: Partial<Options> = {
			method: "GET",
			attempts: 3,
			timeout: null,
			deadline: null,
			maxBytes: 1_000_000,
			cache: "off",
		};
		const opts = { ...defaults, ...s.apply };
		(r.method as HTMLSelectElement).value = opts.method!;
		(r.attempts as HTMLInputElement).value = String(opts.attempts);
		(r.timeout as HTMLInputElement).value = opts.timeout == null
			? ""
			: String(opts.timeout);
		(r.deadline as HTMLInputElement).value = opts.deadline == null
			? ""
			: String(opts.deadline);
		(r.maxBytes as HTMLInputElement).value = String(opts.maxBytes);
		(r.cache as HTMLSelectElement).value = opts.cache!;
	};

	/** Read the form. Empty numeric fields mean "unset", not zero. */
	const readOptions = (): Options => {
		const num = (name: string): number | null => {
			const raw = (r[name] as HTMLInputElement).value.trim();
			return raw === "" ? null : Number(raw);
		};
		const s = current();
		// the URL box wins unless it still holds the (untouched) scenario URL
		const typed = urlInput.value.trim();
		const url = s.path && typed === new URL(s.path, location.href).href
			? scenarioUrl(s)
			: typed;
		return {
			url,
			method: (r.method as HTMLSelectElement).value as "GET" | "HEAD",
			attempts: num("attempts") ?? 3,
			timeout: num("timeout"),
			deadline: num("deadline"),
			maxBytes: num("maxBytes") ?? 1_000_000,
			cache: (r.cache as HTMLSelectElement).value as Options["cache"],
			retainBody: (r.retainBody as HTMLInputElement).checked,
			circuitBreaker: (r.circuitBreaker as HTMLInputElement).checked,
			throwOnHttpError: (r.throwOnHttpError as HTMLInputElement).checked,
		};
	};

	/* -- rendering -- */

	const renderEvents = (list: HTMLElement, events: ApiEvent[]): void => {
		const frag = document.createDocumentFragment();
		for (const ev of events) {
			const li = fromTemplate("tpl-event");
			li.classList.add(`ev-${ev.type}`);
			const lr = refs(li);
			lr.at.textContent = `${ev.at} ms`;
			lr.type.textContent = ev.type;
			lr.text.textContent = ev.text;
			frag.appendChild(li);
		}
		list.replaceChildren(frag);
	};

	const renderResult = (res: ApiResult, events: ApiEvent[]): HTMLElement => {
		const node = fromTemplate("tpl-result");
		const q = refs(node);

		q.status.textContent = String(res.status);
		q.statusText.textContent = res.statusText;
		q.okBadge.textContent = res.ok ? "ok" : "not ok";
		q.okBadge.classList.add(res.ok ? "badge-ok" : "badge-bad");
		q.attemptsBadge.textContent = `${res.attempts} attempt${
			res.attempts === 1 ? "" : "s"
		}`;

		if (res.fromCache || res.notModified) {
			q.cacheBadge.hidden = false;
			q.cacheBadge.textContent = res.notModified
				? "304 → stored body"
				: "from cache";
			q.cacheBadge.classList.add("badge-warn");
		}

		q.finalUrl.textContent = res.finalUrl;
		q.redirectsLabel.textContent = `redirects (${res.redirects.length})`;
		q.redirects.textContent = res.redirects.length ? res.redirects.join("\n→ ") : "—";
		q.contentType.textContent = res.contentType ?? "—";
		q.charset.textContent = res.charset ?? "—";
		q.size.textContent = res.hasBody
			? (res.size == null ? "retained" : bytes(res.size))
			: "not retained";
		q.timing.textContent = [
			`total ${ms(res.timing.total)}`,
			res.timing.ttfb != null ? `ttfb ${ms(res.timing.ttfb)}` : null,
			res.timing.download != null ? `download ${ms(res.timing.download)}` : null,
		].filter(Boolean).join(" · ");
		q.adapter.textContent = res.adapter;
		q.requestId.textContent = res.requestId;

		q.eventsCount.textContent = events.length
			? String(events.length)
			: "none — the cache answered above the events layer";
		renderEvents(q.events, events);

		const headers = q.headers;
		headers.replaceChildren();
		for (const [k, v] of res.headers) appendKv(headers, k, v);

		if (res.bodyPreview == null) {
			q.bodyWrap.hidden = true;
		} else {
			q.bodyNote.textContent = res.bodyTruncated ? "(first 4000 chars)" : "";
			q.body.textContent = res.bodyPreview;
		}
		return node;
	};

	const renderError = (err: ApiError): HTMLElement => {
		const node = fromTemplate("tpl-error");
		const q = refs(node);
		q.kind.textContent = err.kind;
		q.message.textContent = err.message;
		q.retryable.textContent = err.retryable ? "retryable" : "not retryable";
		if (err.retryable) q.retryable.classList.add("badge-warn");
		q.attempts.textContent = `${err.attempts} attempt${
			err.attempts === 1 ? "" : "s"
		}`;

		if (err.status != null) appendKv(q.details, "status", String(err.status));
		appendKv(q.details, "url", err.url);
		if (err.finalUrl) appendKv(q.details, "finalUrl", err.finalUrl);
		for (const [k, v] of Object.entries(err.details ?? {})) {
			if (k === "result") continue; // rendered as a result card of its own
			// `until` (circuit-open) is an epoch — a wall clock is what you want to read
			const shown = k === "until" && typeof v === "number"
				? new Date(v).toLocaleTimeString()
				: typeof v === "string"
				? v
				: JSON.stringify(v);
			appendKv(q.details, k, shown);
		}
		return node;
	};

	const renderOutcome = (o: Outcome): void => {
		const body = r.outcomeBody;
		const show = o.kind !== "idle";
		r.placeholder.hidden = show;
		body.hidden = !show;
		if (!show) return;

		if (o.kind === "busy") {
			body.replaceChildren(text("p", "placeholder", "Fetching…"));
			return;
		}
		if (o.kind === "failed") {
			body.replaceChildren(text("p", "placeholder", o.message));
			return;
		}

		const { data } = o;
		const events = data.events ?? [];
		const frag = document.createDocumentFragment();
		if (data.error) {
			frag.appendChild(renderError(data.error));
			// `throwOnHttpError` keeps the whole result on the error — show it too
			if (data.error.result) {
				const node = renderResult(data.error.result, events);
				node.classList.add("stacked");
				frag.appendChild(node);
			} else if (events.length) {
				const wrap = fromTemplate("tpl-events");
				const q = refs(wrap);
				q.eventsCount.textContent = String(events.length);
				renderEvents(q.events, events);
				frag.appendChild(wrap);
			}
		} else if (data.result) {
			frag.appendChild(renderResult(data.result, events));
		}
		body.replaceChildren(frag);
	};

	/* -- actions -- */

	const run = async (): Promise<void> => {
		const options = readOptions();
		if (!options.url) {
			outcome.set({ kind: "failed", message: "Enter a URL first." });
			return;
		}
		outcome.set({ kind: "busy" });
		fetchBtn.disabled = true;
		try {
			const res = await fetch("/api/fetch", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(options),
			});
			outcome.set({ kind: "done", data: await res.json() as ApiResponse });
		} catch (e) {
			outcome.set({
				kind: "failed",
				message: `The example server did not answer: ${e}`,
			});
		} finally {
			fetchBtn.disabled = false;
		}
	};

	const reset = async (): Promise<void> => {
		await fetch("/api/reset", { method: "POST" }).catch(() => {});
		outcome.set({ kind: "idle" });
	};

	track(outcome.subscribe(renderOutcome));

	// One delegated listener tree for the whole view (events bubble to `el`).
	track(delegate(el, {
		submit: (e) => {
			e.preventDefault();
			void run();
		},
		reset: () => void reset(),
		pickScenario: () => applyScenario(current()),
		editUrl: () => {
			// typing a URL of your own is implicitly the free-form scenario
			const s = current();
			if (s.path && urlInput.value.trim() !== new URL(s.path, location.href).href) {
				scenarioSel.value = "custom";
				r.hint.textContent = SCENARIOS[SCENARIOS.length - 1].hint;
			}
		},
		toggleTheme: () => toggleTheme(),
	}));

	applyScenario(SCENARIOS[0]);
	form.setAttribute("novalidate", "");
	r.version.textContent = `· v${VERSION}`;

	return { el };
});

/** Tiny helper for the one-off placeholder paragraphs. */
function text(tag: string, className: string, content: string): HTMLElement {
	const node = document.createElement(tag);
	node.className = className;
	node.textContent = content;
	return node;
}

document.getElementById("app")!.appendChild(app.el!);

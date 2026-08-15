// ==== dsh prompt-guard — client bundle factory body ====
// Single source of truth for the browser half. scripts/build-client.js wraps
// this body into the dsh client-bundle format and writes lib/client.js.
//
// Permission/approval and multiselect prompts render from the session's
// "pending waits". The app clears those pending waits on connection resets
// (mobile networks, browser backgrounding, flaky connections on desktop) and
// relies on a host replay to restore them — which does not always happen.
//
// This plugin watches the composer chain for a pending prompt card. If a card
// disappears without the user having interacted with it (Allow/Reject/options/
// submit/cancel), it first asks the host for the still-pending wait and
// re-renders the prompt itself as a persistent interactive card that stays
// until the user answers it — no page reload needed. Only when the host has
// no pending wait left (e.g. the server restarted) does a banner offer the
// one-tap page reload as the fallback restore path.
//
// Additionally, when a pending prompt appears — and when one is lost — the
// plugin can raise a **browser notification** (Web Notifications API) so you
// notice while the tab is in the background or another window has focus.
// Permission is requested on page load (and retried on the first
// click/keypress when a browser defers the load-time prompt).
//
// Unlike the mobile-only plugin it was extracted from, this one is
// viewport-agnostic: the disappearance happens on desktop too.

var module = { exports: {} };
var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let react = require("react");
let react_jsx_runtime = require("react/jsx-runtime");

//#region dsh-plugin-prompt-guard:core
/** Pending-prompt cards in the composer chain (approval, question, plan review). */
const CARD_SELECTOR = "[data-approval-key], [data-question-key], [data-plan-review-key]";
/** Width below which the banner drops below the mobile top bar. */
const NARROW_BREAKPOINT = 768;

// ── system notifications ────────────────────────────────────────────────
/** Set to false to disable browser notifications entirely. */
const NOTIFY_ENABLED = true;
/** Only notify while the page is not focused (tab hidden or another window). */
const NOTIFY_ONLY_WHEN_UNFOCUSED = true;
/** Max prompt-text characters included in a notification body. */
const NOTIFY_BODY_MAX = 140;

// ── host probe (restore-in-place) ───────────────────────────────────────
/** How long the guard listens on a probe mux for the replayed pending waits. */
const PROBE_WINDOW_MS = 4000;
/** Max pending-wait restore cards rendered at once (safety cap). */
const MAX_RESTORE_CARDS = 5;

/** The pending-key of a card, from whichever data-* attribute it carries. */
function cardId(card) {
	return card.getAttribute("data-approval-key") ?? card.getAttribute("data-question-key") ?? card.getAttribute("data-plan-review-key");
}
/** Whether this browser exposes the Web Notifications API at all. */
function notificationsSupported() {
	return typeof window !== "undefined" && "Notification" in window;
}
/**
 * Ask for notification permission on page load when the browser has no verdict
 * yet, and keep a gesture-based retry armed for browsers that defer or quiet
 * the load-time prompt. Returns a disposer that removes the armed listeners.
 */
function armNotificationPermission() {
	if (!notificationsSupported()) return () => {};
	// One request at a time, and only while the browser still has no verdict.
	let inFlight = false;
	const request = () => {
		if (inFlight || Notification.permission !== "default") return;
		inFlight = true;
		try {
			const result = Notification.requestPermission();
			if (result && typeof result.then === "function") {
				result.finally(() => {
					inFlight = false;
				}).catch(() => {});
			} else {
				inFlight = false;
			}
		} catch {
			inFlight = false;
		}
	};
	// Ask on page load if permission hasn't been decided yet — the browser's
	// own prompt handles the rest.
	request();
	// ...and retry on the first user gesture for browsers that defer or quiet
	// the load-time prompt (permission is still "default" then).
	window.addEventListener("pointerdown", request, true);
	window.addEventListener("keydown", request, true);
	return () => {
		window.removeEventListener("pointerdown", request, true);
		window.removeEventListener("keydown", request, true);
	};
}
/** Human-readable title for the card kind. */
function promptKind(card) {
	if (card.hasAttribute("data-approval-key")) return "Approval needed";
	if (card.hasAttribute("data-question-key")) return "Question pending";
	if (card.hasAttribute("data-plan-review-key")) return "Plan review pending";
	return "Prompt pending";
}
/** A short text preview of the prompt card. */
function promptSnippet(card) {
	const text = (card.textContent ?? "").replace(/\s+/g, " ").trim();
	if (text.length <= NOTIFY_BODY_MAX) return text;
	return text.slice(0, NOTIFY_BODY_MAX - 1).trimEnd() + "…";
}
/**
 * Raise a browser notification for a newly appeared pending prompt. Returns
 * true when one was actually shown. Gated by the Settings config: `browserNotify`
 * is the master switch and `browserNotifyOnlyUnfocused` decides whether to
 * stay quiet while the page is focused (the card is right there).
 */
function notifyPending(card) {
	if (!notificationsSupported() || Notification.permission !== "granted") return false;
	const cfg = pgConfig();
	if (cfg.browserNotify === false) return false;
	if (cfg.browserNotifyOnlyUnfocused !== false && !document.hidden && document.hasFocus()) return false;
	const body = promptSnippet(card) || "A pending request is waiting for your answer";
	const notification = new Notification(promptKind(card), {
		body,
		tag: cardId(card) ?? "dspg-prompt",
	});
	notification.onclick = () => {
		window.focus();
		notification.close();
	};
	return true;
}
/** Raise a notification for the lost-prompt event (the banner's trigger). */
function notifyLost() {
	if (!notificationsSupported() || Notification.permission !== "granted") return false;
	const cfg = pgConfig();
	if (cfg.browserNotify === false) return false;
	if (cfg.browserNotifyOnlyUnfocused !== false && !document.hidden && document.hasFocus()) return false;
	const notification = new Notification("Prompt guard", {
		body: "A pending request was dismissed without an answer — reopen the page to restore it",
		tag: "dspg-lost",
	});
	notification.onclick = () => {
		window.focus();
		notification.close();
	};
	return true;
}
/**
 * The effective Settings config (defaults until the host getState lands).
 * Defaults seed from the build-time constants.
 */
function pgConfig() {
	try {
		const snapshot = ensurePgStore().getSnapshot();
		return snapshot && typeof snapshot.config === "object" && snapshot.config !== null ? snapshot.config : {};
	} catch {
		return {};
	}
}

function buildCss() {
	return `
/* The banner is a floating pill near the top on desktop... */
.dspg-banner {
	display: flex;
	box-sizing: border-box;
	position: fixed;
	top: 12px;
	left: 50%;
	transform: translateX(-50%);
	max-width: min(540px, calc(100vw - 32px));
	z-index: 100;
	align-items: center;
	gap: 8px;
	padding: 9px 12px;
	border: 1px solid var(--dsw-alias-border-l2);
	border-radius: 12px;
	box-shadow: var(--dsw-shadow-lv3);
	font-size: 13px;
	line-height: 18px;
	color: var(--dsw-alias-state-warn-label);
	background: var(--dsw-alias-bg-base);
	cursor: pointer;
}
.dspg-banner:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dspg-banner-close {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	flex: none;
	width: 22px;
	height: 22px;
	margin-left: auto;
	padding: 0;
	border: none;
	border-radius: 6px;
	background: transparent;
	color: inherit;
	cursor: pointer;
}
/* ...and a full-width strip below the mobile top bar on narrow screens. */
@media (max-width: ${NARROW_BREAKPOINT}px) {
	.dspg-banner {
		top: calc(56px + env(safe-area-inset-top, 0px));
		left: 8px;
		right: 8px;
		transform: none;
		max-width: none;
	}
}
/* The restored prompt card: a floating panel above the composer that stays
   until the user answers it (no page reload). */
.dspg-restore {
	box-sizing: border-box;
	position: fixed;
	left: 50%;
	bottom: calc(24px + env(safe-area-inset-bottom, 0px));
	transform: translateX(-50%);
	width: min(560px, calc(100vw - 32px));
	z-index: 90;
	padding: 12px 14px;
	border: 1px solid var(--dsw-alias-state-warn-secondary);
	border-radius: 16px;
	box-shadow: var(--dsw-shadow-lv3);
	background: var(--dsw-alias-bg-base);
	color: var(--dsw-alias-label-primary);
	font-size: 13px;
	line-height: 20px;
}
.dspg-restore-head {
	display: flex;
	align-items: center;
	gap: 8px;
	font-size: 14px;
	font-weight: 600;
	color: var(--dsw-alias-state-warn-primary);
	margin-bottom: 6px;
}
.dspg-restore-body {
	max-height: min(40vh, 320px);
	overflow-y: auto;
	white-space: pre-wrap;
	word-break: break-word;
	margin-bottom: 10px;
}
.dspg-restore-actions {
	display: flex;
	flex-wrap: wrap;
	justify-content: flex-end;
	gap: 8px;
}
.dspg-restore button {
	padding: 6px 14px;
	border: 1px solid var(--dsw-alias-border-l2);
	border-radius: 10px;
	background: var(--dsw-alias-bg-base);
	color: var(--dsw-alias-label-primary);
	font-size: 13px;
	cursor: pointer;
}
.dspg-restore button:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dspg-restore button.dspg-primary {
	background: var(--dsw-alias-interactive-bg);
	color: var(--dsw-alias-interactive-fg, var(--dsw-alias-bg-base));
	border-color: transparent;
}
.dspg-restore button.dspg-danger { color: var(--dsw-alias-state-error-primary); }
.dspg-restore input[type="text"] {
	box-sizing: border-box;
	width: 100%;
	margin: 4px 0 8px;
	padding: 6px 10px;
	border: 1px solid var(--dsw-alias-border-l2);
	border-radius: 10px;
	background: var(--dsw-alias-bg-base);
	color: var(--dsw-alias-label-primary);
	font-size: 13px;
}
.dspg-restore-options { display: flex; flex-direction: column; gap: 4px; margin: 4px 0 8px; }
.dspg-restore-options label { display: flex; gap: 8px; align-items: flex-start; cursor: pointer; }
.dspg-restore-note { margin-top: 8px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
@media (max-width: ${NARROW_BREAKPOINT}px) {
	.dspg-restore {
		left: 8px;
		right: 8px;
		transform: none;
		width: auto;
	}
}
`;
}

/** Mount the pending-prompt watchdog. Returns a disposer. */
function mountPromptGuard(ctx) {
	const styleTag = document.createElement("style");
	styleTag.dataset.plugin = "dsh-plugin-prompt-guard";
	styleTag.dataset.pluginCss = "dsh-plugin-prompt-guard/styles";
	styleTag.textContent = buildCss();
	document.head.appendChild(styleTag);

	const disarmPermission = armNotificationPermission();
	let banner = null;
	let pendingKey = null;
	let interacted = false;
	let disposed = false;
	/** rpcId -> { el, payload } for each rendered restore card. */
	const restoreCards = new Map();

	function cardEl() {
		return document.querySelector(CARD_SELECTOR);
	}
	function apiClient() {
		try {
			const connection = ctx.get("connection");
			return connection && typeof connection === "object" && connection.api ? connection.api : void 0;
		} catch {
			return void 0;
		}
	}
	/** Called on every DOM change (debounced): track the visible pending card. */
	function watch() {
		const card = cardEl();
		if (card !== null) {
			// The app's own card is authoritative: drop any restored copies.
			clearRestoreCards();
			const key = cardId(card);
			if (key !== null && key !== pendingKey) {
				pendingKey = key;
				interacted = false;
				hideBanner();
				notifyPending(card);
			}
			return;
		}
		if (pendingKey !== null) {
			pendingKey = null;
			if (!interacted) {
				showBanner();
				notifyLost();
				probePending();
			}
		}
	}

	// ── host probe: re-request the still-pending waits without a reload ──────
	/** Open a short-lived mux and render a persistent card for every replayed pending wait. */
	function probePending() {
		if (restoreCards.size >= MAX_RESTORE_CARDS) return;
		const api = apiClient();
		if (api === void 0 || typeof api.events?.mux !== "function") return;
		const ac = new AbortController();
		const timer = window.setTimeout(() => ac.abort(), PROBE_WINDOW_MS);
		ac.signal.addEventListener("abort", () => window.clearTimeout(timer));
		void (async () => {
			try {
				for await (const envelope of api.events.mux({}, ac.signal)) {
					const type = envelope?.payload?.type;
					if (type === "approval/requested" || type === "question/requested") {
						showRestoreCard(envelope);
						if (restoreCards.size >= MAX_RESTORE_CARDS) break;
					}
					if (type === "stream/error") break;
				}
			} catch {
				/* probe aborted or transport closed — restore cards already shown stay */
			}
		})();
	}

	/** Render (or refresh) the persistent interactive card for one pending wait. */
	function showRestoreCard(envelope) {
		const rpcId = envelope?.rpcId;
		const payload = envelope?.payload;
		if (typeof rpcId !== "string" || payload === void 0) return;
		if (restoreCards.has(rpcId)) return;
		if (restoreCards.size >= MAX_RESTORE_CARDS) return;
		let el;
		if (payload.type === "approval/requested") el = renderApprovalCard(rpcId, payload);
		else if (payload.type === "question/requested") el = renderQuestionCard(rpcId, payload);
		else return;
		if (el === null) return;
		restoreCards.set(rpcId, { el, payload });
		document.body.appendChild(el);
		hideBanner();
	}

	function renderApprovalCard(rpcId, payload) {
		const root = document.createElement("div");
		root.className = "dspg-restore";
		root.setAttribute("data-dspg-restore", rpcId);
		const head = document.createElement("div");
		head.className = "dspg-restore-head";
		head.textContent = "⚠ Approval needed (restored)";
		const body = document.createElement("div");
		body.className = "dspg-restore-body";
		const toolName = typeof payload.toolName === "string" ? payload.toolName : "this tool";
		const reason = typeof payload.reason === "string" && payload.reason.length > 0 ? payload.reason : void 0;
		body.textContent = reason === void 0 ? `The agent is waiting for your approval to use "${toolName}".` : `${reason}`;
		const actions = document.createElement("div");
		actions.className = "dspg-restore-actions";
		const reject = document.createElement("button");
		reject.type = "button";
		reject.className = "dspg-danger";
		reject.textContent = "Reject";
		reject.addEventListener("click", () => answerApproval(rpcId, payload, "rejected"));
		const allow = document.createElement("button");
		allow.type = "button";
		allow.className = "dspg-primary";
		allow.textContent = "Allow once";
		allow.addEventListener("click", () => answerApproval(rpcId, payload, "allowed-once"));
		actions.append(reject, allow);
		root.append(head, body, actions);
		return root;
	}

	function renderQuestionCard(rpcId, payload) {
		const questions = Array.isArray(payload.questions) ? payload.questions : [];
		if (questions.length === 0) return null;
		const root = document.createElement("div");
		root.className = "dspg-restore";
		root.setAttribute("data-dspg-restore", rpcId);
		const head = document.createElement("div");
		head.className = "dspg-restore-head";
		head.textContent = "⚠ Question pending (restored)";
		const body = document.createElement("div");
		body.className = "dspg-restore-body";
		for (const q of questions) {
			if (typeof q !== "object" || q === null) continue;
			const id = String(q.id ?? "");
			const prompt = document.createElement("p");
			prompt.style.margin = "0 0 4px";
			prompt.textContent = typeof q.question === "string" ? q.question : "Question";
			body.appendChild(prompt);
			if (q.header !== void 0 && typeof q.header === "string" && q.header.length > 0) {
				const header = document.createElement("div");
				header.style.cssText = "font-size:12px;color:var(--dsw-alias-label-tertiary)";
				header.textContent = q.header;
				body.appendChild(header);
			}
			const options = Array.isArray(q.options) ? q.options.filter((o) => o !== null && typeof o === "object") : [];
			if (options.length > 0) {
				const box = document.createElement("div");
				box.className = "dspg-restore-options";
				const multi = q.multiSelect === true;
				for (const option of options) {
					const label = document.createElement("label");
					const input = document.createElement("input");
					input.type = multi ? "checkbox" : "radio";
					input.name = `dspg-q-${id}`;
					input.value = typeof option.label === "string" ? option.label : "";
					const span = document.createElement("span");
					span.textContent = typeof option.label === "string" ? option.label : "";
					label.append(input, span);
					box.appendChild(label);
				}
				body.appendChild(box);
			} else {
				const input = document.createElement("input");
				input.type = "text";
				input.placeholder = "Type your answer…";
				input.setAttribute("data-custom", id);
				body.appendChild(input);
			}
		}
		const actions = document.createElement("div");
		actions.className = "dspg-restore-actions";
		const submit = document.createElement("button");
		submit.type = "button";
		submit.className = "dspg-primary";
		submit.textContent = "Submit answer";
		submit.addEventListener("click", () => answerQuestion(rpcId, payload));
		actions.appendChild(submit);
		const note = document.createElement("div");
		note.className = "dspg-restore-note";
		note.textContent = "Your answer is sent straight to the host — no page reload needed.";
		root.append(head, body, actions, note);
		return root;
	}

	function removeRestoreCard(rpcId) {
		const entry = restoreCards.get(rpcId);
		if (entry !== void 0) {
			restoreCards.delete(rpcId);
			if (entry.el.isConnected) entry.el.remove();
		}
	}
	function clearRestoreCards() {
		for (const rpcId of [...restoreCards.keys()]) removeRestoreCard(rpcId);
	}

	async function answerApproval(rpcId, payload, outcome) {
		const api = apiClient();
		if (api === void 0 || typeof api.respond !== "function") return;
		try {
			await api.respond({
				type: "client-response",
				rpcId,
				result: { ok: true, value: { sessionId: payload.sessionId, approvalId: payload.approvalId, outcome } }
			});
		} catch {
			/* transport failure — keep the card so the user can retry */
			return;
		}
		removeRestoreCard(rpcId);
	}
	async function answerQuestion(rpcId, payload) {
		const entry = restoreCards.get(rpcId);
		if (entry === void 0) return;
		const answers = (Array.isArray(payload.questions) ? payload.questions : []).map((q) => {
			const id = String(q?.id ?? "");
			const root = entry.el;
			const selected = [...root.querySelectorAll(`input[name="dspg-q-${id}"]:checked`)].map((input) => input.value);
			const customInput = root.querySelector(`input[data-custom="${id}"]`);
			const custom = customInput !== null && typeof customInput.value === "string" && customInput.value.trim().length > 0 ? customInput.value.trim() : void 0;
			return { id, selected, ...(custom !== void 0 ? { custom } : {}) };
		});
		const api = apiClient();
		if (api === void 0 || typeof api.respond !== "function") return;
		try {
			await api.respond({
				type: "client-response",
				rpcId,
				result: { ok: true, value: { sessionId: payload.sessionId, answer: { answers } } }
			});
		} catch {
			/* transport failure — keep the card so the user can retry */
			return;
		}
		removeRestoreCard(rpcId);
	}

	// ── banner (fallback when the host has no pending wait to restore) ───────
	function ensureBanner() {
		if (banner !== null && banner.isConnected) return banner;
		banner = document.createElement("div");
		banner.className = "dspg-banner";
		banner.setAttribute("data-dspg-banner", "");
		const label = document.createElement("span");
		label.textContent = "⚠ A pending request was dismissed — tap to restore it";
		const close = document.createElement("button");
		close.type = "button";
		close.className = "dspg-banner-close";
		close.setAttribute("aria-label", "Dismiss");
		close.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
		close.addEventListener("click", (event) => {
			event.stopPropagation();
			hideBanner();
		});
		banner.append(label, close);
		banner.addEventListener("click", () => {
			window.location.reload();
		});
		document.body.appendChild(banner);
		return banner;
	}
	function showBanner() {
		ensureBanner();
	}
	function hideBanner() {
		if (banner !== null && banner.isConnected) banner.remove();
	}
	function onClick(event) {
		// Any interaction with the pending card counts as an answer (or an
		// intentional cancel), so its later removal is expected.
		if (pendingKey !== null) {
			const card = cardEl();
			if (card !== null && card.contains(event.target)) interacted = true;
		}
	}

	// Debounced DOM watcher (the card mounts/remounts with the composer).
	let tagTimer = 0;
	const observer = new MutationObserver(() => {
		if (tagTimer !== 0) return;
		tagTimer = window.setTimeout(() => {
			tagTimer = 0;
			if (disposed) return;
			watch();
		}, 60);
	});
	observer.observe(document.body, { childList: true, subtree: true });
	document.addEventListener("click", onClick, true);

	return () => {
		disposed = true;
		if (tagTimer !== 0) window.clearTimeout(tagTimer);
		observer.disconnect();
		document.removeEventListener("click", onClick, true);
		disarmPermission();
		clearRestoreCards();
		if (banner !== null && banner.isConnected) banner.remove();
		if (styleTag.isConnected) styleTag.remove();
	};
}

// ── Settings card (Settings → Plugins → Configurable) ────────────────────
/**
 * Same pattern as watchdog/cost-lens: shows and edits the host-side
 * notification config (ntfy topic, token, cooldown) through
 * `/prompt-guard/api`, and offers a one-click test push so the closed-browser
 * channel can be verified end to end.
 */
const PG_NS = "prompt-guard";
const PG_STORE_KEY = "__dshPromptGuard__";
const PG_DEFAULT_CONFIG = { ntfyTopic: "", ntfyToken: "", ntfyPriority: 4, cooldownSec: 5, clickUrl: "http://127.0.0.1:3080", notifyWhileBrowserOpen: false, browserNotify: NOTIFY_ENABLED, browserNotifyOnlyUnfocused: NOTIFY_ONLY_WHEN_UNFOCUSED };
const PG_EN = {
	"settings.title": "Prompt guard",
	"settings.description": "Pending-prompt visibility + notifications",
	"settings.ntfyTopic": "ntfy.sh topic",
	"settings.ntfyToken": "ntfy access token (optional)",
	"settings.ntfyPriority": "ntfy priority",
	"settings.cooldownSec": "Notification cooldown (s)",
	"settings.clickUrl": "Open URL on tap (GUI base)",
	"settings.notifyWhileBrowserOpen": "Also push to ntfy when a browser is open",
	"settings.browserNotify": "Browser notifications",
	"settings.browserOnlyUnfocused": "Only when the tab is hidden or unfocused",
	"settings.save": "Save",
	"settings.saved": "Saved",
	"settings.unsaved": "Unsaved changes",
	"settings.discard": "Discard",
	"settings.test": "Test ntfy push",
	"settings.testBrowser": "Test browser notification",
	"settings.tested": "Test push sent",
	"settings.testedBrowser": "Browser notification sent",
	"settings.deniedBrowser": "Permission not granted — allow notifications first",
	"settings.hint": "When the browser is closed, pending prompts push to this ntfy.sh topic (empty disables the push channel). Tapping a notification opens the GUI URL set above (leave empty to disable). Subscribe on each device you want to ping: https://ntfy.sh/<topic>"
};

function ensurePgStore() {
	if (window[PG_STORE_KEY]) return window[PG_STORE_KEY];
	const listeners = new Set();
	let snapshot = { config: { ...PG_DEFAULT_CONFIG }, loading: true };
	const emit = () => { for (const fn of [...listeners]) fn(); };
	const store = {
		subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
		getSnapshot: () => snapshot,
		patch(partial) { snapshot = { ...snapshot, ...partial }; emit(); }
	};
	window[PG_STORE_KEY] = store;
	return store;
}
/** JSON-RPC to the host half. */
async function pgApi(action, payload) {
	try {
		const res = await fetch("/prompt-guard/api", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action, payload })
		});
		const body = await res.json();
		return body && typeof body === "object" ? body : { ok: false, error: { code: "bad-response", message: "non-object response" } };
	} catch (error) {
		return { ok: false, error: { code: "network", message: String(error?.message ?? error) } };
	}
}
/** React hook over the shared store. */
function usePg() {
	const store = ensurePgStore();
	return react.useSyncExternalStore(store.subscribe, store.getSnapshot);
}

function PromptGuardSettings({ t }) {
	const snapshot = usePg();
	const cfg = snapshot.config ?? { ...PG_DEFAULT_CONFIG };
	const [draft, setDraft] = react.useState(null);
	const [busy, setBusy] = react.useState(false);
	const [saved, setSaved] = react.useState(false);
	const [tested, setTested] = react.useState(false);
	const [browserTested, setBrowserTested] = react.useState(false);
	const [browserDenied, setBrowserDenied] = react.useState(false);
	const [open, setOpen] = react.useState(false);
	const value = draft ?? cfg;
	const dirty = draft !== null;
	const patch = (partial) => setDraft({ ...value, ...partial });
	const save = async () => {
		setBusy(true);
		try {
			const savedConfig = {
				ntfyTopic: String(value.ntfyTopic ?? "").trim(),
				ntfyToken: String(value.ntfyToken ?? "").trim(),
				ntfyPriority: Math.min(5, Math.max(1, Math.round(Number(value.ntfyPriority) || 3))),
				cooldownSec: Math.max(0, Math.round(Number(value.cooldownSec) || 0)),
				clickUrl: String(value.clickUrl ?? "").trim(),
				notifyWhileBrowserOpen: value.notifyWhileBrowserOpen === true,
				browserNotify: value.browserNotify !== false,
				browserNotifyOnlyUnfocused: value.browserNotifyOnlyUnfocused !== false
			};
			const r = await pgApi("setConfig", savedConfig);
			if (r.ok) {
				setDraft(null);
				ensurePgStore().patch({ config: savedConfig });
				setSaved(true);
				window.setTimeout(() => setSaved(false), 1500);
			}
		} finally {
			setBusy(false);
		}
	};
	const test = async () => {
		setBusy(true);
		try {
			const r = await pgApi("testNotify");
			if (r.ok) {
				setTested(true);
				window.setTimeout(() => setTested(false), 3000);
			}
		} finally {
			setBusy(false);
		}
	};
	const testBrowser = () => {
		// Fires in THIS browser immediately — verifies channel #1 (Web Notifications).
		if (typeof Notification === "undefined" || Notification.permission !== "granted") {
			setBrowserDenied(true);
			window.setTimeout(() => setBrowserDenied(false), 3000);
			return;
		}
		const n = new Notification("dsh: browser notification test", { body: "If you see this, browser notifications are working." });
		n.onclick = () => {
			window.focus();
			n.close();
		};
		setBrowserTested(true);
		window.setTimeout(() => setBrowserTested(false), 3000);
	};
	const input = { background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 6, padding: "3px 6px", fontSize: 13, minWidth: 0, flex: 1 };
	const field = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "6px 0" };
	const fieldLabel = { fontSize: 13, color: "var(--dsw-alias-label-primary)", flex: "none" };
	const btn = { cursor: "pointer", background: "transparent", border: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-secondary)", borderRadius: 6, padding: "4px 10px", fontSize: 13 };
	return react_jsx_runtime.jsxs("li", {
		style: { border: "1px solid var(--dsw-alias-border-l2)", background: open ? "var(--dsw-alias-bg-layer-2)" : "var(--dsw-alias-bg-layer-3)", borderRadius: 12, listStyle: "none" },
		children: [
			react_jsx_runtime.jsxs("button", {
				type: "button",
				"aria-expanded": open,
				onClick: () => setOpen(!open),
				style: { appearance: "none", width: "100%", font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer", background: "transparent", border: "none", borderRadius: 12, display: "flex", alignItems: "center", gap: 12, padding: "12px 16px" },
				children: [
					react_jsx_runtime.jsxs("span", {
						style: { minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 2 },
						children: [
							react_jsx_runtime.jsx("span", { style: { color: "var(--dsw-alias-label-primary)", fontSize: 15, fontWeight: 600, lineHeight: 1.4 }, children: t("settings.title") }),
							react_jsx_runtime.jsx("span", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 13, lineHeight: 1.5 }, children: t("settings.description") })
						]
					}),
					dirty && react_jsx_runtime.jsx("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", flex: "none" }, children: t("settings.unsaved") }),
					react_jsx_runtime.jsx("span", {
						"aria-hidden": true,
						style: { color: "var(--dsw-alias-label-tertiary)", flex: "none", transition: "transform .16s", transform: open ? "rotate(180deg)" : "none", fontSize: 12 },
						children: "\u25be"
					})
				]
			}),
			open && react_jsx_runtime.jsxs("div", {
				style: { borderTop: "1px solid var(--dsw-alias-border-l2)", margin: "0 16px", padding: "8px 0 12px" },
				children: [
					react_jsx_runtime.jsx("div", {
						style: field,
						children: [
							react_jsx_runtime.jsx("span", { style: fieldLabel, children: t("settings.ntfyTopic") }),
							react_jsx_runtime.jsx("input", { style: input, value: value.ntfyTopic ?? "", placeholder: "dsh-alerts-...", onChange: (e) => patch({ ntfyTopic: e.target.value }) })
						]
					}),
					react_jsx_runtime.jsx("div", {
						style: field,
						children: [
							react_jsx_runtime.jsx("span", { style: fieldLabel, children: t("settings.ntfyToken") }),
							react_jsx_runtime.jsx("input", { type: "password", style: input, value: value.ntfyToken ?? "", placeholder: "optional", onChange: (e) => patch({ ntfyToken: e.target.value }) })
						]
					}),
					react_jsx_runtime.jsx("div", {
						style: field,
						children: [
							react_jsx_runtime.jsx("span", { style: fieldLabel, children: t("settings.ntfyPriority") }),
							react_jsx_runtime.jsxs("select", {
								style: { ...input, flex: "none" },
								value: value.ntfyPriority ?? 3,
								onChange: (e) => patch({ ntfyPriority: Number(e.target.value) }),
								children: [
									react_jsx_runtime.jsx("option", { value: 1, children: "1 \u2014 min" }),
									react_jsx_runtime.jsx("option", { value: 2, children: "2 \u2014 low" }),
									react_jsx_runtime.jsx("option", { value: 3, children: "3 \u2014 default" }),
									react_jsx_runtime.jsx("option", { value: 4, children: "4 \u2014 high" }),
									react_jsx_runtime.jsx("option", { value: 5, children: "5 \u2014 max/urgent" })
								]
							})
						]
					}),
					react_jsx_runtime.jsx("div", {
						style: field,
						children: [
							react_jsx_runtime.jsx("span", { style: fieldLabel, children: t("settings.cooldownSec") }),
							react_jsx_runtime.jsx("input", { type: "number", min: 0, style: { ...input, flex: "none", width: 72 }, value: value.cooldownSec ?? 5, onChange: (e) => patch({ cooldownSec: Number(e.target.value) }) })
						]
					}),
					react_jsx_runtime.jsx("div", {
						style: field,
						children: [
							react_jsx_runtime.jsx("span", { style: fieldLabel, children: t("settings.clickUrl") }),
							react_jsx_runtime.jsx("input", { style: input, value: value.clickUrl ?? "", placeholder: "http://127.0.0.1:3080", onChange: (e) => patch({ clickUrl: e.target.value }) })
						]
					}),
					react_jsx_runtime.jsx("label", { style: { ...field, cursor: "pointer" }, children: [react_jsx_runtime.jsx("span", { style: fieldLabel, children: t("settings.notifyWhileBrowserOpen") }), react_jsx_runtime.jsx("input", { type: "checkbox", checked: value.notifyWhileBrowserOpen === true, onChange: (e) => patch({ notifyWhileBrowserOpen: e.target.checked }) })] }),
					react_jsx_runtime.jsx("label", { style: { ...field, cursor: "pointer" }, children: [react_jsx_runtime.jsx("span", { style: fieldLabel, children: t("settings.browserNotify") }), react_jsx_runtime.jsx("input", { type: "checkbox", checked: value.browserNotify !== false, onChange: (e) => patch({ browserNotify: e.target.checked }) })] }),
					value.browserNotify !== false && react_jsx_runtime.jsx("label", { style: { ...field, cursor: "pointer", paddingLeft: 18 }, children: [react_jsx_runtime.jsx("span", { style: { ...fieldLabel, color: "var(--dsw-alias-label-tertiary)" }, children: t("settings.browserOnlyUnfocused") }), react_jsx_runtime.jsx("input", { type: "checkbox", checked: value.browserNotifyOnlyUnfocused !== false, onChange: (e) => patch({ browserNotifyOnlyUnfocused: e.target.checked }) })] }),
					react_jsx_runtime.jsx("p", { style: { margin: "6px 0", fontSize: 12, lineHeight: 1.5, color: "var(--dsw-alias-label-tertiary)", wordBreak: "break-word" }, children: t("settings.hint") }),
					react_jsx_runtime.jsx("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8, alignItems: "center", paddingTop: 4, flexWrap: "wrap" }, children: [
						tested && react_jsx_runtime.jsx("span", { style: { fontSize: 12, color: "#4caf50" }, children: t("settings.tested") }),
						browserTested && react_jsx_runtime.jsx("span", { style: { fontSize: 12, color: "#4caf50" }, children: t("settings.testedBrowser") }),
						browserDenied && react_jsx_runtime.jsx("span", { style: { fontSize: 12, color: "var(--dsw-alias-state-error-primary)" }, children: t("settings.deniedBrowser") }),
						react_jsx_runtime.jsx("button", { type: "button", disabled: busy, onClick: () => void testBrowser(), style: btn, children: t("settings.testBrowser") }),
						react_jsx_runtime.jsx("button", { type: "button", disabled: busy, onClick: () => void test(), style: btn, children: t("settings.test") }),
						saved && react_jsx_runtime.jsx("span", { style: { fontSize: 12, color: "#4caf50" }, children: t("settings.saved") }),
						dirty && react_jsx_runtime.jsx("button", { type: "button", onClick: () => setDraft(null), style: btn, children: t("settings.discard") }),
						react_jsx_runtime.jsx("button", { type: "button", disabled: busy || !dirty, onClick: () => void save(), style: { ...btn, borderColor: "transparent", background: "var(--dsw-alias-label-primary)", color: "var(--dsw-alias-bg-layer-3)" }, children: busy ? "\u2026" : t("settings.save") })
					] })
				]
			})
		]
	});
}

function mountPromptGuardCard(ctx) {
	ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
		name: "settings.plugin.item",
		id: "prompt-guard",
		order: 45,
		locale: PG_NS,
		inject: () => ({})
	}, PromptGuardSettings));
}
//#endregion

//#region dsh-plugin-prompt-guard:entry
/** Services required: slots (Settings card) and locale (dictionaries). */
const inject = ["slots", "locale"];
/** Mount the pending-prompt watchdog and the Settings → Plugins card. */
function apply(ctx) {
	ctx.effect(() => ctx.locale.register(PG_NS, { en: PG_EN }), "prompt-guard: dictionaries");
	mountPromptGuardCard(ctx);
	ctx.effect(() => mountPromptGuard(ctx), "prompt-guard: mount");
	const store = ensurePgStore();
	void pgApi("getState").then((r) => {
		if (r.ok) {
			const effective = r.value?.effective ?? {};
			store.patch({ config: { ...PG_DEFAULT_CONFIG, ...effective }, loading: false });
		}
	});
}

exports.apply = apply;
exports.inject = inject;
return module.exports;
//#endregion

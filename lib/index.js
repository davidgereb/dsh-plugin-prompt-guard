// ==== dsh prompt-guard — host half ====
// Browser-only plugins cannot notify the user once the GUI is closed: the
// page is not running. This host half closes that gap. It watches the session
// event log for the moment the agent needs the user — an `approval/asked`
// audit event (permission requests), or a `tool/call` for the question tools
// (`ask_user_question`, plan review via `exit_plan_mode`) — and, when no web
// client is connected, raises a notification on a configured channel
// (ntfy.sh push by default; local desktop notification attempted as well).
//
// When a browser client IS connected the browser half handles visibility
// (system notification while the tab is hidden, visible card while focused),
// so this host half stays silent to avoid double pings.
//
// Configuration comes from the cordis patch entry (`config:`), overridable
// live from the Settings → Plugins → Configurable card via `/prompt-guard/api`
// (UI settings persist to $DSH_HOME/storages/prompt-guard-settings.json and
// take precedence over the patch config).

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Stable plugin name. */
export const name = "prompt-guard";

/** No hard service dependencies (`webServer` is read lazily via `ctx.get`). */
export const inject = [];

/** Default configuration (per-entry `config` in cordis.patch.yml overrides). */
export const DEFAULT_CONFIG = Object.freeze({
	/** ntfy.sh topic to push to; empty disables the push channel. */
	ntfyTopic: "",
	/** Optional ntfy.sh access token for private topics (`Authorization: Bearer`). */
	ntfyToken: "",
	/** ntfy message priority 1-5 (min/low/default/high/max); invalid values fall back to ntfy's default (3). */
	ntfyPriority: 4,
	/** Minimum seconds between two host notifications (burst guard). */
	cooldownSec: 5,
	/** URL opened when a notification is tapped (ntfy `Click` header); empty disables. */
	clickUrl: "http://127.0.0.1:3080",
	/** Host push even while a browser client is connected (default: browser handles that case). */
	notifyWhileBrowserOpen: false,
	/** Browser system notifications master switch (read by the browser half). */
	browserNotify: true,
	/** Browser notifications only when the page is hidden/unfocused (read by the browser half). */
	browserNotifyOnlyUnfocused: true
});

/** Tool calls whose pending execution means the agent is waiting on the user. */
const QUESTION_TOOLS = new Set(["ask_user_question", "exit_plan_mode"]);

/** UI-edited settings file, sibling of the other dsh storages. */
function settingsPath() {
	return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "storages", "prompt-guard-settings.json");
}

/** Keep a Set bounded: drop the oldest keys beyond `max`. */
function trimSet(set, max) {
	if (set.size <= max) return;
	let excess = set.size - max;
	for (const key of set) {
		if (excess-- <= 0) break;
		set.delete(key);
	}
}

/** Push one notification to the configured ntfy.sh topic. */
async function pushNtfy(cfg, title, body, sessionId) {
	if (typeof cfg.ntfyTopic !== "string" || cfg.ntfyTopic.length === 0) return;
	// Header values must be ASCII ByteStrings; keep titles free of non-ASCII.
	const headers = { "content-type": "text/plain", title: ascii(title) };
	if (typeof cfg.ntfyToken === "string" && cfg.ntfyToken.length > 0) headers.authorization = `Bearer ${cfg.ntfyToken}`;
	const priority = Math.round(Number(cfg.ntfyPriority));
	if (Number.isInteger(priority) && priority >= 1 && priority <= 5) headers.priority = String(priority);
	// Deep-link to the exact session that needs attention (the ui-workspace
	// shim opens `?session=<id>` on load), falling back to the plain GUI URL.
	if (typeof cfg.clickUrl === "string" && /^https?:\/\//.test(cfg.clickUrl)) {
		const sep = cfg.clickUrl.includes("?") ? "&" : "?";
		headers.click = typeof sessionId === "string" && sessionId.length > 0 ? `${cfg.clickUrl}${sep}session=${encodeURIComponent(sessionId)}` : cfg.clickUrl;
	}
	try {
		const res = await fetch(`https://ntfy.sh/${encodeURIComponent(cfg.ntfyTopic)}`, {
			method: "POST",
			headers,
			body,
			signal: AbortSignal.timeout(10000)
		});
		if (!res.ok) console.warn(`[prompt-guard] ntfy push failed: HTTP ${res.status}`);
	} catch (error) {
		console.warn(`[prompt-guard] ntfy push error: ${error?.message ?? error}`);
	}
}

/** Collapse non-ASCII characters to ASCII so a string is header-safe. */
function ascii(text) {
	return String(text).replace(/[^\x20-\x7E]/g, "-");
}

/** Best-effort local desktop notification (no-op on headless servers). */
function desktopNotify(title, body) {
	try {
		if (process.platform === "darwin") {
			const child = spawn("osascript", ["-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`], { stdio: "ignore" });
			child.on("error", () => {});
			child.unref();
		} else if (process.platform === "linux") {
			const child = spawn("notify-send", [title, body, "-u", "normal", "-t", "0"], { stdio: "ignore" });
			child.on("error", () => {});
			child.unref();
		}
	} catch {
		/* ignore: no display/daemon is fine (headless deployments) */
	}
}

/**
 * Mount the host-side pending-wait watcher. Fires a notification when the
 * agent needs the user and no web client is connected; skips entirely while a
 * browser is open (the browser half owns that case).
 */
export function apply(ctx, config) {
	const cfg = {
		...DEFAULT_CONFIG,
		...(config !== null && typeof config === "object" ? config : {})
	};

	// ── UI settings (Settings card) override the patch config ────────────────
	const settingsFile = settingsPath();
	let userSettings = {};
	try {
		if (existsSync(settingsFile)) {
			const parsed = JSON.parse(readFileSync(settingsFile, "utf8"));
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) userSettings = parsed;
		}
	} catch (error) {
		ctx.logger.warn(`[prompt-guard] could not read ${settingsFile}: ${error?.message ?? error}`);
	}
	const applyUserSettings = () => {
		for (const key of Object.keys(userSettings)) {
			if (key in DEFAULT_CONFIG) cfg[key] = userSettings[key];
		}
	};
	applyUserSettings();
	const saveUserSettings = () => {
		try {
			mkdirSync(dirname(settingsFile), { recursive: true });
			writeFileSync(settingsFile, JSON.stringify(userSettings, null, 2));
		} catch (error) {
			ctx.logger.warn(`[prompt-guard] could not persist ${settingsFile}: ${error?.message ?? error}`);
		}
	};

	let lastNotifyAt = 0;
	const seenApprovalIds = new Set();
	const seenToolCallIds = new Set();

	/** Whether at least one browser client holds an upgraded WebSocket. */
	const webClientsConnected = () => {
		try {
			const webServer = ctx.get("webServer");
			return webServer !== void 0 && webServer.upgradedSockets instanceof Set && webServer.upgradedSockets.size > 0;
		} catch {
			return false;
		}
	};

	/** One-shot notification through every enabled channel (cooldown-gated). */
	const notify = (kind, title, body, sessionId) => {
		if (webClientsConnected() && cfg.notifyWhileBrowserOpen !== true) return;
		const now = Date.now();
		if (now - lastNotifyAt < Math.max(0, Number(cfg.cooldownSec) || 0) * 1000) return;
		lastNotifyAt = now;
		void pushNtfy(cfg, title, body, sessionId);
		desktopNotify(title, body);
	};

	// ── Settings API (/prompt-guard/api) ─────────────────────────────────────
	const settingsHandle = async (req, res) => {
		const json = (status, body) => {
			res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" });
			res.end(JSON.stringify(body));
		};
		const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
		if (pathname !== "/prompt-guard/api" || req.method !== "POST") return json(404, { ok: false, error: { code: "not-found", message: pathname } });
		let body = "";
		for await (const chunk of req) body += chunk;
		let payload;
		try {
			payload = JSON.parse(body);
		} catch {
			return json(400, { ok: false, error: { code: "bad-json", message: "invalid JSON body" } });
		}
		try {
			const action = payload?.action;
			if (action === "getState") {
				return json(200, { ok: true, value: { config: { ...userSettings }, defaults: DEFAULT_CONFIG, effective: { ...cfg } } });
			}
			if (action === "setConfig") {
				const next = payload?.payload;
				if (next === null || typeof next !== "object" || Array.isArray(next)) return json(400, { ok: false, error: { code: "bad-payload", message: "object expected" } });
				const clean = {};
				for (const key of Object.keys(next)) {
					if (key in DEFAULT_CONFIG) clean[key] = next[key];
				}
				userSettings = clean;
				saveUserSettings();
				applyUserSettings();
				return json(200, { ok: true, value: { ...userSettings } });
			}
			if (action === "testNotify") {
				// Explicit user action from the Settings card: push regardless of
				// connected clients so the topic can be verified end to end.
				await pushNtfy(cfg, "dsh: test notification", "Prompt-guard test push - if you see this, closed-browser notifications are working.");
				desktopNotify("dsh: test notification", "Prompt-guard test push - if you see this, closed-browser notifications are working.");
				return json(200, { ok: true, value: { pushed: typeof cfg.ntfyTopic === "string" && cfg.ntfyTopic.length > 0 } });
			}
			return json(400, { ok: false, error: { code: "unknown-action", message: String(action ?? "") } });
		} catch (error) {
			return json(500, { ok: false, error: { code: "internal", message: String(error?.message ?? error) } });
		}
	};
	ctx.effect(() => {
		const timer = setTimeout(() => {
			void (async () => {
				try {
					const webServer = ctx.get("webServer");
					if (webServer !== void 0 && typeof webServer.register === "function") {
						webServer.register({ kind: "prefix", path: "/prompt-guard", handler: settingsHandle });
						ctx.logger.info("[prompt-guard] settings API mounted at /prompt-guard/api");
					}
				} catch (error) {
					ctx.logger.warn(`[prompt-guard] could not mount /prompt-guard/api: ${error?.message ?? error}`);
				}
			})();
		}, 500);
		return () => clearTimeout(timer);
	}, "prompt-guard: settings api");

	// ── Pending-wait watcher ─────────────────────────────────────────────────
	ctx.effect(() => {
		const dispose = ctx.on("session/event", (session, event) => {
			try {
				if (event.type === "approval/asked") {
					const id = event.data?.id;
					if (typeof id === "string" && !seenApprovalIds.has(id)) {
						seenApprovalIds.add(id);
						trimSet(seenApprovalIds, 1000);
						const toolName = typeof event.data.toolName === "string" ? event.data.toolName : void 0;
						notify("approval", "dsh: approval needed", toolName === void 0 ? "The agent is waiting for your approval - open the GUI to decide." : `The agent needs your approval for "${toolName}" - open the GUI to decide.`, session.id);
					}
					return;
				}
				if (event.type === "tool/call") {
					const tool = event.data?.name;
					if (typeof tool === "string" && QUESTION_TOOLS.has(tool)) {
						const callId = event.data?.callId;
						if (typeof callId === "string" && !seenToolCallIds.has(callId)) {
							seenToolCallIds.add(callId);
							trimSet(seenToolCallIds, 1000);
							notify("question", "dsh: question pending", "The agent is asking you a question - open the GUI to answer it.", session.id);
						}
					}
				}
			} catch (error) {
				ctx.logger.warn(`[prompt-guard] session event handling failed: ${error?.message ?? error}`);
			}
		});
		return () => dispose();
	}, "prompt-guard: pending-wait watcher");
}

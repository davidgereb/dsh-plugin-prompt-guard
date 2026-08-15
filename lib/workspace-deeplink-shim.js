// ==== dsh-plugin-prompt-guard — ui-workspace deep-link shim ====
// Injected into the served ui-workspace client bundle (the app shell owns the
// session browser; it exposes no slot for deep links). When the GUI loads with
// `?session=<id>` — the URL the host attaches to ntfy notification clicks —
// this opens that exact session once the store has it, instead of landing on
// the most recent one, then strips the query so a plain refresh is normal.
//
// Apply/revert with scripts/patch-workspace-deeplink.mjs.

//#region dsh-plugin-prompt-guard:workspace-deeplink
/** Open the session named by `?session=` once the store has it, then clean the URL. */
function PromptGuardDeepLink({ open, useSessions }) {
	const state = useSessions((s) => s);
	const opened = (0, react.useRef)(false);
	(0, react.useEffect)(() => {
		if (opened.current === true) return;
		const params = new URLSearchParams(window.location.search);
		const target = params.get("session");
		if (target === null || typeof open !== "function") return;
		if (state === null || typeof state !== "object" || state.byId === void 0 || !Object.prototype.hasOwnProperty.call(state.byId, target)) return;
		opened.current = true;
		if (state.current !== target) open(target);
		params.delete("session");
		const qs = params.toString();
		window.history.replaceState(null, "", qs === "" ? window.location.pathname : `${window.location.pathname}?${qs}`);
	}, [state, open]);
	return null;
}
//#endregion

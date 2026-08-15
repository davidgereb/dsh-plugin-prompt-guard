#!/usr/bin/env node
// Apply or revert the prompt-guard deep-link shim in the SERVED ui-workspace
// client bundle: when the GUI loads with `?session=<id>` (the ntfy
// notification click URL), open that exact session instead of the most recent
// one, then strip the query parameter.
//
// Usage:
//   node scripts/patch-workspace-deeplink.mjs            # apply (idempotent)
//   node scripts/patch-workspace-deeplink.mjs --revert   # remove the shim
//   DSPG_WORKSPACE_CLIENT=/path/to/client.js node scripts/patch-workspace-deeplink.mjs
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// The served bundle lives inside the dsh installation's own node_modules or
// the profile's node_modules. Resolve it from $DSH_HOME and standard package
// locations rather than hardcoding an install path; DSPG_WORKSPACE_CLIENT
// overrides everything.
const candidates = [
	process.env.DSPG_WORKSPACE_CLIENT,
	process.env.DSH_HOME && join(process.env.DSH_HOME, "profiles", "web", "node_modules", "@deepseek-ai", "dsh-client-ui-workspace", "lib", "client.js"),
	join(homedir(), ".dsh", "profiles", "web", "node_modules", "@deepseek-ai", "dsh-client-ui-workspace", "lib", "client.js"),
	join(homedir(), "node_modules", "@deepseek-ai", "dsh-client-ui-workspace", "lib", "client.js")
].filter(Boolean);
const target = candidates.find((p) => existsSync(p));
const revert = process.argv.includes("--revert");

if (!target) {
	console.error(
		"could not locate the served ui-workspace client.js.\n" +
		"Set DSPG_WORKSPACE_CLIENT to the path of the dsh-client-ui-workspace client.js bundle\n" +
		"(e.g. the one served by the dsh web profile), or run with DSH_HOME set to your dsh home."
	);
	process.exit(1);
}

const REGION_START = "//#region dsh-plugin-prompt-guard:workspace-deeplink";
const REGION_END = "//#endregion dsh-plugin-prompt-guard:workspace-deeplink";
/** Insert the rendered deep-link element as the first child of WorkspaceBrowser's root. */
const RENDER_ANCHOR = "className: clsx(WorkspaceBrowser_module_css_default.root, !wide && WorkspaceBrowser_module_css_default.rail),";
const RENDER_LINE = "(0, react_jsx_runtime.jsx)(PromptGuardDeepLink, { open, useSessions }),";
const EXPORTS_ANCHOR = "exports.apply = apply;";

if (!existsSync(target)) {
	console.error(`target not found: ${target}\nset DSPG_WORKSPACE_CLIENT to the served ui-workspace client.js`);
	process.exit(1);
}
const original = readFileSync(target, "utf8");
const hasRegion = original.includes(REGION_START);

if (revert) {
	if (!hasRegion) {
		console.log("shim not present; nothing to revert");
		process.exit(0);
	}
	let out = original;
	let start = out.indexOf(REGION_START);
	if (start > 0 && out[start - 1] === "\n") start -= 1;
	const end = out.indexOf(REGION_END, start);
	if (end === -1) throw new Error("malformed shim region (missing end marker)");
	let lineEnd = out.indexOf("\n", end + REGION_END.length);
	if (lineEnd === -1) lineEnd = out.length;
	out = out.slice(0, start) + out.slice(lineEnd + 1);
	// Remove the render-call line, any indentation.
	const escaped = RENDER_LINE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	out = out.replace(new RegExp(`^[ \\t]*${escaped}\\r?\\n`, "gm"), "");
	out = out.replace(/\n{3,}/g, "\n\n");
	writeFileSync(target, out);
	console.log(`reverted deep-link shim in ${target}`);
	process.exit(0);
}

if (hasRegion) {
	console.log("shim already applied; nothing to do");
	process.exit(0);
}

const shim = readFileSync(join(root, "lib", "workspace-deeplink-shim.js"), "utf8");
const insert = shim.slice(shim.indexOf(REGION_START)).trimEnd();
let out = original;

// 1. shim block above the exports lines.
const at = out.indexOf(EXPORTS_ANCHOR);
if (at === -1) throw new Error(`could not locate '${EXPORTS_ANCHOR}' in the ui-workspace bundle`);
const lineStart = out.lastIndexOf("\n", at) + 1;
out = out.slice(0, lineStart) + "\n" + insert + "\n" + out.slice(lineStart);

// 2. render call as the first child of WorkspaceBrowser's root element.
{
	const a = out.indexOf(RENDER_ANCHOR);
	if (a === -1) throw new Error(`could not locate ${JSON.stringify(RENDER_ANCHOR)} in the ui-workspace bundle`);
	const afterAnchor = out.slice(a + RENDER_ANCHOR.length);
	const childrenOpen = afterAnchor.indexOf("children: [");
	if (childrenOpen === -1) throw new Error(`no 'children: [' after ${JSON.stringify(RENDER_ANCHOR)}`);
	const insertAt = a + RENDER_ANCHOR.length + childrenOpen + "children: [".length;
	// Match the existing indentation of the first child line.
	const nextLine = out.indexOf("\n", insertAt);
	const childIndentMatch = /^[ \t]*/.exec(out.slice(nextLine + 1));
	const indent = childIndentMatch === null ? "\t\t\t\t\t" : childIndentMatch[0];
	out = out.slice(0, insertAt) + `\n${indent}${RENDER_LINE}` + out.slice(insertAt);
}

writeFileSync(target, out);
console.log(`applied deep-link shim to ${target}`);

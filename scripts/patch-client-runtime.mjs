#!/usr/bin/env node
// Apply or revert the prompt-guard root-cause fix in the SERVED
// dsh-client-runtime client bundle.
//
// Why: on every connection reset the app calls Session#resync(), which clears
// the session's pending-wait list (`this.pending.clear()`) and then relies on
// the host mux baseline replay to re-mint the cards. When that replay is
// missing (backgrounded tab, flaky network, host hiccup) the pending
// approval/question prompt is silently lost. The fix keeps the pending list
// across reconnect: the baseline replay re-mints the same rpcIds, and mint()
// is a Map.set keyed by `kind:rpcId`, so re-minting is a duplicate-free no-op;
// if the replay never arrives the card simply stays on screen until the user
// answers it (or a resolved frame settles it).
//
// Usage:
//   node scripts/patch-client-runtime.mjs            # apply (idempotent)
//   node scripts/patch-client-runtime.mjs --revert   # remove the fix
//   DSPG_RUNTIME_CLIENT=/path/to/client.js node scripts/patch-client-runtime.mjs
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Resolve the served dsh-client-runtime copies from $DSH_HOME and standard
// package locations rather than hardcoding an install path; DSPG_RUNTIME_CLIENT
// overrides everything (repeatable with a comma-separated list).
const defaultTargets = () => {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return [
		join(home, "profiles", "web", "node_modules", "@deepseek-ai", "dsh-client-runtime", "lib", "client.js"),
		join(home, "node_modules", "@deepseek-ai", "dsh-client-runtime", "lib", "client.js"),
		join(homedir(), "node_modules", "@deepseek-ai", "dsh-client-runtime", "lib", "client.js")
	];
};
const DEFAULT_TARGETS = defaultTargets();

const OLD = "\t\t\t\tthis.pending.clear();\n\t\t\t\tthis.pendingRev++;";
const NEW = "\t\t\t\t/* dsh-plugin-prompt-guard: keep pending waits across reconnect (no premature hide) */\n\t\t\t\tthis.pendingRev++;";
// Older installs used the pre-rename marker; treat it as applied too so a
// `--revert` (or a re-apply) works against bundles patched by either version.
const LEGACY_NEW = "\t\t\t\t/* dsh-prompt-guard: keep pending waits across reconnect (no premature hide) */\n\t\t\t\tthis.pendingRev++;";

const targets = process.env.DSPG_RUNTIME_CLIENT !== void 0 ? process.env.DSPG_RUNTIME_CLIENT.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_TARGETS;
const revert = process.argv.includes("--revert");

let changed = 0;
for (const target of targets) {
	if (!existsSync(target)) {
		console.warn(`target not found, skipped: ${target}`);
		continue;
	}
	const original = readFileSync(target, "utf8");
	if (revert) {
		if (!original.includes(NEW) && !original.includes(LEGACY_NEW)) {
			console.log(`fix not present (nothing to revert): ${target}`);
			continue;
		}
		writeFileSync(target, original.replace(NEW, OLD).replace(LEGACY_NEW, OLD));
		console.log(`reverted fix in ${target}`);
	} else {
		if (original.includes(NEW) || original.includes(LEGACY_NEW)) {
			console.log(`fix already applied: ${target}`);
			continue;
		}
		if (!original.includes(OLD)) {
			console.error(`anchor not found in ${target} — the bundle may have changed; aborting this target`);
			process.exitCode = 1;
			continue;
		}
		writeFileSync(target, original.replace(OLD, NEW));
		console.log(`applied fix in ${target}`);
	}
	changed += 1;
}
console.log(changed === 0 ? "no files changed" : `patched ${changed} file(s)`);

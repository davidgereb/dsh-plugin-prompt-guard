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

const DEFAULT_TARGETS = [
	// The dsh install copy (proven served: the cost-lens ui-workspace shim lives here).
	"/root/.nvm/versions/node/v24.19.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-runtime/lib/client.js",
	// The profile-adjacent copy (same bytes today; keep both in sync).
	"/root/node_modules/@deepseek-ai/dsh-client-runtime/lib/client.js"
];

const OLD = "\t\t\t\tthis.pending.clear();\n\t\t\t\tthis.pendingRev++;";
const NEW = "\t\t\t\t/* dsh-plugin-prompt-guard: keep pending waits across reconnect (no premature hide) */\n\t\t\t\tthis.pendingRev++;";

const targets = process.env.DSPG_RUNTIME_CLIENT !== void 0 ? [process.env.DSPG_RUNTIME_CLIENT] : DEFAULT_TARGETS;
const revert = process.argv.includes("--revert");

let changed = 0;
for (const target of targets) {
	if (!existsSync(target)) {
		console.warn(`target not found, skipped: ${target}`);
		continue;
	}
	const original = readFileSync(target, "utf8");
	if (revert) {
		if (!original.includes(NEW)) {
			console.log(`fix not present (nothing to revert): ${target}`);
			continue;
		}
		writeFileSync(target, original.replace(NEW, OLD));
		console.log(`reverted fix in ${target}`);
	} else {
		if (original.includes(NEW)) {
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

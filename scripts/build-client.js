#!/usr/bin/env node
// Build lib/client.js (the ModuleLoader-format client bundle) from
// src/client-source.js. Usage: node scripts/build-client.js
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "src", "client-source.js"), "utf8");

const CORE_START = "//#region dsh-plugin-prompt-guard:core";
const CORE_END = "//#endregion";
const ENTRY_START = "//#region dsh-plugin-prompt-guard:entry";
const ENTRY_END = "//#endregion";

function sliceRegion(body, startMarker, endMarker) {
	const start = body.indexOf(startMarker);
	if (start === -1) throw new Error(`missing marker: ${startMarker}`);
	const end = body.indexOf(endMarker, start + startMarker.length);
	if (end === -1) throw new Error(`missing end marker after: ${startMarker}`);
	return body.slice(start, end + endMarker.length);
}

const header = source.slice(0, source.indexOf(CORE_START)).trimEnd();
const core = sliceRegion(source, CORE_START, CORE_END);
const entry = sliceRegion(source, ENTRY_START, ENTRY_END);
const body = [header, core, entry].join("\n\n");

const bundle = [
	"window.__ModuleLoader__.load({",
	"\tid: \"dsh-plugin-prompt-guard\",",
	"\tfactory: (require) => {",
	body,
	"\t}",
	"});",
	"",
	"//# sourceMappingURL=client.js.map",
	""
].join("\n");

writeFileSync(join(root, "lib", "client.js"), bundle);
console.log("wrote lib/client.js");

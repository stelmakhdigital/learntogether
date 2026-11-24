#!/usr/bin/env node
// Enforces the dependency direction declared in AGENTS.md. Fix violations by
// moving code down the stack, never by adding an exception here.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ALLOWED = {
	domain: [],
	data: ["domain"],
	models: ["domain"],
	agent: ["domain", "models"],
	server: ["domain", "data", "models", "agent"],
	ui: ["domain"],
	desktop: [],
	cli: ["domain", "data"],
};

const sources = [];
function collect(dir) {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (entry === "node_modules" || entry === "dist") continue;
		if (statSync(full).isDirectory()) collect(full);
		else if (full.endsWith(".ts") || full.endsWith(".tsx")) sources.push(full);
	}
}

const roots = ["packages", "apps"];
for (const root of roots) {
	try {
		collect(root);
	} catch {
		// apps/ appears at a later stage
	}
}

const PACKAGE_RE = /@learntogether\/([a-z]+)/g;
const problems = [];

for (const file of sources) {
	const parts = relative(".", file).split(/[\\/]/);
	const pkgName = parts[1];
	const allowed = ALLOWED[pkgName];
	if (!allowed) {
		problems.push(`${file}: unknown package "${pkgName}" (add it to ALLOWED with its layer)`);
		continue;
	}
	const text = readFileSync(file, "utf8");
	const isTest = file.includes("/test/");
	for (const match of text.matchAll(PACKAGE_RE)) {
		const used = match[1];
		if (used === pkgName) continue;
		if (!allowed.includes(used)) {
			problems.push(`${file}: ${pkgName} -> ${used} is not allowed (allowed: ${allowed.join(", ") || "none"})`);
		}
	}
	// The agent layer must stay free of I/O so it can run against fixtures.
	if (pkgName === "agent" && !isTest) {
		for (const bad of ["node:fs", "node:net", "node:http", "@learntogether/data"]) {
			if (text.includes(`"${bad}"`)) problems.push(`${file}: agent must not import ${bad}`);
		}
	}
	if (pkgName === "domain" && !isTest) {
		for (const bad of ["node:fs", "node:http", "node:net", "node:child_process", "node:sqlite"]) {
			if (text.includes(`"${bad}"`)) problems.push(`${file}: domain must not import ${bad}`);
		}
	}
}

if (problems.length) {
	console.error(problems.join("\n"));
	console.error(`\nlayer check failed: ${problems.length} problem(s)`);
	process.exit(1);
}
console.log(`layer check passed (${sources.length} files)`);

/**
 * Unit coverage for the pieces the contract suite cannot reach directly.
 *
 * engine.contract.test.ts exercises behaviour end to end, which leaves gaps:
 * the cell transform runs inside the guest process, and protocol framing,
 * prompt assembly, and cell layout are only observed through their effects.
 * Those are tested here in isolation, where their edge cases are reachable.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNpmSpecifier } from "../src/engine/npm.js";
import { decodeMessage, encodeMessage } from "../src/engine/protocol.js";
import { transformCell } from "../src/engine/transform.js";
import {
	ALWAYS_RESIDENT_TOOLS,
	DEFAULT_RESIDENT_TOOLS,
	resolveRlmDropSet,
	resolveRlmEnsuredSurface,
	resolveRlmResidentSurface,
	resolveRlmResidentTools,
	rlmCanTakeOver,
	sameToolSet,
} from "../src/extension/keep-tools.js";
import { buildRlmTsPrompt } from "../src/extension/prompt.js";
import {
	backgroundFor,
	closeOpenSgr,
	type ExecuteRenderState,
	formatDuration,
	isShellish,
	paintBackground,
	type RenderDeps,
	renderExecuteCell,
	statusKind,
} from "../src/extension/render-core.js";
import {
	createSubagentHost,
	defaultSubagentName,
	MAX_SUBAGENT_NAME_LENGTH,
	resolveDefaultSubagentModel,
} from "../src/extension/subagents.js";
import {
	buildLoadToolsCatalog,
	CATALOG_SUMMARY_CHARS,
	QUERY_MATCH_LIMIT,
	selectToolsToLoad,
	summarizeForCatalog,
	toolGroupName,
} from "../src/extension/tool-tiers.js";

// ── transform ─────────────────────────────────────────────────────────────────

describe("transform: types and declarations", () => {
	test("strips TypeScript annotations", () => {
		const { body } = transformCell("const x: number = 1; function f(a: string): string { return a; }");
		expect(body).not.toContain(": number");
		expect(body).not.toContain(": string");
	});

	test("collects names from every top-level declaration form", () => {
		const { declaredNames } = transformCell(
			"let a = 1, b = 2;\nconst c = 3;\nvar d = 4;\nfunction fn() {}\nclass Cls {}",
		);
		expect(declaredNames.sort()).toEqual(["Cls", "a", "b", "c", "d", "fn"]);
	});

	test("collects destructured names: object, array, rest, default, nested", () => {
		const { declaredNames } = transformCell(
			"const { p, q: renamed, ...restObj } = o;\nconst [first, , third = 9, ...restArr] = arr;\nconst { deep: { inner } } = o2;",
		);
		expect(declaredNames.sort()).toEqual(["first", "inner", "p", "renamed", "restArr", "restObj", "third"].sort());
	});

	test("deduplicates repeated names", () => {
		// `var` may legally redeclare; the name must appear once in the manifest.
		const { declaredNames } = transformCell("var dup = 1;\nvar dup = 2;");
		expect(declaredNames).toEqual(["dup"]);
	});
});

describe("transform: imports", () => {
	test("named imports become an awaited dynamic import", () => {
		const { body, declaredNames } = transformCell('import { join, resolve } from "node:path";');
		expect(body).toContain('await import("node:path")');
		expect(body).toContain("join");
		expect(declaredNames.sort()).toEqual(["join", "resolve"]);
	});

	test("default and aliased imports are destructured correctly", () => {
		const { body } = transformCell('import fsDefault from "node:fs";');
		expect(body).toContain("default: fsDefault");
		const aliased = transformCell('import { join as pathJoin } from "node:path";');
		expect(aliased.body).toContain('"join": pathJoin');
		expect(aliased.declaredNames).toEqual(["pathJoin"]);
	});

	test("namespace import binds the whole module", () => {
		const { body, declaredNames } = transformCell('import * as path from "node:path";');
		expect(body).toContain('path = await import("node:path")');
		expect(declaredNames).toEqual(["path"]);
	});

	test("side-effect-only import still awaits the module", () => {
		const { body, declaredNames } = transformCell('import "node:path";');
		expect(body).toContain('await import("node:path")');
		expect(declaredNames).toEqual([]);
	});

	test("npm: specifiers route through the cell context importer, not import()", () => {
		// Bun's runtime cannot resolve npm: specifiers, so a plain import() would
		// throw. The guest owns the cache importer; the transform routes to it.
		const { body, declaredNames } = transformCell('import { z } from "npm:zod@4";', { ctxName: "__ctx" });
		expect(body).toContain('await __ctx.importModule("npm:zod@4")');
		expect(body).not.toContain('import("npm:zod@4")');
		expect(declaredNames).toEqual(["z"]);
	});

	test("npm: routing covers namespace and side-effect-only forms", () => {
		const namespaced = transformCell('import * as z from "npm:zod@4";', { ctxName: "__ctx" });
		expect(namespaced.body).toContain('z = await __ctx.importModule("npm:zod@4")');
		const bare = transformCell('import "npm:zod@4";', { ctxName: "__ctx" });
		expect(bare.body).toContain('await __ctx.importModule("npm:zod@4")');
	});

	test("export statements are rejected with a clear SyntaxError", () => {
		expect(() => transformCell("export const nope = 1;")).toThrow(/export/i);
		expect(() => transformCell("export default 1;")).toThrow(/export/i);
	});
});

describe("transform: result capture", () => {
	test("a trailing expression is captured as the cell result", () => {
		const { body } = transformCell("const a = 1;\na + 1");
		expect(body).toContain("__ctx.setResult(");
	});

	test("a statement-only cell captures no result", () => {
		expect(transformCell("let q = 5;")).toMatchObject({ body: expect.not.stringContaining("setResult") });
		expect(transformCell("function f() { return 1; }").body).not.toContain("setResult");
		expect(transformCell("if (true) { 1; }").body).not.toContain("setResult");
	});

	test("side-effect-free trailing expressions are not dead-code eliminated", () => {
		// The transpiler's dead-code elimination would delete these as pointless;
		// they are the cell's result, so it stays off.
		expect(transformCell('"just-a-string"').body).toContain("setResult");
		expect(transformCell("({ a: 1 })").body).toContain("setResult");
		expect(transformCell("[1, 2, 3]").body).toContain("setResult");
	});
});

describe("transform: syntax edge cases", () => {
	const cases: Array<[string, string]> = [
		["regex vs division", 'const s = "aXbXc"; s.split(/X/).length'],
		["template with braces", "const k = 2; `v=${ { a: 1 }.a + k }`"],
		["template containing the word import", "`this mentions import { x } from 'y' inside a string`"],
		["trailing comment", "1 + 1 // trailing comment"],
		["comment-only cell", "// nothing but a comment"],
		["no semicolons", "const p = 1\nconst q = 2\np + q"],
		["labeled statement", 'outer: for (const i of [1, 2]) { break outer; }\n"labeled-ok"'],
		["generator and async fn", "function* gen() { yield 1; }\nasync function ay() { return 1; }\n1"],
		["optional chaining and nullish", "const o = {}; o?.a?.b ?? 'fallback'"],
		["class with private field", "class P { #hidden = 1; get v() { return this.#hidden; } }\n1"],
	];
	for (const [label, code] of cases) {
		test(`parses: ${label}`, () => {
			expect(() => transformCell(code)).not.toThrow();
		});
	}

	test("a genuine syntax error still throws", () => {
		expect(() => transformCell("let let let")).toThrow();
	});
});

// ── compile errors teach ──────────────────────────────────────────────────────
// Bun.Transpiler throws BuildMessage objects whose stringified form drops the
// position entirely — an agent sees `Expected "}" but found ":"` with no line,
// no column, no source. The transform must rebuild every compile failure into
// a compiler-style display (message, position, offending line, caret), and add
// a one-line hint for known traps. The only known trap so far: bash-style
// ${...} inside a template literal, which Bun parses as JS interpolation, so
// shell parameter expansion written into Bun.$`...` fails to compile with a
// message the agent retries against verbatim.

describe("transform: compile errors teach", () => {
	function compileError(code: string): string {
		try {
			transformCell(code);
		} catch (error) {
			return (error as Error).message;
		}
		throw new Error(`expected a compile error for: ${code}`);
	}

	test("a compile error names its position and shows the offending line with a caret", () => {
		const message = compileError("const x = ;");
		expect(message).toContain("Unexpected ;");
		expect(message).toContain("line 1, column 11");
		const lines = message.split("\n");
		const sourceAt = lines.indexOf("  const x = ;");
		expect(sourceAt).toBeGreaterThan(0);
		expect(lines[sourceAt + 1]).toBe(`  ${" ".repeat(10)}^`);
	});

	test("bash parameter expansion in backticks gets the escape hint", () => {
		const message = compileError('await $`echo "v=${VAR:+yes}"`');
		expect(message).toContain("interpolation");
		expect(message).toContain("\\${");
	});

	test("the position survives in a multi-line cell", () => {
		const message = compileError("const a = 1;\nconst b = 2;\nawait $`x ${VAR:+y}`");
		expect(message).toContain("line 3");
		expect(message).toContain("await $`x ${VAR:+y}`");
	});

	test("a genuine syntax error does not get the bash hint", () => {
		expect(compileError("const x = ;")).not.toContain("interpolation");
	});

	// Once the parser recovers past the first error it throws AggregateError
	// ("Parse error", no position) with the BuildMessages in `errors`. Mixed
	// ASCII double quotes inside a string are the case seen in the wild.
	test("a multi-error parse failure shows every site with position and caret", () => {
		const message = compileError('console.log("He said "hello" to me")');
		expect(message).not.toContain("Parse error");
		expect(message).not.toContain("AggregateError");
		expect(message).toContain('Cell did not compile: Expected ")" but found "hello" (line 1, column 23)');
		expect(message).toContain("Also: ");
		const lines = message.split("\n");
		const sourceAt = lines.indexOf('  console.log("He said "hello" to me")');
		expect(sourceAt).toBeGreaterThan(0);
		expect(lines[sourceAt + 1]).toBe(`  ${" ".repeat(22)}^`);
	});

	test("a multi-error parse failure on a ${ line gets the bash hint once", () => {
		const message = compileError("let let let ${VAR:+x}");
		expect(message).toContain("line 1");
		expect(message.split("interpolation")).toHaveLength(2);
	});

	test("valid JS interpolation compiles untouched", () => {
		const { body } = transformCell("`${1 + 1}`");
		expect(body).toContain("${1 + 1}");
	});

	test("already-escaped \\${ in backticks compiles untouched", () => {
		expect(() => transformCell('await $`echo "\\${HOME}"`')).not.toThrow();
	});
});

// ── npm specifiers ────────────────────────────────────────────────────────────
// Parsing is the security boundary: the name reaches a generated package.json
// and the resolver, so anything that is not a plain npm package name must be
// rejected before it can name a path or a dependency.

describe("npm specifier parsing", () => {
	test("bare name defaults to latest with no subpath", () => {
		expect(parseNpmSpecifier("npm:zod")).toEqual({ name: "zod", version: "latest", subpath: "" });
	});

	test("versions, ranges, and tags stay attached to the name", () => {
		expect(parseNpmSpecifier("npm:zod@4.1.0")).toEqual({ name: "zod", version: "4.1.0", subpath: "" });
		expect(parseNpmSpecifier("npm:zod@^4")).toEqual({ name: "zod", version: "^4", subpath: "" });
		expect(parseNpmSpecifier("npm:zod@beta")).toEqual({ name: "zod", version: "beta", subpath: "" });
	});

	test("scoped names keep the scope; the version @ is not confused with it", () => {
		expect(parseNpmSpecifier("npm:@scope/pkg")).toEqual({ name: "@scope/pkg", version: "latest", subpath: "" });
		expect(parseNpmSpecifier("npm:@scope/pkg@2.0.0")).toEqual({ name: "@scope/pkg", version: "2.0.0", subpath: "" });
	});

	test("subpaths survive for plain and scoped names", () => {
		expect(parseNpmSpecifier("npm:lodash-es@4/add.js")).toEqual({
			name: "lodash-es",
			version: "4",
			subpath: "/add.js",
		});
		expect(parseNpmSpecifier("npm:@scope/pkg@1/deep/entry")).toEqual({
			name: "@scope/pkg",
			version: "1",
			subpath: "/deep/entry",
		});
	});

	test("rejects non-npm specifiers and malformed names", () => {
		expect(() => parseNpmSpecifier("node:path")).toThrow(/npm:/);
		expect(() => parseNpmSpecifier("npm:")).toThrow();
		expect(() => parseNpmSpecifier("npm:@scope")).toThrow();
		expect(() => parseNpmSpecifier("npm:zod@")).toThrow();
	});

	test("rejects names that could escape into the filesystem", () => {
		expect(() => parseNpmSpecifier("npm:../evil")).toThrow();
		expect(() => parseNpmSpecifier("npm:..")).toThrow();
		expect(() => parseNpmSpecifier("npm:.")).toThrow();
		expect(() => parseNpmSpecifier(String.raw`npm:name\bad`)).toThrow();
		expect(() => parseNpmSpecifier(String.raw`npm:zod@1.0.0\evil`)).toThrow();
		expect(() => parseNpmSpecifier("npm:@scope/../evil")).toThrow();
	});
});

// ── protocol ──────────────────────────────────────────────────────────────────

describe("protocol framing", () => {
	test("encode produces exactly one newline-terminated envelope line", () => {
		const line = encodeMessage({ type: "ping", id: "p1" });
		expect(line.endsWith("\n")).toBe(true);
		expect(line.trimEnd().split("\n")).toHaveLength(1);
		expect(line).toContain('"__rlm":1');
	});

	test("round-trips a message", () => {
		const decoded = decodeMessage<{ type: string; id: string }>(encodeMessage({ type: "pong", id: "abc" }));
		expect(decoded).toMatchObject({ type: "pong", id: "abc" });
	});

	test("rejects non-envelope, malformed, and typeless lines", () => {
		expect(decodeMessage("plain subprocess output")).toBeNull();
		expect(decodeMessage('{"__rlm":1, broken json')).toBeNull();
		expect(decodeMessage(JSON.stringify({ __rlm: 1 }))).toBeNull();
		expect(decodeMessage(JSON.stringify({ __rlm: 2, type: "done" }))).toBeNull();
		expect(decodeMessage("")).toBeNull();
	});
});

// ── prompt ────────────────────────────────────────────────────────────────────

describe("system prompt", () => {
	test("states identity, cwd, depth, and the evaluator doctrine", () => {
		const prompt = buildRlmTsPrompt({ cwd: "/tmp/work", messagesPath: "/tmp/s.jsonl", depth: 0 });
		expect(prompt).toContain("general purpose agent that uses code");
		expect(prompt).toContain("/tmp/work");
		expect(prompt).toContain("/tmp/s.jsonl");
		expect(prompt).toContain("Recursive agent depth: 0");
		expect(prompt).toContain("Bun.$");
		expect(prompt).toContain("persist");
		// The reset notice is only useful if the model knows what to do with it:
		// re-verify before reuse, and above all before shell interpolation.
		expect(prompt).toContain("<rlm_engine_reset>");
		expect(prompt).toContain("re-verify");
		expect(prompt).toContain("shell command");
	});

	test("advertises npm: imports so the agent reaches for them before bun add", () => {
		const prompt = buildRlmTsPrompt({ cwd: "/tmp" });
		expect(prompt).toContain('import { z } from "npm:zod@4"');
		expect(prompt).toContain("isolated cache");
	});

	test("namespace hygiene doctrine: forget for cleanup, deferred values load on read", () => {
		const prompt = buildRlmTsPrompt({ cwd: "/tmp" });
		expect(prompt).toContain("rlm.forget(");
		expect(prompt).toContain("load automatically");
	});

	// Machinery without appetite goes unused: the doctrine must teach the
	// posture (fan out decomposable work by default), the blank-slate rule
	// (children get no context except the prompt), and the fan-in discipline
	// (check status before trusting output) — not just the spawn mechanics.
	test("subagent doctrine teaches fan-out posture, blank-slate children, and fan-in discipline", () => {
		const prompt = buildRlmTsPrompt({ cwd: "/w", allowRecursion: true });
		expect(prompt).toContain("Fan out by default");
		expect(prompt).toContain("wall time");
		expect(prompt).toMatch(/children start with no context/i);
		expect(prompt).toMatch(/check .*status/i);
	});

	// A hardcoded child default breaks every session whose auth cannot spawn
	// it, and a per-provider table has to be edited every time a provider
	// ships a new volume model. Volume tiers are named consistently across
	// the industry — haiku, luna, flash, mini, nano, lite — so resolution
	// pattern-matches those names against what is actually listed, in tier
	// order, and returns the exact listed id rather than a fuzzy alias.
	// Inherit is the fallback, valid by construction; the bare default only
	// applies when nothing is known and any guess fails equally.
	test("the subagent default pattern-matches every provider's volume tier", () => {
		expect(
			resolveDefaultSubagentModel({
				override: "openai/gpt-5-mini",
				available: ["openai/gpt-5.6-sol"],
				current: "openai/gpt-5.6-sol",
			}),
		).toBe("openai/gpt-5-mini");
		// The parent's provider anchors the choice: an openai parent gets luna
		// even with haiku listed, an anthropic parent gets haiku — children bill
		// and authenticate where the parent already lives.
		expect(
			resolveDefaultSubagentModel({
				available: ["openai/gpt-5.6-luna", "anthropic/claude-haiku-4-5", "openai/gpt-5.6-sol"],
				current: "openai/gpt-5.6-sol",
			}),
		).toBe("openai/gpt-5.6-luna");
		expect(
			resolveDefaultSubagentModel({
				available: ["openai/gpt-5.6-luna", "anthropic/claude-haiku-4-5", "anthropic/claude-fable-5"],
				current: "anthropic/claude-fable-5",
			}),
		).toBe("anthropic/claude-haiku-4-5");
		// A parent whose provider has no volume tier still gets a cheap child
		// from another available provider before inheriting flagship prices.
		expect(
			resolveDefaultSubagentModel({
				available: ["google/gemini-3-pro", "anthropic/claude-haiku-4-5"],
				current: "google/gemini-3-pro",
			}),
		).toBe("anthropic/claude-haiku-4-5");
		// Dated snapshots always have an undated alias; the alias wins.
		expect(
			resolveDefaultSubagentModel({
				available: ["anthropic/claude-haiku-4-5-20251001", "anthropic/claude-haiku-4-5"],
			}),
		).toBe("anthropic/claude-haiku-4-5");
		// OpenAI only: luna, not the parent's flagship.
		expect(
			resolveDefaultSubagentModel({
				available: ["openai/gpt-5.6-sol", "openai/gpt-5.6-luna", "openai/gpt-5.4-mini"],
				current: "openai/gpt-5.6-sol",
			}),
		).toBe("openai/gpt-5.6-luna");
		// No luna: the newest mini by natural version order, not string order.
		expect(
			resolveDefaultSubagentModel({
				available: ["openai/gpt-4o-mini", "openai/gpt-5.4-mini", "openai/gpt-5.6-sol"],
			}),
		).toBe("openai/gpt-5.4-mini");
		// Google's volume tier is found without a google table entry.
		expect(
			resolveDefaultSubagentModel({
				available: ["google/gemini-3-pro", "google/gemini-3-flash"],
				current: "google/gemini-3-pro",
			}),
		).toBe("google/gemini-3-flash");
		// The pattern must match the model id, never the provider name.
		expect(resolveDefaultSubagentModel({ available: ["minimax/frontier-xl"], current: "minimax/frontier-xl" })).toBe(
			"minimax/frontier-xl",
		);
		// Tokens are whole segments: gemini contains "mini" and is a flagship.
		expect(resolveDefaultSubagentModel({ available: ["google/gemini-3-pro"], current: "google/gemini-3-pro" })).toBe(
			"google/gemini-3-pro",
		);
		// Nothing cheap listed: inherit the parent.
		expect(resolveDefaultSubagentModel({ available: ["openai/gpt-5.6-sol"], current: "openai/gpt-5.6-sol" })).toBe(
			"openai/gpt-5.6-sol",
		);
		expect(resolveDefaultSubagentModel({ available: [] })).toBe("anthropic/haiku");
	});

	// The agent cannot pick a child model it has never heard of: the prompt
	// carries what is actually available (auth-configured), what the parent
	// itself runs, and the child default. The section must be byte-identical
	// for identical inputs regardless of input order — the system prompt is
	// cached, and a shifting list would invalidate the cache every turn.
	test("model options are seeded deterministically into the subagent doctrine", () => {
		const models = {
			current: "anthropic/claude-fable-5",
			subagentDefault: "anthropic/haiku",
			available: ["openai/gpt-5.2", "anthropic/claude-haiku-4-5", "anthropic/claude-opus-4-6"],
		};
		const prompt = buildRlmTsPrompt({ cwd: "/w", allowRecursion: true, models });
		expect(prompt).toContain("You are running anthropic/claude-fable-5.");
		expect(prompt).toContain("Children default to anthropic/haiku");
		expect(prompt).toContain("call `model_list` to enumerate them");
		expect(prompt).not.toContain("anthropic: claude-haiku-4-5, claude-opus-4-6");
		expect(prompt).not.toContain("openai/gpt-5.2");

		const shuffled = { ...models, available: [...models.available].reverse() };
		expect(buildRlmTsPrompt({ cwd: "/w", allowRecursion: true, models: shuffled })).toBe(prompt);

		// No models known: no section, not an empty shell.
		expect(buildRlmTsPrompt({ cwd: "/w", allowRecursion: true })).not.toContain("Available models");
	});

	test("subagent guidance appears only when recursion is allowed", () => {
		const withRecursion = buildRlmTsPrompt({ cwd: "/tmp", allowRecursion: true });
		expect(withRecursion).toContain("rlm.run");
		expect(withRecursion).toContain("Delegating to sub-agents");
		const without = buildRlmTsPrompt({ cwd: "/tmp", allowRecursion: false });
		expect(without).not.toContain("Delegating to sub-agents");
	});

	// Measured in the 2026-09 session audit: rlm.run children fanned out into
	// grandchildren and outlived a 600 s parent, while the peer `subagent` tool
	// with its escalation channel sat unused. The prompt must state the choice
	// and the two limits so the model does not learn them from a dead child.
	test("delegation prefers the subagent tool and states rlm.run's limits", () => {
		const prompt = buildRlmTsPrompt({ cwd: "/tmp", allowRecursion: true });
		expect(prompt).toContain("When `subagent` is on your tool list, delegate with it by default");
		expect(prompt).toContain("Use `rlm.run` only for small pure-data tasks inside a cell");
		expect(prompt).toContain("600 s by default (PI_RLM_SUBAGENT_TIMEOUT_MS)");
		expect(prompt).toContain("cannot spawn children of its own (PI_RLM_MAX_DEPTH)");
	});

	test("tools.call reach is stated as the seven bridged builtins", () => {
		const prompt = buildRlmTsPrompt({ cwd: "/tmp", toolSummaries: ["tools.read({ path: string }) — Read a file."] });
		expect(prompt).toContain(
			"`tools.call(name, args)` reaches only these seven bridged builtins (read, bash, edit, write, grep, find, ls)",
		);
		expect(prompt).toContain("Extension tools are not bridged: call them at the top level");
	});

	test("short tasks go to top-level tools directly, long tasks to the process tool when present", () => {
		const prompt = buildRlmTsPrompt({ cwd: "/tmp", hostToolSummaries: ["process — Manage background processes."] });
		expect(prompt).toContain("one or two top-level tool calls can finish does not need a cell");
		// The resident list is what the model sees; everything else must be
		// reachable, and the prompt has to say how, or the model will reimplement
		// a tool it cannot see inside a cell.
		expect(prompt).toContain("resident tools");
		expect(prompt).toContain("activate it with `load_tools`");
		expect(prompt).toContain("If a `process` tool is on your tool list");
		expect(prompt).toContain("wakes you on ready, error, or exit, so never sleep-poll");
		expect(prompt).toContain("Without that tool, start the work detached (`Bun.spawn`");
	});

	test("child doctrine appears only at depth > 0", () => {
		// "child agent" alone also appears in the subagent guidance; the doctrine's
		// identity sentence is the distinctive marker.
		expect(buildRlmTsPrompt({ cwd: "/tmp", depth: 0 })).not.toContain("You are a child agent");
		const child = buildRlmTsPrompt({ cwd: "/tmp", depth: 1 });
		expect(child).toContain("You are a child agent");
		expect(child).toContain("output file");
	});

	test("context files are appended verbatim under a project section", () => {
		const prompt = buildRlmTsPrompt({
			cwd: "/tmp",
			contextFiles: [{ path: "AGENTS.md", content: "PROJECT_RULE_MARKER" }],
		});
		expect(prompt).toContain("# Project Context");
		expect(prompt).toContain("AGENTS.md");
		expect(prompt).toContain("PROJECT_RULE_MARKER");
	});

	test("reads-are-full doctrine is stated", () => {
		const prompt = buildRlmTsPrompt({ cwd: "/tmp" });
		expect(prompt).toContain("Writes are surgical; reads are full");
		expect(prompt).toContain("read it start to finish");
		// The re-check shortcut dies with the first edit: an edited file must be
		// reread whole, because memory of edited files drifts fastest.
		expect(prompt).toContain("have not edited since");
	});

	test("host tools section appears only when summaries are supplied, with doctrine", () => {
		const withTools = buildRlmTsPrompt({
			cwd: "/tmp",
			toolSummaries: ["tools.read({ path: string }) — Read the contents of a file."],
		});
		expect(withTools).toContain("# Host tools");
		expect(withTools).toContain("tools.read({ path: string })");
		// The doctrine: edits over rewrites, tools.read for source/images, Bun.$ for shell.
		expect(withTools).toContain("tools.edit");
		expect(withTools).toContain("fails loudly");
		expect(withTools).toContain("Bun.$` remains the way to run shell commands");
		expect(buildRlmTsPrompt({ cwd: "/tmp" })).not.toContain("# Host tools");
	});

	test("no unresolved template placeholders leak into the prompt", () => {
		const prompt = buildRlmTsPrompt({ cwd: "/tmp", depth: 1 });
		expect(prompt).not.toContain("undefined");
		expect(prompt).not.toMatch(/\$\{/);
		// Every gated section rendered: a placeholder hiding in one of them would
		// pass the bare-prompt check above.
		const full = buildRlmTsPrompt({
			cwd: "/tmp",
			depth: 1,
			allowRecursion: true,
			toolSummaries: ["tools.read({ path: string }) — Read a file."],
			hostToolSummaries: ["process — Manage background processes.", "subagent — Spawn a peer."],
			models: { current: "a/c", subagentDefault: "a/b", available: ["a/b"] },
		});
		expect(full).not.toContain("undefined");
		expect(full).not.toMatch(/\$\{/);
	});
});

// ── render-core ───────────────────────────────────────────────────────────────

const ANSI = /\x1b\[[0-9;]*m/g;
const stripAnsi = (text: string) => text.replace(ANSI, "");

function testDeps(overrides: Partial<RenderDeps> = {}): RenderDeps {
	return {
		fg: (_color, text) => `\x1b[31m${text}\x1b[0m`,
		getBgAnsi: () => "\x1b[44m",
		highlight: (line) => `\x1b[32m${line}\x1b[0m`,
		keyHint: (expanded) => (expanded ? "ctrl+o to collapse" : "ctrl+o to expand"),
		visibleWidth: (text) => stripAnsi(text).length,
		truncateToWidth: (text, width, ellipsis = "") => {
			// ANSI-aware like the real primitive: keep escapes, count only visible
			// characters, and append the ellipsis when content was dropped.
			const plainLength = stripAnsi(text).length;
			if (plainLength <= width) return text;
			const budget = Math.max(0, width - stripAnsi(ellipsis).length);
			let visible = 0;
			let out = "";
			let index = 0;
			while (index < text.length) {
				const match = text.slice(index).match(/^\x1b\[[0-9;]*m/);
				if (match) {
					out += match[0];
					index += match[0].length;
					continue;
				}
				if (visible >= budget) break;
				out += text[index];
				visible += 1;
				index += 1;
			}
			return out + ellipsis;
		},
		wrapTextWithAnsi: (text, width) => {
			const plain = stripAnsi(text);
			if (plain.length <= width) return [text];
			const chunks: string[] = [];
			for (let i = 0; i < plain.length; i += width) chunks.push(plain.slice(i, i + width));
			return chunks;
		},
		now: () => 0,
		...overrides,
	};
}

function makeState(overrides: Partial<ExecuteRenderState> = {}): ExecuteRenderState {
	return {
		code: "const a = 1;\na + 1",
		details: { status: "ok", durationMs: 120, stdout: "hello\n", result: "2" },
		isPartial: false,
		isError: false,
		expanded: false,
		executionStarted: true,
		hasResult: true,
		...overrides,
	};
}

describe("render-core: helpers", () => {
	test("closeOpenSgr resets colors left open by wrapping", () => {
		expect(closeOpenSgr("\x1b[31mred")).toBe("\x1b[31mred\x1b[0m");
		expect(closeOpenSgr("\x1b[38;5;10mgreen")).toBe("\x1b[38;5;10mgreen\x1b[0m");
		expect(closeOpenSgr("\x1b[31mred\x1b[0m")).toBe("\x1b[31mred\x1b[0m");
		expect(closeOpenSgr("plain")).toBe("plain");
	});

	test("isShellish detects Bun.$ templates", () => {
		expect(isShellish("const out = await Bun.$`ls`.quiet();")).toBe(true);
		expect(isShellish("const out = 1;")).toBe(false);
	});

	test("formatDuration switches units at one second", () => {
		expect(formatDuration(undefined)).toBeUndefined();
		expect(formatDuration(120)).toBe("120ms");
		expect(formatDuration(999)).toBe("999ms");
		expect(formatDuration(1500)).toBe("1.5s");
	});

	test("statusKind and backgroundFor agree on every state", () => {
		expect(statusKind(makeState())).toBe("done");
		expect(statusKind(makeState({ isError: true }))).toBe("error");
		expect(statusKind(makeState({ details: { status: "aborted" } }))).toBe("aborted");
		expect(statusKind(makeState({ details: undefined, hasResult: false, isPartial: true }))).toBe("running");
		expect(statusKind(makeState({ details: undefined, hasResult: false, executionStarted: false }))).toBe("queued");

		expect(backgroundFor("done")).toBe("toolSuccessBg");
		expect(backgroundFor("error")).toBe("toolErrorBg");
		expect(backgroundFor("aborted")).toBe("toolErrorBg");
		expect(backgroundFor("running")).toBe("toolPendingBg");
		expect(backgroundFor("queued")).toBe("toolPendingBg");
	});
});

describe("render-core: layout", () => {
	test("collapsed renders exactly one row; expanded renders code and output", () => {
		const deps = testDeps();
		const collapsed = renderExecuteCell(makeState(), 80, deps);
		expect(collapsed).toHaveLength(1);

		const expanded = renderExecuteCell(makeState({ expanded: true }), 80, deps);
		expect(expanded.length).toBeGreaterThan(collapsed.length);
		const joined = stripAnsi(expanded.join("\n"));
		expect(joined).toContain("const a = 1;");
		expect(joined).toContain("hello");
	});

	test("every rendered line fits the pane width, at any width", () => {
		const deps = testDeps();
		const state = makeState({
			expanded: true,
			code: "const configurationSnapshotForRenderWidthProbe = { alpha: 1, beta: 2, gamma: 3, delta: 4, epsilon: 5 };",
			details: { status: "ok", durationMs: 90, stdout: "x".repeat(400), result: "y".repeat(200) },
		});
		for (const width of [20, 40, 80, 120, 200]) {
			for (const line of renderExecuteCell(state, width, deps)) {
				expect(stripAnsi(line).length).toBeLessThanOrEqual(width);
			}
		}
	});

	test("a long first line keeps the trailing metadata visible", () => {
		const deps = testDeps();
		const state = makeState({
			code: "const configurationSnapshotForRenderWidthProbe = { alpha: 1, beta: 2, gamma: 3, delta: 4, epsilon: 5 };",
		});
		// The preview absorbs truncation so the metadata suffix survives at any
		// width that can hold it; the preview is elided instead of the counts,
		// duration, and expand hint.
		for (const width of [80, 100, 140]) {
			const row = stripAnsi(renderExecuteCell(state, width, deps)[0]);
			expect(row).toContain("ctrl+o to expand");
			expect(row).toContain("120ms");
			expect(row).toContain("↑ 1");
			expect(row).toContain("const co");
			expect(row).toContain("…");
			expect(row.length).toBeLessThanOrEqual(width);
		}
	});

	test("status glyph and background track the cell status", () => {
		const deps = testDeps();
		expect(stripAnsi(renderExecuteCell(makeState(), 80, deps)[0])).toContain("✓");
		expect(stripAnsi(renderExecuteCell(makeState({ isError: true }), 80, deps)[0])).toContain("✗");
		const queued = makeState({ details: undefined, hasResult: false, executionStarted: false });
		expect(stripAnsi(renderExecuteCell(queued, 80, deps)[0])).toContain("◇");
	});

	test("line counts and duration appear in the collapsed row", () => {
		const deps = testDeps();
		const row = stripAnsi(renderExecuteCell(makeState(), 200, deps)[0]);
		expect(row).toContain("↑ 2");
		expect(row).toContain("lines");
		expect(row).toContain("120ms");
		expect(row).toContain("ctrl+o to expand");
	});

	test("error name and stack are surfaced", () => {
		const deps = testDeps();
		const state = makeState({
			expanded: true,
			isError: true,
			details: { status: "error", errorName: "RangeError", errorStack: ["RangeError: demo explosion", "  at cell"] },
		});
		const rendered = stripAnsi(renderExecuteCell(state, 120, deps).join("\n"));
		expect(rendered).toContain("RangeError");
		expect(rendered).toContain("demo explosion");
	});

	test("empty output says so; a running cell says it is waiting", () => {
		const deps = testDeps();
		const done = makeState({ expanded: true, details: { status: "ok", durationMs: 5 } });
		expect(stripAnsi(renderExecuteCell(done, 80, deps).join("\n"))).toContain("no output");
		const running = makeState({ expanded: true, details: undefined, hasResult: false, isPartial: true });
		expect(stripAnsi(renderExecuteCell(running, 80, deps).join("\n"))).toContain("waiting for output");
	});

	// Subagents render as a call stack growing out of the cell that spawned
	// them. A live stack asserts itself: while anything runs, the frames are
	// visible even on a collapsed cell — supervision should not require a
	// keypress. Once every frame settles, the stack folds into the header chip.
	test("a running stack is visible even collapsed; a settled stack folds to the chip", () => {
		const deps = testDeps();
		const frame = (status: "running" | "completed") => [
			{
				record: {
					rlm_child_id: "sub-a",
					name: "pdf-audit",
					prompt: "audit the pdfs",
					model: "anthropic/haiku",
					status,
					spawned_at: new Date(Date.now() - 5_000).toISOString(),
					spawn_cell_id: "cell-1",
				},
				children: [],
			},
		];
		const live = renderExecuteCell(makeState({ frames: frame("running") }), 200, deps).map(stripAnsi);
		expect(live[0]).toContain("1 subagent");
		expect(live[0]).toContain("1 running");
		expect(live.join("\n")).toContain("pdf-audit");
		expect(live.join("\n")).toContain('rlm.run("audit the pdfs")');

		const settled = renderExecuteCell(makeState({ frames: frame("completed") }), 200, deps).map(stripAnsi);
		expect(settled).toHaveLength(1);
		expect(settled[0]).toContain("1 subagent");

		const expanded = renderExecuteCell(makeState({ frames: frame("completed"), expanded: true }), 200, deps).map(
			stripAnsi,
		);
		expect(expanded.join("\n")).toContain("pdf-audit");
	});

	test("a cell without frames renders no subagent chip", () => {
		const deps = testDeps();
		expect(stripAnsi(renderExecuteCell(makeState(), 200, deps)[0])).not.toContain("subagent");
	});

	test("background is re-armed after inner SGR resets so it spans the row", () => {
		const deps = testDeps();
		const painted = paintBackground("\x1b[31mred\x1b[0mplain", 20, "done", deps);
		expect(painted.startsWith("\x1b[44m")).toBe(true);
		expect(painted.endsWith("\x1b[0m")).toBe(true);
		// Every reset inside the row must be followed by the background again.
		const resets = painted.split("\x1b[0m");
		for (const segment of resets.slice(1, -1)) expect(segment.startsWith("\x1b[44m")).toBe(true);
		expect(stripAnsi(painted)).toHaveLength(20);
	});
});

// ── subagents: validation and defaults ────────────────────────────────────────

describe("subagent host: validation", () => {
	const dirs: string[] = [];
	function host() {
		const dir = mkdtempSync(join(tmpdir(), "pi-rlm-units-"));
		dirs.push(dir);
		return createSubagentHost({
			cwd: dir,
			subagentDir: dir,
			defaultModel: "anthropic/haiku",
			depth: 0,
			maxDepth: 2,
			spawnCommand: () => ({ command: "sh", args: ["-c", "true"] }),
		});
	}

	test("rejects a missing or empty prompt", async () => {
		const h = host();
		await expect(h.handlers["rlm.run"]({})).rejects.toThrow(/prompt/i);
		await expect(h.handlers["rlm.run"]({ prompt: "   " })).rejects.toThrow(/prompt/i);
	});

	test("rejects a non-string name and an oversized name", async () => {
		const h = host();
		await expect(h.handlers["rlm.run"]({ prompt: "t", kwargs: { name: 42 } })).rejects.toThrow(/name/i);
		await expect(
			h.handlers["rlm.run"]({ prompt: "t", kwargs: { name: "x".repeat(MAX_SUBAGENT_NAME_LENGTH + 1) } }),
		).rejects.toThrow(new RegExp(String(MAX_SUBAGENT_NAME_LENGTH)));
	});

	test("falls back to the default model and reports it on the handle", async () => {
		const h = host();
		const handle = await h.handlers["rlm.run"]({ prompt: "task" });
		expect(handle.model).toBe("anthropic/haiku");
		const explicit = await h.handlers["rlm.run"]({ prompt: "task", kwargs: { model: "anthropic/opus-5" } });
		expect(explicit.model).toBe("anthropic/opus-5");
	});

	test("delete rejects an unknown target and requires a non-empty one", async () => {
		const h = host();
		await expect(h.handlers["rlm.delete_subagent"]({ target: "nope" })).rejects.toThrow(/no subagent/i);
		await expect(h.handlers["rlm.delete_subagent"]({ target: "  " })).rejects.toThrow(/non-empty/i);
	});

	test("delete accepts the session name as well as the id", async () => {
		const h = host();
		const handle = await h.handlers["rlm.run"]({ prompt: "task", kwargs: { name: "by-name" } });
		const deleted = await h.handlers["rlm.delete_subagent"]({ target: "by-name" });
		expect((deleted.subagent as { rlm_child_id: string }).rlm_child_id).toBe(handle.rlm_child_id as string);
	});

	test("default names are slugged, bounded, and collision-resistant", () => {
		const name = defaultSubagentName("Fix the PARSER bug!! (urgent)", "sub-abcdef123456");
		expect(name.startsWith("subagent-fix-the-parser-bug")).toBe(true);
		expect(name.length).toBeLessThanOrEqual(MAX_SUBAGENT_NAME_LENGTH);
		expect(defaultSubagentName("x".repeat(500), "sub-1").length).toBeLessThanOrEqual(MAX_SUBAGENT_NAME_LENGTH);
		expect(defaultSubagentName("", "sub-99999999")).toContain("worker");
		const a = defaultSubagentName("same prompt", "sub-aaaaaaaa");
		const b = defaultSubagentName("same prompt", "sub-bbbbbbbb");
		expect(a).not.toBe(b);
	});

	afterAll(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});
});

// ── tool tiers ────────────────────────────────────────────────────────────────

describe("resident tier resolution", () => {
	const registry = [
		"execute",
		"read",
		"bash",
		"rlm_mode",
		"todo",
		"ask_user_question",
		"recall",
		"model_list",
		"advisor",
		"compaction_continue_state",
		"load_tools",
	];

	test("the default resident list is used when the env is unset, with execute and load_tools always present", () => {
		const resident = resolveRlmResidentTools({});
		expect(resident).toEqual([...DEFAULT_RESIDENT_TOOLS]);
		for (const name of ALWAYS_RESIDENT_TOOLS) expect(resident).toContain(name);
	});

	test("PI_RLM_RESIDENT_TOOLS replaces the list but cannot remove execute or load_tools", () => {
		expect(resolveRlmResidentTools({ PI_RLM_RESIDENT_TOOLS: "advisor, todo" })).toEqual([
			"advisor",
			"todo",
			"execute",
			"load_tools",
		]);
		expect(resolveRlmResidentTools({ PI_RLM_RESIDENT_TOOLS: "" })).toEqual([...ALWAYS_RESIDENT_TOOLS]);
	});

	test("the resident surface is resident ∩ registered − drop, execute first; unregistered names are ignored", () => {
		const surface = resolveRlmResidentSurface(registry, { drop: resolveRlmDropSet({}) });
		// `process`, `intercom`, `web_search`, `fetch_content` are configured but not registered here.
		expect(surface).toEqual(["execute", "load_tools", "rlm_mode", "todo", "ask_user_question", "recall"]);
	});

	test("drop wins over resident for every tool except the forced pair", () => {
		const drop = resolveRlmDropSet({ PI_RLM_DROP_TOOLS: "todo,execute,load_tools" });
		const surface = resolveRlmResidentSurface(registry, { drop });
		expect(surface).not.toContain("todo");
		expect(surface).toContain("execute");
		expect(surface).toContain("load_tools");
	});

	test("extra always names (rlm-toggle's rlm_mode) are forced even when not resident", () => {
		const surface = resolveRlmResidentSurface(registry, {
			drop: resolveRlmDropSet({}),
			resident: ["todo"],
			always: [...ALWAYS_RESIDENT_TOOLS, "rlm_mode"],
		});
		expect(surface).toEqual(["execute", "load_tools", "rlm_mode", "todo"]);
	});

	// Pi keeps deferred loading only while the active set grows, so the per-turn
	// ensure must be a superset of what the model loaded, in the same order.
	test("the ensured surface keeps loaded tools in place and appends missing resident ones", () => {
		const drop = resolveRlmDropSet({});
		const active = ["execute", "load_tools", "todo", "model_list", "advisor"];
		const next = resolveRlmEnsuredSurface(active, registry, { drop });
		expect(next.slice(0, active.length)).toEqual(active);
		expect(next).toContain("ask_user_question");
		expect(next).toContain("recall");
	});

	test("the ensured surface removes dropped, bridged, and unregistered names but never a resident one", () => {
		const drop = resolveRlmDropSet({ PI_RLM_KEEP_BUILTINS: "1" });
		const active = ["execute", "read", "compaction_continue_state", "gone_tool", "todo"];
		const next = resolveRlmEnsuredSurface(active, registry, { drop });
		expect(next).not.toContain("read");
		expect(next).not.toContain("compaction_continue_state");
		expect(next).not.toContain("gone_tool");
		expect(next).toContain("todo");
		// A bridged builtin the operator made resident survives the bridged filter.
		const kept = resolveRlmEnsuredSurface(["execute", "read"], registry, { drop, resident: ["read"] });
		expect(kept).toContain("read");
	});

	test("an unchanged surface compares equal regardless of order", () => {
		expect(sameToolSet(["a", "b"], ["b", "a"])).toBe(true);
		expect(sameToolSet(["a", "b"], ["a"])).toBe(false);
		expect(sameToolSet(["a", "b"], ["a", "c"])).toBe(false);
	});
});

describe("load_tools catalog", () => {
	test("group names come from the package spec or, for generic sources, the extension file", () => {
		expect(toolGroupName({ source: "builtin", path: "<builtin:grep>" })).toBe("builtin");
		expect(toolGroupName({ source: "npm:pi-web-access", path: "/n/pi-web-access/dist/index.js" })).toBe(
			"pi-web-access",
		);
		expect(toolGroupName({ source: "npm:@juicesharp/rpiv-todo", path: "/n/x/index.ts" })).toBe("rpiv-todo");
		expect(toolGroupName({ source: "npm:@llamaindex/liteparse-pi-extension@latest", path: "/n/x.ts" })).toBe(
			"liteparse-pi-extension",
		);
		expect(toolGroupName({ source: "git:github.com/justhil/pi-image-gen", path: "/g/index.ts" })).toBe("pi-image-gen");
		expect(toolGroupName({ source: "https://github.com/catoncat/mcp-interactive-reader", path: "/g/e.ts" })).toBe(
			"mcp-interactive-reader",
		);
		expect(toolGroupName({ source: "auto", path: "/home/u/.pi/agent/extensions/model-manager.ts" })).toBe(
			"model-manager",
		);
		expect(toolGroupName({ source: "local", path: "/home/u/.pi/agent/extensions/herd/index.ts" })).toBe("herd");
		expect(toolGroupName(undefined)).toBe("other");
	});

	test("a catalog line is the first sentence, whitespace collapsed, clipped to the budget", () => {
		expect(summarizeForCatalog("List models. Use before switching.")).toBe("List models");
		expect(summarizeForCatalog("Send a message\nto another\n\nsession.")).toBe("Send a message to another session");
		const long = summarizeForCatalog(`${"word ".repeat(40)}end.`);
		expect(long.length).toBeLessThanOrEqual(CATALOG_SUMMARY_CHARS);
		expect(long.endsWith("…")).toBe(true);
		expect(summarizeForCatalog(undefined)).toBe("");
	});

	test("the catalog groups tools under sorted source headers and stays within budget", () => {
		const loadable = Array.from({ length: 30 }, (_, i) => ({
			name: `tool_${String(i).padStart(2, "0")}`,
			description: `${"Does something useful with a fairly long explanation ".repeat(3)}. More detail follows.`,
			sourceInfo: { source: `npm:pkg-${i % 5}`, path: "/n/index.ts" },
		}));
		const catalog = buildLoadToolsCatalog(loadable);
		const lines = catalog.split("\n");
		expect(lines.filter((line) => line.endsWith(":"))).toEqual(["pkg-0:", "pkg-1:", "pkg-2:", "pkg-3:", "pkg-4:"]);
		expect(lines).toHaveLength(35);
		// Budget: about 30 tools in roughly 600 tokens at ~4 chars per token.
		expect(catalog.length).toBeLessThanOrEqual(30 * (CATALOG_SUMMARY_CHARS + 20) + 5 * 8);
		expect(buildLoadToolsCatalog([])).toBe("");
	});
});

describe("load_tools selection", () => {
	const loadable = [
		{
			name: "model_list",
			description: "List all models.",
			sourceInfo: { source: "auto", path: "/e/model-manager.ts" },
		},
		{ name: "model_switch", description: "Switch model.", sourceInfo: { source: "auto", path: "/e/model-manager.ts" } },
		{ name: "advisor", description: "Escalate to a reviewer.", sourceInfo: { source: "npm:rpiv-advisor", path: "/n" } },
		...Array.from({ length: 8 }, (_, i) => ({
			name: `trail_${i}`,
			description: "Herd trail memo action.",
			sourceInfo: { source: "auto", path: "/e/herd-trail-tools.ts" },
		})),
	];

	test("names split into added, already active, and unknown without throwing", () => {
		const selection = selectToolsToLoad(
			{ names: ["model_list", "todo", "nope", "model_list"] },
			{ loadable, active: ["execute", "todo"] },
		);
		expect(selection).toEqual({ added: ["model_list"], alreadyActive: ["todo"], unknown: ["nope"], unmatched: [] });
	});

	test("group is matched case-insensitively and reports an empty group", () => {
		expect(selectToolsToLoad({ group: "Model-Manager" }, { loadable, active: [] }).added).toEqual([
			"model_list",
			"model_switch",
		]);
		expect(selectToolsToLoad({ group: "nothing" }, { loadable, active: [] }).unmatched).toEqual(['group "nothing"']);
	});

	test("query scores name and description terms and caps the result", () => {
		const byTerms = selectToolsToLoad({ query: "switch model" }, { loadable, active: [] });
		expect(byTerms.added[0]).toBe("model_switch");
		expect(byTerms.added).toContain("model_list");
		expect(byTerms.added).not.toContain("advisor");
		const capped = selectToolsToLoad({ query: "trail memo" }, { loadable, active: [] });
		expect(capped.added).toHaveLength(QUERY_MATCH_LIMIT);
		expect(selectToolsToLoad({ query: "zzz" }, { loadable, active: [] }).unmatched).toEqual(['query "zzz"']);
	});
});

describe("rlmCanTakeOver", () => {
	test("needs both the request and a registered execute tool", () => {
		expect(rlmCanTakeOver(true, ["execute", "ask_user_question"])).toBe(true);
		expect(rlmCanTakeOver(false, ["execute"])).toBe(false);
	});
	test("a launcher allowlist without execute keeps pi-rlm dormant even under PI_RLM_FORCE", () => {
		// pi-subagents' builtin worker: read, bash, … plus contact_supervisor; no execute.
		const workerAllowlist = ["read", "bash", "edit", "write", "grep", "find", "ls", "contact_supervisor"];
		expect(rlmCanTakeOver(true, workerAllowlist)).toBe(false);
	});
});

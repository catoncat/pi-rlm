/**
 * The tool-surface contract.
 *
 * Each test states one guarantee the tiered surface makes to pi's dynamic tool
 * loading. Pi records a purely additive setActiveTools made during a tool call
 * on that call's result and serves the added definitions through deferred
 * loading; any later removal falls back to the full list and breaks the cached
 * prefix. So the guarantees are about what is applied when: the session start
 * shrinks once, the loader only adds, and the per-turn hook never takes back
 * what the model loaded.
 *
 * Tests drive the real extension factory through a fake ExtensionAPI that
 * models pi's registry (registerTool refreshes and auto-activates, unknown
 * names in setActiveTools are ignored).
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import createExtension from "../src/extension/index.js";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
interface RegisteredTool {
	name: string;
	description: string;
	execute: (toolCallId: string, params: unknown, ...rest: unknown[]) => Promise<{ content: Array<{ text?: string }> }>;
}

/** Just enough of pi's ExtensionAPI for the surface hooks and load_tools. */
class FakePi {
	readonly handlers = new Map<string, Handler[]>();
	readonly tools = new Map<string, { tool: RegisteredTool; source: string; path: string }>();
	active: string[] = [];
	setActiveCalls: string[][] = [];
	messages: unknown[] = [];

	constructor(seed: Array<{ name: string; description?: string; source?: string; path?: string }>) {
		for (const entry of seed) this.seedTool(entry);
		this.active = [...this.tools.keys()];
	}

	seedTool(entry: { name: string; description?: string; source?: string; path?: string }) {
		this.tools.set(entry.name, {
			tool: {
				name: entry.name,
				description: entry.description ?? `${entry.name} does things.`,
				execute: async () => ({ content: [] }),
			},
			source: entry.source ?? "npm:fake-pkg",
			path: entry.path ?? `/ext/${entry.source ?? "fake-pkg"}/index.ts`,
		});
	}

	api(): ExtensionAPI {
		const self = this;
		return {
			registerFlag() {},
			getFlag: (name: string) => (name === "rlm" ? true : undefined),
			on(event: string, handler: Handler) {
				const list = self.handlers.get(event) ?? [];
				list.push(handler);
				self.handlers.set(event, list);
			},
			registerTool(tool: RegisteredTool) {
				const existed = self.tools.has(tool.name);
				self.tools.set(tool.name, { tool, source: "git:github.com/catoncat/pi-rlm", path: "/rlm/index.ts" });
				// pi's refreshTools auto-activates a newly registered name.
				if (!existed) self.active = [...self.active, tool.name];
			},
			getAllTools: () =>
				[...self.tools.values()].map(({ tool, source, path }) => ({
					name: tool.name,
					description: tool.description,
					parameters: {},
					sourceInfo: { path, source, scope: "user", origin: "package" },
				})),
			getActiveTools: () => [...self.active],
			setActiveTools(names: string[]) {
				const next = [...new Set(names.filter((name) => self.tools.has(name)))];
				self.setActiveCalls.push(next);
				self.active = next;
			},
			sendMessage(message: unknown) {
				self.messages.push(message);
			},
		} as unknown as ExtensionAPI;
	}

	async emit(event: string, payload: unknown, ctx: unknown): Promise<unknown[]> {
		const results: unknown[] = [];
		for (const handler of this.handlers.get(event) ?? []) results.push(await handler(payload, ctx));
		return results;
	}

	async callTool(name: string, params: unknown) {
		const entry = this.tools.get(name);
		if (!entry) throw new Error(`no tool ${name}`);
		return entry.tool.execute(`call-${name}`, params, undefined, undefined, this.ctx());
	}

	ctx() {
		return { cwd: cwd, sessionManager: { getSessionFile: () => undefined } };
	}
}

let cwd = "";
const cleanups: Array<() => Promise<void>> = [];

const REGISTRY = [
	{ name: "read", source: "builtin", path: "<builtin:read>" },
	{ name: "bash", source: "builtin", path: "<builtin:bash>" },
	{ name: "todo", description: "Manage a task list.", source: "npm:@juicesharp/rpiv-todo" },
	{ name: "ask_user_question", description: "Ask the user structured questions.", source: "npm:rpiv-ask" },
	{
		name: "model_list",
		description: "List all available providers and models registered in Pi.",
		source: "auto",
		path: "/home/u/.pi/agent/extensions/model-manager.ts",
	},
	{
		name: "model_switch",
		description: "Switch Pi to a different model/provider.",
		source: "auto",
		path: "/home/u/.pi/agent/extensions/model-manager.ts",
	},
	{ name: "advisor", description: "Escalate to a stronger reviewer.", source: "npm:@juicesharp/rpiv-advisor" },
	{ name: "compaction_continue_state", description: "Internal.", source: "npm:pi-compaction" },
];

async function startSession(seed = REGISTRY): Promise<FakePi> {
	cwd = mkdtempSync(join(tmpdir(), "pi-rlm-tiers-"));
	const fake = new FakePi(seed);
	createExtension(fake.api());
	// pi-rlm's own execute is registered by the factory; a real session has it
	// in the registry before session_start, which is what active() checks.
	await fake.emit("session_start", { type: "session_start", reason: "startup" }, fake.ctx());
	cleanups.push(async () => {
		await fake.emit("session_shutdown", { type: "session_shutdown" }, fake.ctx());
		rmSync(cwd, { recursive: true, force: true });
	});
	return fake;
}

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

// The extension reads its tiers from process.env; a developer's own shell (an
// RLM session exporting PI_RLM_DROP_TOOLS) must not change what is asserted.
const SURFACE_ENV = ["PI_RLM_DROP_TOOLS", "PI_RLM_RESIDENT_TOOLS", "PI_RLM_KEEP_BUILTINS"] as const;
const savedEnv = new Map<string, string | undefined>();
beforeAll(() => {
	for (const key of SURFACE_ENV) {
		savedEnv.set(key, process.env[key]);
		delete process.env[key];
	}
});
afterAll(() => {
	for (const key of SURFACE_ENV) {
		const value = savedEnv.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("tool surface: session start", () => {
	test("shrinks to the resident tier and registers load_tools with the loadable catalog", async () => {
		const fake = await startSession();
		expect(fake.active.sort()).toEqual(["ask_user_question", "execute", "load_tools", "todo"]);
		const loader = fake.tools.get("load_tools")?.tool;
		expect(loader).toBeDefined();
		// Catalog = registered − resident − drop − bridged, grouped by source.
		const description = loader?.description ?? "";
		expect(description).toContain("model-manager:");
		expect(description).toContain("model_list — List all available providers and models registered in Pi");
		expect(description).toContain("rpiv-advisor:");
		for (const excluded of ["todo", "ask_user_question", "compaction_continue_state", "read", "bash", "execute"]) {
			expect(description).not.toMatch(new RegExp(`^${excluded}( —|$)`, "m"));
		}
	});
});

describe("tool surface: load_tools", () => {
	test("adds by name without removing anything, and reports unknown names in text", async () => {
		const fake = await startSession();
		const before = [...fake.active];
		const result = await fake.callTool("load_tools", { names: ["model_list", "nope", "todo"] });
		const text = result.content.map((block) => block.text).join("\n");
		expect(text).toContain("Activated: model_list");
		expect(text).toContain("next turn");
		expect(text).toContain("Already active: todo");
		expect(text).toContain("Not loadable");
		expect(text).toContain("nope");
		const last = fake.setActiveCalls.at(-1) ?? [];
		for (const name of before) expect(last).toContain(name);
		expect(last).toContain("model_list");
	});

	test("dropped and bridged tools are not loadable even by exact name", async () => {
		const fake = await startSession();
		const result = await fake.callTool("load_tools", { names: ["compaction_continue_state", "read"] });
		const text = result.content.map((block) => block.text).join("\n");
		expect(text).toContain("Not loadable");
		expect(fake.active).not.toContain("read");
		expect(fake.active).not.toContain("compaction_continue_state");
	});

	test("query matches name and description keywords; a fully active request still succeeds", async () => {
		const fake = await startSession();
		const first = await fake.callTool("load_tools", { query: "switch model" });
		expect(first.content[0]?.text).toContain("Activated: model_switch, model_list");
		const again = await fake.callTool("load_tools", { query: "switch model" });
		expect(again.content[0]?.text).toContain("Already active: model_switch, model_list");
		expect(again.content[0]?.text).not.toContain("Activated:");
	});

	test("group activates every tool from one source", async () => {
		const fake = await startSession();
		const result = await fake.callTool("load_tools", { group: "model-manager" });
		expect(result.content[0]?.text).toContain("Activated: model_list, model_switch");
		expect(fake.active).toContain("model_switch");
	});
});

describe("tool surface: before_agent_start", () => {
	test("keeps a tool the model loaded and leaves the surface untouched when nothing is missing", async () => {
		const fake = await startSession();
		await fake.callTool("load_tools", { names: ["model_list"] });
		const callsBefore = fake.setActiveCalls.length;
		await fake.emit("before_agent_start", { type: "before_agent_start", systemPromptOptions: {} }, fake.ctx());
		expect(fake.active).toContain("model_list");
		expect(fake.setActiveCalls.length).toBe(callsBefore);
	});

	test("re-adds a missing resident tool without dropping loaded ones", async () => {
		const fake = await startSession();
		await fake.callTool("load_tools", { names: ["advisor"] });
		// A later handler collapsed the surface behind our back.
		fake.active = fake.active.filter((name) => name !== "todo");
		await fake.emit("before_agent_start", { type: "before_agent_start", systemPromptOptions: {} }, fake.ctx());
		expect(fake.active).toContain("todo");
		expect(fake.active).toContain("advisor");
		expect(fake.active).not.toContain("read");
	});

	test("the prompt names the resident tier only and points at load_tools for the rest", async () => {
		const fake = await startSession();
		await fake.callTool("load_tools", { names: ["advisor"] });
		const [result] = (await fake.emit(
			"before_agent_start",
			{ type: "before_agent_start", systemPromptOptions: {} },
			fake.ctx(),
		)) as Array<{ systemPrompt: string }>;
		expect(result.systemPrompt).toContain("todo, ask_user_question, load_tools");
		expect(result.systemPrompt).toContain("activate it with `load_tools`");
		expect(result.systemPrompt).not.toMatch(/^.*\badvisor\b.*$/m);
	});

	test("a tool registered after session start appears in the catalog on the next turn", async () => {
		const fake = await startSession();
		const stale = fake.tools.get("load_tools")?.tool.description ?? "";
		expect(stale).not.toContain("fff_find");
		fake.seedTool({ name: "fff_find", description: "Fuzzy find files.", source: "npm:@ff-labs/pi-fff" });
		// pi auto-activates a late registration; the ensure step keeps it, since
		// it cannot tell an extension's own activation from the model's.
		fake.active = [...fake.active, "fff_find"];
		await fake.emit("before_agent_start", { type: "before_agent_start", systemPromptOptions: {} }, fake.ctx());
		expect(fake.tools.get("load_tools")?.tool.description).toContain("fff_find — Fuzzy find files");
		expect(fake.active).toContain("fff_find");
	});
});

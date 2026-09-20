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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
	/** Session entries appended via appendEntry, as pi's branch would hold them. */
	entries: Array<{ type: string; customType: string; data: unknown }> = [];

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
			appendEntry(customType: string, data: unknown) {
				self.entries.push({ type: "custom", customType, data });
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
		return { cwd: cwd, sessionManager: { getSessionFile: () => undefined, getBranch: () => [...this.entries] } };
	}
}

let cwd = "";
const cleanups: Array<() => Promise<void>> = [];

const REGISTRY = [
	{ name: "read", source: "builtin", path: "<builtin:read>" },
	{ name: "bash", source: "builtin", path: "<builtin:bash>" },
	{ name: "edit", source: "builtin", path: "<builtin:edit>" },
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
const SURFACE_ENV = ["PI_RLM_DROP_TOOLS", "PI_RLM_RESIDENT_TOOLS", "PI_RLM_KEEP_BUILTINS", "PI_RLM_ALLOW_RUN"] as const;
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
		// edit is the one bridged builtin on the model surface (hybrid: also tools.edit);
		// read and bash stay cell-only.
		expect(fake.active.sort()).toEqual(["ask_user_question", "edit", "execute", "load_tools", "todo"]);
		const loader = fake.tools.get("load_tools")?.tool;
		expect(loader).toBeDefined();
		// Catalog = registered − resident − drop − bridged, grouped by source.
		const description = loader?.description ?? "";
		expect(description).toContain("model-manager:");
		expect(description).toContain("model_list — List all available providers and models registered in Pi");
		expect(description).toContain("rpiv-advisor:");
		for (const excluded of [
			"todo",
			"ask_user_question",
			"compaction_continue_state",
			"read",
			"bash",
			"edit",
			"execute",
		]) {
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

	test("a loaded tool is remembered on the session and comes back after the next session_start shrink", async () => {
		const fake = await startSession();
		await fake.callTool("load_tools", { names: ["model_list"] });
		expect(fake.active).toContain("model_list");
		expect(fake.entries.map((e) => e.customType)).toContain("pi-rlm-tools");
		// A reload/resume: pi fires session_start again and the surface shrinks —
		// but not below what the conversation already activated.
		await fake.emit("session_start", {}, fake.ctx());
		expect(fake.active).toContain("model_list");
		expect(fake.active).not.toContain("advisor");
	});

	test("a direct call to an unloaded tool activates it, remembers it, and steers the model to retry", async () => {
		const fake = await startSession();
		expect(fake.active).not.toContain("advisor");
		await fake.emit(
			"tool_execution_end",
			{
				toolCallId: "c1",
				toolName: "advisor",
				isError: true,
				result: { content: [{ type: "text", text: "Tool advisor not found" }] },
			},
			fake.ctx(),
		);
		expect(fake.active).toContain("advisor");
		expect(fake.entries.some((e) => e.customType === "pi-rlm-tools")).toBe(true);
		const steer = fake.messages.find((m) => (m as { customType?: string }).customType === "pi-rlm-tools") as
			| { content: string }
			| undefined;
		expect(steer?.content).toContain("advisor");
		expect(steer?.content).toContain("Call it again");
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
		expect(result.systemPrompt).toContain("edit, todo, ask_user_question, load_tools");
		expect(result.systemPrompt).toContain("`edit` at the top level is for small, exact text replacements");
		expect(result.systemPrompt).toContain("activate it with `load_tools`");
		expect(result.systemPrompt).not.toMatch(/^.*\badvisor\b.*$/m);
	});

	// The `rlm` handle is in every namespace, so the environment itself pulls the
	// model toward rlm.run even where a peer `subagent` tool exists (eval t08).
	// Registration alone — not activation — flips the decision, and the bridge
	// and the prompt flip together.
	test("a registered subagent tool disables rlm.run at the bridge and in the prompt", async () => {
		const fake = await startSession([
			...REGISTRY,
			{ name: "subagent", description: "Spawn a peer session.", source: "npm:pi-subagents" },
		]);
		expect(fake.active).not.toContain("subagent");
		const [result] = (await fake.emit(
			"before_agent_start",
			{ type: "before_agent_start", systemPromptOptions: {} },
			fake.ctx(),
		)) as Array<{ systemPrompt: string }>;
		expect(result.systemPrompt).toContain("`rlm.run` is disabled in this session");
		expect(result.systemPrompt).toContain("activate it with `load_tools`");
		expect(result.systemPrompt).not.toContain("Spawn with `const handle = await rlm.run");
		let thrown: unknown;
		await fake.callTool("execute", { code: 'await rlm.run("delegate this")' }).catch((error) => {
			thrown = error;
		});
		expect(String((thrown as Error | undefined)?.message)).toContain("rlm.run is disabled");
		expect(String((thrown as Error | undefined)?.message)).toContain('load_tools({ names: ["subagent"] })');
		// The rest of the handle is untouched.
		const listed = await fake.callTool("execute", { code: "(await rlm.listSubagents()).subagents.length" });
		expect(listed.content[0]?.text).toContain("0");
	}, 20_000);

	test("without a subagent tool the prompt teaches rlm.run", async () => {
		const fake = await startSession();
		const [result] = (await fake.emit(
			"before_agent_start",
			{ type: "before_agent_start", systemPromptOptions: {} },
			fake.ctx(),
		)) as Array<{ systemPrompt: string }>;
		expect(result.systemPrompt).toContain("Spawn with `const handle = await rlm.run");
		expect(result.systemPrompt).not.toContain("`rlm.run` is disabled in this session");
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

// The activity trail is for the person watching the transcript, not the
// model: it rides the result's details (and every partial update) into the
// renderer, while the content the model reads stays stdout/stderr/result.
describe("execute result: activity trail", () => {
	test("the trail is in details and partial updates, never in the model-visible content", async () => {
		const fake = await startSession();
		writeFileSync(join(cwd, "note.txt"), "alpha\n");
		const updates: Array<{ text: string; activity?: unknown[] }> = [];
		const result = (await fake.tools.get("execute")!.tool.execute(
			"call-execute",
			{
				code: [
					'await tools.read({ path: "note.txt" });',
					'await tools.edit({ path: "note.txt", edits: [{ oldText: "alpha", newText: "beta" }] });',
					"await Bun.$`echo shell-line`;",
					'"trail-done"',
				].join("\n"),
			},
			undefined,
			(update: { content: Array<{ type: string; text?: string }>; details?: { activity?: unknown[] } }) =>
				updates.push({ text: update.content[0]?.text ?? "", activity: update.details?.activity }),
			fake.ctx(),
		)) as { content: Array<{ type: string; text?: string }>; details: { activity?: Array<{ name: string }> } };
		// What the model sees: the echoed shell output and the result, nothing else.
		const text = result.content.map((block) => block.text ?? "").join("\n");
		expect(text).toBe('shell-line\n\n"trail-done"');
		expect(text).not.toContain("note.txt");
		expect(text).not.toContain("read");
		// What the renderer sees.
		expect(result.details.activity?.map((entry) => entry.name)).toEqual(["read", "edit", "bash"]);
		// Live: the read was reported before the cell finished, and later
		// updates (the streamed echo) still carry the trail rather than dropping it.
		expect(updates[0]?.activity?.length).toBe(1);
		const streamed = updates.find((update) => update.text.includes("shell-line"));
		expect(streamed?.activity?.length).toBeGreaterThanOrEqual(2);
		for (let i = 1; i < updates.length; i++) {
			expect(updates[i]!.activity?.length ?? 0).toBeGreaterThanOrEqual(updates[i - 1]!.activity?.length ?? 0);
		}
	}, 20_000);
});

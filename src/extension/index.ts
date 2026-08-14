/**
 * pi-rlm: RLM engine for pi.
 *
 * Primary LLM-facing tool: `execute`, running TypeScript in a persistent Bun
 * evaluator. File builtins are bridged as tools.* inside that evaluator.
 * Local keep-all (see keep-tools.ts) also leaves extension host tools
 * model-visible so session UI and delegation keep working under RLM.
 */

import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { EngineBusyError, EngineManager } from "../engine/index.js";
import { createPiToolsHost, type PiToolsHost } from "./pi-tools.js";
import { resolveRlmActiveTools, resolveRlmDropSet, summarizeHostTool } from "./keep-tools.js";
import { buildRlmTsPrompt, type RlmPromptModels, type RlmPromptSkill } from "./prompt.js";
import { ExecuteCellComponent, type ExecuteDetails, type ExecuteRenderState, makeFrameSource } from "./render.js";
import { EngineLifecycle, summarizeNames } from "./session-engine.js";
import { createSubagentHost, resolveDefaultSubagentModel, type SubagentHost } from "./subagents.js";

const executeSchema = Type.Object({
	code: Type.String({
		description: "TypeScript to execute in the persistent Bun evaluator.",
	}),
	// DSH Code Mode parity: a one-line summary rides the cell record into
	// the dispatch ledger; it is never executed.
	description: Type.Optional(
		Type.String({
			description:
				"Short summary of what this program does. Recorded with the cell for dispatch-log reconstruction and error attribution.",
		}),
	),
});

function syncRenderState(
	state: Partial<ExecuteRenderState>,
	context: {
		args?: { code?: string };
		isPartial: boolean;
		isError: boolean;
		expanded: boolean;
		executionStarted: boolean;
	},
): ExecuteRenderState {
	state.code = context.args?.code ?? state.code ?? "";
	state.isPartial = context.isPartial;
	state.isError = context.isError;
	state.expanded = context.expanded;
	state.executionStarted = context.executionStarted;
	state.hasResult = state.hasResult ?? false;
	return state as ExecuteRenderState;
}

/** Stack lines kept when surfacing a cell error to the model. */
const ERROR_STACK_LINES = 10;

/** Header plus stack — without repeating the header when the stack already starts with it. */
function composeErrorLines(error: { name: string; message: string; stack: string[] }): string[] {
	const header = `${error.name}: ${error.message}`;
	const stack = error.stack.slice(0, ERROR_STACK_LINES);
	return stack[0]?.trim() === header ? stack : [header, ...stack];
}

const SUBAGENT_MODEL_OVERRIDE = process.env.PI_RLM_SUBAGENT_MODEL;
const DEPTH = Number(process.env.PI_RLM_DEPTH ?? "0");
const MAX_DEPTH = Number(process.env.PI_RLM_MAX_DEPTH ?? "2");
/** Set by the parent's spawn: this agent's own id, linking its frames upward. */
const SELF_CHILD_ID = process.env.PI_RLM_CHILD_ID;

export default function (pi: ExtensionAPI) {
	pi.registerFlag("rlm", {
		type: "boolean",
		description: "Single execute tool backed by a persistent TypeScript evaluator; replaces the default tool surface",
	});
	// CLI flag values are injected after extension factories run (verified by
	// probe: getFlag is undefined here, true in every event), so activation is
	// decided per event, never at load. PI_RLM_FORCE is the dev escape hatch:
	// subagent children and test rigs activate without flag plumbing.
	const active = () => pi.getFlag("rlm") === true || process.env.PI_RLM_FORCE === "1";

	let subagents: SubagentHost | undefined;
	let piTools: PiToolsHost | undefined;
	// A tool error must be thrown for pi to mark the call as failed, but pi's
	// loop rebuilds thrown errors as bare text results, discarding details and
	// content — and with them the collapsed header's metadata and any images a
	// bridged tool produced before the cell failed. Stash both at throw time
	// and re-attach them in the tool_result hook below.
	const pendingErrorResults = new Map<
		string,
		{ details: ExecuteDetails; images: Array<{ type: "image"; data: string; mimeType: string }> }
	>();
	// Where the engine will be built from, captured by whichever event runs first.
	let location = { cwd: process.cwd(), sessionFile: undefined as string | undefined };
	// The model landscape for the prompt, computed at the first agent start and
	// held for the session: the system prompt is cached, and recomputing a list
	// that may shift (registry refresh, auth changes) would invalidate that
	// cache on every turn. A new session starts fresh.
	let modelsSeed: RlmPromptModels | undefined;
	// Resolved against actual availability the first time a context offers the
	// registry; a hardcoded default would break every session whose auth cannot
	// spawn it. Falls back sensibly until then (engines can be created before
	// any event carries the registry).
	let subagentDefault = resolveDefaultSubagentModel({ override: SUBAGENT_MODEL_OVERRIDE, available: [] });

	const resolveModels = (ctx: {
		model?: { provider: string; id: string } | undefined;
		modelRegistry?: { getAvailable(): Array<{ provider: string; id: string }> };
	}): void => {
		if (modelsSeed || !ctx.modelRegistry) return;
		const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		const available = ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`);
		subagentDefault = resolveDefaultSubagentModel({ override: SUBAGENT_MODEL_OVERRIDE, available, current });
		modelsSeed = { current, subagentDefault, available };
	};

	const lifecycle = new EngineLifecycle<EngineManager>({
		create() {
			const { cwd, sessionFile } = location;
			const sessionKey = sessionFile ? basename(sessionFile).replace(/\.jsonl$/, "") : undefined;
			const stateDir = join(cwd, ".pi-rlm", sessionKey ?? "ephemeral");
			subagents = createSubagentHost({
				cwd,
				subagentDir: join(stateDir, "subagents"),
				defaultModel: subagentDefault,
				depth: DEPTH,
				maxDepth: MAX_DEPTH,
				selfChildId: SELF_CHILD_ID,
			});
			piTools = createPiToolsHost({ cwd });
			return new EngineManager({
				cwd,
				hostHandlers: { ...subagents.handlers, ...piTools.handlers },
				// A snapshot is keyed to a session file; an ephemeral session has none
				// to key it to, so its namespace lives and dies with the process.
				snapshot: sessionKey ? { path: join(stateDir, "namespace.snapshot") } : undefined,
				// DSH Code Mode parity: every bridged host request leaves one
				// durable JSONL line for post-hoc reconstruction.
				dispatchLog: sessionKey ? { path: join(stateDir, "dispatch.jsonl") } : undefined,
			});
		},
		async dispose(engine) {
			subagents?.killAll();
			subagents = undefined;
			await engine.dispose();
		},
		// A wedged guest cannot answer the snapshot request dispose would send
		// (it would stall for the full request timeout, then fail anyway), so a
		// discard kills outright and relies on the last completed snapshot.
		async discard(engine) {
			subagents?.killAll();
			subagents = undefined;
			await engine.kill();
		},
	});

	// Replace pi's default prompt wholesale. It describes read, bash, and edit
	// tools that this configuration does not register, and a prompt that
	// advertises absent tools is worse than no prompt at all.
	pi.on("before_agent_start", async (event, ctx) => {
		// Dormant: pi's default prompt stands, and it is correct — the builtin
		// tools it describes are actually registered in this configuration.
		if (!active()) return undefined;
		resolveModels(ctx);
		// Re-assert keep-all each turn so later before_agent_start handlers that
		// append themselves (ask_user_question, advisor) still see a full base,
		// and so a mid-session setActiveTools collapse cannot stick.
		const drop = resolveRlmDropSet();
		const all = pi.getAllTools();
		const activeNames = resolveRlmActiveTools(
			all.map((t) => t.name),
			{ drop, always: ["execute"] },
		);
		pi.setActiveTools(activeNames);
		const hostToolSummaries = all
			.filter((t) => t.name !== "execute" && activeNames.includes(t.name))
			.map(summarizeHostTool);
		// Everything pi resolved for this turn's prompt. Narrowing this cast to
		// contextFiles alone is how skills went missing: pi loads them, offers
		// them here, and a prompt that replaces pi's own must pass them on or
		// they are silently dropped. Read the whole payload, decide nothing
		// about which skills qualify — that is pi's config and each skill's
		// disable-model-invocation flag.
		const options = (
			event as {
				systemPromptOptions?: {
					contextFiles?: Array<{ path: string; content: string }>;
					skills?: readonly RlmPromptSkill[];
				};
			}
		).systemPromptOptions;
		return {
			systemPrompt: buildRlmTsPrompt({
				cwd: ctx.cwd,
				messagesPath: ctx.sessionManager.getSessionFile() ?? undefined,
				depth: DEPTH,
				allowRecursion: DEPTH < MAX_DEPTH,
				contextFiles: options?.contextFiles,
				skills: options?.skills,
				// Fresh definitions for the prompt: signatures come from the same
				// schemas the bridge validates against, so they cannot drift.
				toolSummaries: createPiToolsHost({ cwd: ctx.cwd }).describe(),
				hostToolSummaries,
				models: modelsSeed,
			}),
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!active()) {
			// registerTool ran at load (the flag was unreadable then), so a stock
			// session must actively drop execute from the surface to stay stock.
			pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "execute"));
			return;
		}
		// Active: keep extension tools model-visible; drop bridged builtins
		// (available as tools.* inside execute) plus a short extra exclude list.
		const drop = resolveRlmDropSet();
		pi.setActiveTools(
			resolveRlmActiveTools(
				pi.getAllTools().map((t) => t.name),
				{ drop, always: ["execute"] },
			),
		);
		// A new session may run under different auth or a different model.
		modelsSeed = undefined;
		// Resolve before the engine is built below, so the subagent host is
		// created with the availability-aware default, not the fallback.
		resolveModels(ctx);
		// Revive a previous run's namespace before the first cell. This is the
		// expected path, but never the only one: pi skips session_start on reload
		// for extensions like this one, so the engine also revives itself when a
		// cell has to build it. See session-engine.ts.
		location = { cwd: ctx.cwd, sessionFile: ctx.sessionManager.getSessionFile() ?? undefined };
		const { restore } = await lifecycle.acquire("startup");
		if (restore && restore.restored.length > 0) {
			pi.sendMessage({
				customType: "pi-rlm-restore",
				content: `Revived ${restore.restored.length} variable(s) from the previous run: ${summarizeNames(restore.restored, 8)}${
					restore.failed.length > 0
						? `. Failed: ${summarizeNames(
								restore.failed.map((f) => f.name),
								8,
							)}`
						: ""
				}`,
				display: true,
			});
		}
	});

	pi.on("session_shutdown", async () => {
		await lifecycle.shutdown();
	});

	pi.on("tool_result", async (event) => {
		if (event.toolName !== "execute") return undefined;
		const stashed = pendingErrorResults.get(event.toolCallId);
		pendingErrorResults.delete(event.toolCallId);
		if (!stashed || !event.isError) return undefined;
		// Images ride along: a tool that read a PNG succeeded even if the cell
		// later threw, and the model should still see what it read.
		return { content: [...event.content, ...stashed.images], details: stashed.details, isError: true };
	});

	pi.registerTool<typeof executeSchema, ExecuteDetails, Partial<ExecuteRenderState>>({
		name: "execute",
		label: "execute",
		description:
			"Execute TypeScript in a persistent Bun evaluator. Variables, imports, and loaded data persist across calls. " +
			"Top-level await works. Shell: const out = await Bun.$`cmd`.quiet(); out.stdout.toString(). " +
			"pi's file tools are mounted as tools.* (tools.read, tools.edit, tools.grep, ...). " +
			"Subagents: await rlm.run(prompt) returns an admission handle; the child's answer lands in handle.output_file. " +
			"Only what you print or the cell's final expression returns comes back to the model — curate it. " +
			"Pass an optional `description` (one-line summary) so dispatch logs say what the program was for. " +
			"The final expression of the cell is returned as the result.",
		parameters: executeSchema,
		renderShell: "self",
		renderCall(args, theme, context) {
			const state = syncRenderState(context.state, { ...context, args });
			// The tool call id is the cell id is the spawn frame: a cell that can
			// spawn gets a frame source keyed by its own id. Cells that never
			// mention rlm.run skip the disk entirely.
			const framesSource = args?.code?.includes("rlm.run")
				? makeFrameSource(context.cwd, context.toolCallId)
				: undefined;
			return new ExecuteCellComponent(state, theme, framesSource, context.invalidate);
		},
		renderResult(result, options, _theme, context) {
			const state = syncRenderState(context.state, context);
			state.hasResult = true;
			state.isPartial = options.isPartial;
			state.expanded = options.expanded;
			state.details = (result.details as ExecuteDetails | undefined) ?? state.details;
			state.contentText = result.content
				?.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			// The call slot renders the whole cell; the result slot contributes nothing.
			return { render: () => [], invalidate: () => {} };
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (!active()) {
				throw new Error("pi-rlm is dormant in this session. Start pi with --rlm (or PI_RLM_FORCE=1) to use execute.");
			}
			if (ctx?.cwd) location = { cwd: ctx.cwd, sessionFile: ctx.sessionManager?.getSessionFile?.() ?? undefined };
			// Building the engine here means the previous one went away mid-session;
			// acquire revives it and arms the notice this cell will carry.
			const { engine: m } = await lifecycle.acquire("cell");
			try {
				// Accumulate: partial updates must only ever grow, or the TUI row height
				// oscillates with each replacing chunk (visible as jumping).
				let streamed = "";
				const r = await m.execute(params.code, {
					signal,
					// One identity end to end: the transcript's toolCallId is the
					// engine's cell id is the spawn_cell_id in frame records.
					cellId: toolCallId,
					description: params.description,
					onStream: (chunk) => {
						streamed += chunk;
						onUpdate?.({ content: [{ type: "text", text: streamed }], details: {} });
					},
				});
				// A reset notice leads, so the model reads that its namespace was
				// rebuilt before it reads output produced against the rebuilt one.
				// The session_start chat message is not enough: mid-work it scrolls
				// past, and the loss only shows up as a variable reading undefined.
				const sections = [lifecycle.takeResetNotice(), r.stdout, r.stderr, r.result];
				const errorLines = r.error ? composeErrorLines(r.error) : undefined;
				if (r.status === "error" && errorLines) sections.push(errorLines.join("\n"));
				if (r.status === "aborted") sections.push("[cell aborted]");
				const text = sections.filter((section) => section !== undefined && section !== "").join("\n");
				// Images from bridged tool calls cross host-side: the guest saw a
				// count, the model sees the pixels.
				const images = piTools?.drainImages() ?? [];

				const details: ExecuteDetails = {
					status: r.status,
					durationMs: r.durationMs,
					errorName: r.error?.name,
					stdout: r.stdout || undefined,
					stderr: r.stderr || undefined,
					result: r.result,
					errorStack: errorLines,
					stdoutTruncated: r.stdoutTruncated,
					stderrTruncated: r.stderrTruncated,
					resultTruncated: r.resultTruncated,
					outputLimitReached: r.outputLimitReached,
					cellDescription: params.description,
				};
				const result = {
					content: [
						{ type: "text" as const, text: text || "(no output)" },
						...images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
					],
					details,
				};
				if (r.status === "error") {
					pendingErrorResults.set(toolCallId, {
						details,
						images: images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
					});
					// A wall-clock timeout means the guest may still be executing the
					// cancelled cell (especially synchronous loops). Kill it immediately;
					// never let shutdown attempt a snapshot against a possibly wedged guest.
					if (r.error?.name === "CellTimeoutError") await lifecycle.discard();
					throw new Error(text || "(no output)");
				}
				return result;
			} catch (error) {
				if (error instanceof EngineBusyError) {
					// Recovery is this handler's job, not the model's: keeping the
					// wedged engine cached would make every later cell fail the same
					// way. Discard it; the next cell acquires a fresh engine revived
					// from the last completed snapshot and carries the reset notice.
					await lifecycle.discard();
					throw new Error(
						"The evaluator was wedged by a previously interrupted cell and has been killed. " +
							"Run the next cell to get a fresh evaluator revived from the last snapshot; " +
							"anything newer than that snapshot is gone, so re-verify variables before reusing them.",
					);
				}
				throw error;
			}
		},
	});
}

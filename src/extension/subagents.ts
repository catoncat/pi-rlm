/**
 * Subagent host handlers: `rlm.run` / `rlm.list_subagents` / `rlm.delete_subagent`.
 *
 * Spawning returns as soon as the child is admitted, never when it is done: a
 * parent that blocked on its children could not supervise them, and a handle is
 * useful immediately while an answer is not. Results therefore arrive through
 * the filesystem — each child's final output is written to
 * `<subagentDir>/<child_id>.output.md` — and the registry reports whether a
 * child is running, completed, or errored so the parent can decide when to read.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostRequestHandlers } from "../engine/index.js";
import type { FrameRecord } from "./frames.js";

export type SubagentStatus = "running" | "completed" | "error";

export interface SubagentEntry {
	rlm_child_id: string;
	session_name: string;
	session_dir: string;
	output_file: string;
	model: string;
	status: SubagentStatus;
	exit_code: number | null;
	pid: number | undefined;
}

export interface SubagentHostOptions {
	cwd: string;
	/** Directory for child session files and output files. */
	subagentDir: string;
	/** provider/model for children unless kwargs.model overrides. */
	defaultModel: string;
	/** Recursion depth of THIS agent; children get depth + 1. */
	depth: number;
	maxDepth: number;
	/**
	 * The id the parent assigned THIS agent (PI_RLM_CHILD_ID), stamped into
	 * every frame record it writes so grandchildren link back to it. Absent at
	 * the root: its frames are linked by spawn cell alone.
	 */
	selfChildId?: string;
	/** Override the spawned command for tests. Receives the fully built args. */
	spawnCommand?: (entry: SubagentEntry, prompt: string) => { command: string; args: string[] };
}

export const MAX_SUBAGENT_NAME_LENGTH = 64;

/**
 * Volume-tier names, in preference order. Fan-out economics only work at
 * volume prices — inheriting the parent would run children at flagship rates
 * while a 25x cheaper model sits in the same account (sol at $5/$30 vs luna
 * at $0.20/$1.20 per MTok) — and the industry names its volume tiers
 * consistently enough that matching the name beats maintaining a per-provider
 * table that goes stale with every model launch. Ordered best-for-fan-out
 * first: the dedicated volume flagships, then the mini/nano/lite ladders.
 * Tokens match whole hyphen/dot-delimited segments: "mini" must find
 * gpt-5.4-mini and never gemini-3-pro, whose name merely contains the letters.
 */
const VOLUME_TIER_PATTERNS = ["haiku", "luna", "flash", "mini", "nano", "lite"].map(
	(token) => new RegExp(`(^|[-.])${token}($|[-.])`),
);

/** Dated snapshots always have an undated alias; the alias is the stable name. */
const DATED_SNAPSHOT = /-\d{8}$/;

/**
 * What children run when rlm.run names no model. A hardcoded default breaks
 * every session whose auth cannot spawn it, so the choice degrades: explicit
 * override, then the parent provider's own volume tier — children bill and
 * authenticate where the parent already lives — then any provider's volume
 * tier, then the parent's own model, valid by construction. Matching runs
 * against the model id, never the provider; newest wins by natural version
 * order. The bare fallback only applies when nothing is known, where any
 * guess fails equally.
 */
export function resolveDefaultSubagentModel(options: {
	override?: string;
	available: string[];
	current?: string;
}): string {
	if (options.override) return options.override;
	const candidates = options.available.filter((entry) => !DATED_SNAPSHOT.test(entry));
	const slash = options.current?.indexOf("/") ?? -1;
	const parentProvider = slash > 0 ? options.current?.slice(0, slash) : undefined;
	const pools = parentProvider
		? [candidates.filter((entry) => entry.startsWith(`${parentProvider}/`)), candidates]
		: [candidates];
	for (const pool of pools) {
		for (const pattern of VOLUME_TIER_PATTERNS) {
			const matches = pool.filter((entry) => pattern.test(entry.slice(entry.indexOf("/") + 1)));
			if (matches.length > 0) {
				return matches.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0] as string;
			}
		}
	}
	return options.current ?? "anthropic/haiku";
}

export function defaultSubagentName(prompt: string, childId: string): string {
	const slug = prompt
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const suffix = childId.replace(/[^a-z0-9]/gi, "").slice(-8) || "child";
	const fixed = "subagent--".length + suffix.length;
	const promptPart = (slug || "worker").slice(0, Math.max(1, MAX_SUBAGENT_NAME_LENGTH - fixed)).replace(/-+$/g, "");
	return `subagent-${promptPart || "worker"}-${suffix}`;
}

export interface SubagentHost {
	handlers: HostRequestHandlers;
	entries(): SubagentEntry[];
	killAll(): void;
}

function resolveSubagentTimeoutMs(): number {
	const raw = process.env.PI_RLM_SUBAGENT_TIMEOUT_MS;
	if (raw === undefined || raw === "") return 600_000; // 10 minutes
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0) return 600_000;
	return n;
}

export function createSubagentHost(options: SubagentHostOptions): SubagentHost {
	const registry = new Map<string, SubagentEntry>();
	const children = new Map<string, ReturnType<typeof spawn>>();
	const lifetimeTimers = new Map<string, ReturnType<typeof setTimeout>>();
	// Deleting a running child races its exit event: SIGTERM fires "exit" after
	// the delete handler already removed the frame file, and an unguarded exit
	// write would resurrect it. Discarding routes all later writes to nowhere.
	const discardFrame = new Map<string, () => void>();

	function toPublicEntry(entry: SubagentEntry): Record<string, unknown> {
		// One name for one concept: rlm.run replies with `name`, so the registry
		// must too — a poll that matches on `entry.name` has to work. (It did
		// not, and the resulting waits timed out silently instead of detecting
		// completion.)
		return {
			rlm_child_id: entry.rlm_child_id,
			name: entry.session_name,
			session_dir: entry.session_dir,
			output_file: entry.output_file,
			model: entry.model,
			status: entry.status,
		};
	}

	const handlers: HostRequestHandlers = {
		"rlm.run": async (payload, context) => {
			const prompt = payload.prompt;
			if (typeof prompt !== "string" || prompt.trim().length === 0) {
				throw new Error("rlm.run prompt must be a non-empty string");
			}
			if (options.depth + 1 > options.maxDepth) {
				throw new Error(`rlm.run refused: recursion depth limit (${options.maxDepth}) reached`);
			}
			const kwargs = (payload.kwargs ?? {}) as Record<string, unknown>;
			const requestedName = kwargs.name;
			if (requestedName !== undefined && typeof requestedName !== "string") {
				throw new Error("rlm.run name must be a string");
			}
			if (typeof requestedName === "string" && requestedName.length > MAX_SUBAGENT_NAME_LENGTH) {
				throw new Error(`rlm.run name must be at most ${MAX_SUBAGENT_NAME_LENGTH} characters`);
			}
			const model = typeof kwargs.model === "string" && kwargs.model ? kwargs.model : options.defaultModel;

			const childId = `sub-${randomUUID()}`;
			const name = requestedName?.trim() || defaultSubagentName(prompt, childId);
			mkdirSync(options.subagentDir, { recursive: true });
			const outputFile = join(options.subagentDir, `${childId}.output.md`);

			const entry: SubagentEntry = {
				rlm_child_id: childId,
				session_name: name,
				session_dir: options.subagentDir,
				output_file: outputFile,
				model,
				status: "running",
				exit_code: null,
				pid: undefined,
			};

			// The frame record is the durable half of the registry: rendering,
			// cross-process lineage, and post-mortem inspection all read this file,
			// so it exists from admission and is finalized in place on exit.
			const framePath = join(options.subagentDir, `${childId}.json`);
			const frame: FrameRecord = {
				rlm_child_id: childId,
				name,
				prompt,
				model,
				status: "running",
				spawned_at: new Date().toISOString(),
				...(context?.cellId ? { spawn_cell_id: context.cellId } : {}),
				...(options.selfChildId ? { parent_child_id: options.selfChildId } : {}),
			};
			let frameDiscarded = false;
			discardFrame.set(childId, () => {
				frameDiscarded = true;
				try {
					rmSync(framePath, { force: true });
				} catch {}
			});
			const writeFrame = (): void => {
				if (frameDiscarded) return;
				try {
					writeFileSync(framePath, JSON.stringify(frame));
				} catch {
					// A frame that cannot be written costs the stack view, not the spawn.
				}
			};

			const spec = options.spawnCommand
				? options.spawnCommand(entry, prompt)
				: {
						command: "pi",
						args: [
							"-p",
							"--no-extensions",
							"-e",
							join(import.meta.dirname, "index.ts"),
							"--provider",
							model.includes("/") ? model.slice(0, model.indexOf("/")) : "anthropic",
							"--model",
							model.includes("/") ? model.slice(model.indexOf("/") + 1) : model,
							"--session-dir",
							options.subagentDir,
							"--name",
							name,
							prompt,
						],
					};

			const outFd = openSync(outputFile, "w");
			const child = spawn(spec.command, spec.args, {
				cwd: options.cwd,
				detached: false,
				stdio: ["ignore", outFd, outFd],
				// PI_RLM_FORCE activates the child regardless of flag plumbing: the
				// child loads this extension via -e and must enter the RLM world
				// without depending on --rlm surviving pi's argv handling.
				// PI_RLM_CHILD_ID tells the child its own id, so the frame records it
				// writes for grandchildren carry the link back to this one.
				env: {
					...process.env,
					PI_RLM_DEPTH: String(options.depth + 1),
					PI_RLM_FORCE: "1",
					PI_RLM_CHILD_ID: childId,
				},
			});
			closeSync(outFd);
			entry.pid = child.pid;
			frame.pid = child.pid;
			writeFrame();
			registry.set(childId, entry);
			children.set(childId, child);

			const clearLifetime = () => {
				const timer = lifetimeTimers.get(childId);
				if (timer) clearTimeout(timer);
				lifetimeTimers.delete(childId);
			};

			const maxLifeMs = resolveSubagentTimeoutMs();
			if (maxLifeMs > 0) {
				const timer = setTimeout(() => {
					const live = children.get(childId);
					if (!live) return;
					// Hard deadline so a stuck child cannot pin the parent forever.
					live.kill("SIGTERM");
					setTimeout(() => {
						if (children.has(childId)) live.kill("SIGKILL");
					}, 5_000).unref?.();
					entry.status = "error";
					entry.exit_code = entry.exit_code ?? 124;
					// Keep the durable half in step with the registry: a child killed
					// on deadline must not stay "running" in the frame view.
					frame.status = "error";
					frame.exit_code = entry.exit_code;
					frame.finished_at = new Date().toISOString();
					writeFrame();
				}, maxLifeMs);
				timer.unref?.();
				lifetimeTimers.set(childId, timer);
			}

			child.on("exit", (code) => {
				clearLifetime();
				entry.exit_code = code;
				entry.status = code === 0 ? "completed" : "error";
				frame.status = entry.status;
				frame.exit_code = code;
				frame.finished_at = new Date().toISOString();
				writeFrame();
				children.delete(childId);
			});
			child.on("error", () => {
				clearLifetime();
				entry.status = "error";
				frame.status = "error";
				frame.finished_at = new Date().toISOString();
				writeFrame();
				children.delete(childId);
			});

			// Admission: return the handle immediately; results land in output_file.
			return {
				rlm_child_id: childId,
				name,
				session_dir: options.subagentDir,
				output_file: outputFile,
				model,
			};
		},

		"rlm.list_subagents": async () => {
			return { subagents: [...registry.values()].map(toPublicEntry) };
		},

		"rlm.delete_subagent": async (payload) => {
			const target = typeof payload.target === "string" ? payload.target.trim() : "";
			if (!target) throw new Error("rlm.delete_subagent target must be a non-empty string");
			const entry =
				registry.get(target) ?? [...registry.values()].find((candidate) => candidate.session_name === target);
			if (!entry) throw new Error(`rlm.delete_subagent: no subagent matches "${target}"`);
			const child = children.get(entry.rlm_child_id);
			const life = lifetimeTimers.get(entry.rlm_child_id);
			if (life) {
				clearTimeout(life);
				lifetimeTimers.delete(entry.rlm_child_id);
			}
			if (child) {
				child.kill("SIGTERM");
				children.delete(entry.rlm_child_id);
				entry.status = "error";
			}
			registry.delete(entry.rlm_child_id);
			// Deletion means gone everywhere the registry speaks: the frame record
			// goes with the entry, so the stack view cannot resurrect it.
			discardFrame.get(entry.rlm_child_id)?.();
			discardFrame.delete(entry.rlm_child_id);
			return { subagent: toPublicEntry(entry) };
		},
	};

	return {
		handlers,
		entries: () => [...registry.values()],
		killAll: () => {
			for (const timer of lifetimeTimers.values()) clearTimeout(timer);
			lifetimeTimers.clear();
			for (const child of children.values()) child.kill("SIGKILL");
			children.clear();
		},
	};
}

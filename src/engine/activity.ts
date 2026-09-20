/**
 * Per-cell activity trail: what a cell touched through the bridge (tools.*)
 * and the shell (Bun.$).
 *
 * Under RLM a single cell can read three files, edit two, and run a command,
 * and the transcript shows one collapsed block. Native mode shows six tool
 * calls with a path on each. The trail closes that gap for the renderer only:
 * it rides ExecuteResult.activity into the cell's details and never into the
 * text the model sees, so following along costs the context nothing.
 */

import { isAbsolute, relative, resolve } from "node:path";

export interface ActivityEntry {
	/** `tool` for a bridged tools.* call, `shell` for a Bun.$ command. */
	kind: "tool" | "shell";
	/** Tool name (read, edit, bash, …); shell entries are named `bash` too, so the renderer merges them. */
	name: string;
	/** The path, pattern, or command that identifies what was touched. */
	target?: string;
	ok: boolean;
	durationMs?: number;
	/** Shell commands and failed tools.bash calls carry the process exit code. */
	exitCode?: number;
}

/** Past this many entries a cell records one `+N more` tail instead of growing details without bound. */
export const MAX_ACTIVITY_ENTRIES = 40;
/** Commands are identity, not transcript: the head is enough to recognise one. */
export const ACTIVITY_COMMAND_CHARS = 60;

export function clipCommand(command: string): string {
	const oneLine = command.replace(/\s+/g, " ").trim();
	return oneLine.length <= ACTIVITY_COMMAND_CHARS ? oneLine : `${oneLine.slice(0, ACTIVITY_COMMAND_CHARS - 1)}…`;
}

/** A path as the user would type it from cwd; paths outside cwd stay as given. */
export function displayPath(path: string, cwd: string): string {
	const rel = relative(cwd, resolve(cwd, path));
	if (rel === "") return ".";
	return rel.startsWith("..") || isAbsolute(rel) ? path : rel;
}

/** Which argument identifies the target of each bridged tool. */
const TOOL_TARGET_ARG: Record<string, "path" | "pattern" | "command"> = {
	read: "path",
	edit: "path",
	write: "path",
	ls: "path",
	grep: "pattern",
	find: "pattern",
	bash: "command",
};

export function describeToolTarget(name: string, args: unknown, cwd: string): string | undefined {
	const key = TOOL_TARGET_ARG[name];
	if (!key || !args || typeof args !== "object") return undefined;
	const value = (args as Record<string, unknown>)[key];
	if (typeof value !== "string" || value === "") return undefined;
	if (key === "path") return displayPath(value, cwd);
	if (key === "command") return clipCommand(value);
	return value;
}

/** pi's bash tool reports a non-zero exit only in its error message. */
export function exitCodeFromBashError(message: string | undefined): number | undefined {
	const match = message?.match(/Command exited with code (\d+)/);
	return match ? Number(match[1]) : undefined;
}

/** Bounded, append-only trail for one cell. */
export class ActivityLog {
	private readonly entries: ActivityEntry[] = [];
	private overflow = 0;

	get isEmpty(): boolean {
		return this.entries.length === 0;
	}

	push(entry: ActivityEntry): void {
		if (this.entries.length >= MAX_ACTIVITY_ENTRIES) {
			this.overflow += 1;
			return;
		}
		this.entries.push(entry);
	}

	/** A fresh array every call: consumers hand it to a renderer that diffs by identity/serialisation. */
	snapshot(): ActivityEntry[] {
		if (this.overflow === 0) return [...this.entries];
		return [...this.entries, { kind: "tool", name: "…", target: `+${this.overflow} more`, ok: true }];
	}
}

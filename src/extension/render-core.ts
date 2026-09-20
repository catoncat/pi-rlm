/**
 * Pure layout logic for the `execute` cell renderer.
 *
 * Deliberately free of pi imports so it is unit-testable outside pi's runtime:
 * theme, syntax highlighting, key hints, and width primitives are injected.
 * `render.ts` binds the real implementations.
 */

import type { ActivityEntry } from "../engine/activity.js";

export interface ExecuteDetails {
	status?: "ok" | "error" | "aborted" | string;
	durationMs?: number;
	errorName?: string;
	stdout?: string;
	stderr?: string;
	result?: string;
	errorStack?: string[];
	/** Truncation and budget flags from the engine (DSH output-limit parity). */
	stdoutTruncated?: boolean;
	stderrTruncated?: boolean;
	resultTruncated?: boolean;
	outputLimitReached?: boolean;
	/** The cell's optional one-line description, for display. */
	cellDescription?: string;
	/** What the cell touched (tools.* and Bun.$), for the collapsed summary and expanded list. */
	activity?: ActivityEntry[];
}

export interface ExecuteRenderState {
	code: string;
	details?: ExecuteDetails;
	contentText?: string;
	isPartial: boolean;
	isError: boolean;
	expanded: boolean;
	executionStarted: boolean;
	hasResult: boolean;
	/** Subagents this cell spawned, treed by lineage; the cell is frame #0. */
	frames?: FrameNode[];
}

import { previewCell } from "./preview-core.js";
import { type FrameNode, formatFrameSummary, renderFrames, summarizeFrames } from "./stack-core.js";

export type StatusKind = "error" | "aborted" | "running" | "queued" | "done";
export type BgKind = "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

export interface RenderDeps {
	fg(color: string, text: string): string;
	getBgAnsi(bg: BgKind): string;
	highlight(line: string): string;
	keyHint(expanded: boolean): string;
	visibleWidth(text: string): number;
	truncateToWidth(text: string, width: number, ellipsis: string): string;
	wrapTextWithAnsi(text: string, width: number): string[];
	/** Injected for deterministic spinner frames in tests. */
	now?(): number;
}

const OUTPUT_INDENT = "  ";
const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"];
/** Sits under the header's language label: leading space, marker, space. */
const ACTIVITY_INDENT = "   ";
/** Beyond this many targets per tool the rest fold into `+N`. */
const ACTIVITY_TARGETS_SHOWN = 3;

export function formatDuration(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined) return undefined;
	if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
	return `${(durationMs / 1000).toFixed(1)}s`;
}

export function isShellish(line: string): boolean {
	return line.includes("Bun.$`");
}

const SGR_PATTERN = /\x1b\[([0-9;]*)m/g;

/**
 * Append a reset when `line` ends with a foreground or background color still
 * open, so a span that wrapping split across lines cannot bleed into the
 * trailing padding or the next row.
 */
export function closeOpenSgr(line: string): string {
	let fgOpen = false;
	let bgOpen = false;
	for (const match of line.matchAll(SGR_PATTERN)) {
		const params = match[1] === "" ? ["0"] : (match[1] ?? "").split(";");
		for (let i = 0; i < params.length; i++) {
			const code = Number(params[i]);
			if (code === 0) {
				fgOpen = false;
				bgOpen = false;
			} else if (code === 38 || code === 48) {
				// Skip the payload of 38;5;n / 38;2;r;g;b so a component (e.g. 38)
				// is not read as another SGR code.
				if (code === 38) fgOpen = true;
				else bgOpen = true;
				const mode = Number(params[i + 1]);
				i += mode === 2 ? 4 : mode === 5 ? 2 : 1;
			} else if (code === 39) {
				fgOpen = false;
			} else if (code === 49) {
				bgOpen = false;
			} else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
				fgOpen = true;
			} else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
				bgOpen = true;
			}
		}
	}
	return fgOpen || bgOpen ? `${line}\x1b[0m` : line;
}

// ── activity ─────────────────────────────────────────────────────────────────

export interface ActivityGroup {
	name: string;
	/** Distinct targets in first-seen order; a file read in three chunks is one file. */
	targets: string[];
	count: number;
	/** Failures that carry no exit code — a thrown tool, a refused edit. */
	failed: number;
	/** Non-zero exit codes and how often each occurred, in first-seen order. */
	nonZeroExits: Array<{ code: number; count: number }>;
}

/** Group by tool name in first-appearance order; shell and tools.bash both arrive named `bash`. */
export function groupActivity(activity: readonly ActivityEntry[]): ActivityGroup[] {
	const groups = new Map<string, ActivityGroup>();
	for (const entry of activity) {
		let group = groups.get(entry.name);
		if (!group) {
			group = { name: entry.name, targets: [], count: 0, failed: 0, nonZeroExits: [] };
			groups.set(entry.name, group);
		}
		group.count += 1;
		if (entry.target && !group.targets.includes(entry.target)) group.targets.push(entry.target);
		if (entry.exitCode !== undefined && entry.exitCode !== 0) {
			const exit = group.nonZeroExits.find((e) => e.code === entry.exitCode);
			if (exit) exit.count += 1;
			else group.nonZeroExits.push({ code: entry.exitCode, count: 1 });
		} else if (!entry.ok) {
			group.failed += 1;
		}
	}
	return [...groups.values()];
}

/**
 * `read src/a.ts, src/b.ts · edit src/a.ts · bash ×2 (exit 2 ×1)` — plain
 * text, so tests can read it and the coloured variant below can wrap it.
 */
export function formatActivitySummary(activity: readonly ActivityEntry[]): string {
	return groupActivity(activity)
		.map((group) => activityGroupParts(group).join(""))
		.join(" · ");
}

/** [name, failure mark, detail] — split so the coloured line can tint each piece. */
function activityGroupParts(group: ActivityGroup): [string, string, string] {
	const mark = group.failed > 0 ? "✗" : "";
	if (group.name === "bash") {
		const exits =
			group.nonZeroExits.length > 0
				? group.nonZeroExits.map((e) => `exit ${e.code} ×${e.count}`).join(", ")
				: group.failed < group.count
					? "exit 0"
					: "";
		return [group.name, mark, ` ×${group.count}${exits ? ` (${exits})` : ""}`];
	}
	const shown = group.targets.slice(0, ACTIVITY_TARGETS_SHOWN);
	const rest = group.targets.length - shown.length;
	if (rest > 0) shown.push(`+${rest}`);
	return [group.name, mark, shown.length > 0 ? ` ${shown.join(", ")}` : ""];
}

function activityLine(activity: readonly ActivityEntry[], width: number, deps: RenderDeps): string {
	const separator = deps.fg("dim", " · ");
	const text = groupActivity(activity)
		.map((group) => {
			const [name, mark, detail] = activityGroupParts(group);
			const failing = mark !== "" || group.nonZeroExits.length > 0;
			return (
				deps.fg("muted", name) +
				(mark ? deps.fg("error", mark) : "") +
				(detail ? deps.fg(failing && group.name === "bash" ? "error" : "dim", detail) : "")
			);
		})
		.join(separator);
	// Same ending as the header preview: the line absorbs its own overflow.
	return deps.truncateToWidth(`${ACTIVITY_INDENT}${text}`, width, "…");
}

function renderActivityList(
	activity: readonly ActivityEntry[],
	lines: string[],
	width: number,
	deps: RenderDeps,
): void {
	lines.push("");
	const nameWidth = Math.max(...activity.map((entry) => entry.name.length));
	for (const entry of activity) {
		const failed = !entry.ok;
		const columns = [entry.name.padEnd(nameWidth), entry.target ?? "", formatDuration(entry.durationMs) ?? ""];
		if (entry.exitCode !== undefined && entry.exitCode !== 0) columns.push(`exit ${entry.exitCode}`);
		const text = columns.filter((column) => column !== "").join("  ");
		lines.push(deps.truncateToWidth(` ${OUTPUT_INDENT}${deps.fg(failed ? "error" : "muted", text)}`, width, "…"));
	}
}

export function statusKind(state: ExecuteRenderState): StatusKind {
	const status = state.details?.status;
	if (state.isError || status === "error") return "error";
	if (status === "aborted") return "aborted";
	if (!state.isPartial && (status !== undefined || state.hasResult)) return "done";
	if (state.isPartial || state.executionStarted) return "running";
	return "queued";
}

export function backgroundFor(kind: StatusKind): BgKind {
	if (kind === "error" || kind === "aborted") return "toolErrorBg";
	if (kind === "done") return "toolSuccessBg";
	return "toolPendingBg";
}

function marker(state: ExecuteRenderState, deps: RenderDeps): string {
	switch (statusKind(state)) {
		case "error":
			return deps.fg("error", "✗");
		case "aborted":
			return deps.fg("warning", "✗");
		case "done":
			return deps.fg("success", "✓");
		case "running": {
			const now = deps.now?.() ?? Date.now();
			return deps.fg("accent", SPINNER_FRAMES[Math.floor(now / 160) % SPINNER_FRAMES.length]);
		}
		default:
			return deps.fg("muted", "◇");
	}
}

function highlightLine(line: string, deps: RenderDeps): string {
	return isShellish(line) ? deps.fg("accent", line) : deps.highlight(line);
}

function outputText(state: ExecuteRenderState): string {
	const details = state.details;
	if (details && (details.stdout || details.stderr || details.result)) {
		return [details.stdout, details.stderr, details.result]
			.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
			.join("\n");
	}
	return state.contentText?.trim() ?? "";
}

function topLine(state: ExecuteRenderState, width: number, deps: RenderDeps): string {
	const code = state.code.trimEnd();
	const preview = previewCell(code);
	const language = preview.kind === "shell" ? "rlm · shell" : preview.kind === "agent" ? "rlm · agent" : "rlm";
	const prefix = `${marker(state, deps)} ${deps.fg("muted", language)}`;

	// Fixed metadata after the preview — these must always survive; the preview
	// absorbs all truncation.
	const suffixParts: string[] = [];

	// Counts settle-only: live-updating them mid-stream jitters the header.
	if (!state.isPartial && statusKind(state) !== "running") {
		const inputLines = code.split("\n").filter((line) => line.trim().length > 0).length;
		const output = outputText(state);
		const outputLines = output ? output.split("\n").length : 0;
		const counts: string[] = [];
		if (inputLines > 0) counts.push(`↑ ${inputLines}`);
		if (outputLines > 0) counts.push(`↓ ${outputLines}`);
		if (counts.length > 0) suffixParts.push(deps.fg("muted", `${counts.join(" ")} lines`));
	}

	const duration = formatDuration(state.details?.durationMs);
	if (duration) suffixParts.push(deps.fg("muted", duration));

	// The collapsed stack: the header names what the cell delegated even when
	// the frames themselves are folded away.
	if (state.frames && state.frames.length > 0) {
		const summary = summarizeFrames(state.frames);
		suffixParts.push(deps.fg(summary.failed > 0 ? "error" : "muted", formatFrameSummary(summary)));
	}

	const errorName = !state.isPartial ? state.details?.errorName : undefined;
	if (errorName) {
		// "RangeError: demo explosion" beats a bare "RangeError" when it fits;
		// the message is usually the fact the reader wants.
		const summary = state.details?.errorStack?.[0];
		suffixParts.push(deps.fg("error", summary && deps.visibleWidth(summary) <= 48 ? summary : errorName));
	}

	suffixParts.push(deps.keyHint(state.expanded));

	const separator = deps.fg("dim", " · ");
	const separatorWidth = deps.visibleWidth(separator);
	const suffix = suffixParts.join(separator);
	// Budget: total width minus leading space, prefix, suffix, and the two
	// separators around the preview slot.
	const fixed = 1 + deps.visibleWidth(prefix) + separatorWidth + deps.visibleWidth(suffix);
	const previewBudget = Math.max(8, width - fixed - separatorWidth);

	// A semantic preview (a command, a task, a file effect) is not TypeScript;
	// syntax-highlighting it would lie about what it is. Accent it instead.
	const middle = preview.text
		? deps.truncateToWidth(
				preview.kind === "ts" ? deps.highlight(preview.text) : deps.fg("accent", preview.text),
				previewBudget,
				"…",
			)
		: !state.executionStarted
			? deps.fg("muted", "waiting for code")
			: "";

	return [prefix, ...(middle ? [middle] : []), suffix].join(separator);
}

function addWrapped(lines: string[], prefix: string, text: string, width: number, deps: RenderDeps): void {
	const available = Math.max(1, width - 1 - deps.visibleWidth(prefix));
	const wrapped = deps.wrapTextWithAnsi(text, available);
	for (const [index, line] of (wrapped.length > 0 ? wrapped : [""]).entries()) {
		const linePrefix = index === 0 ? prefix : " ".repeat(deps.visibleWidth(prefix));
		lines.push(deps.truncateToWidth(` ${linePrefix}${closeOpenSgr(line)}`, width, ""));
	}
}

function renderCode(state: ExecuteRenderState, lines: string[], width: number, deps: RenderDeps): boolean {
	const code = state.code.trimEnd();
	if (!code) return false;
	lines.push("");
	for (const [index, rawLine] of code.split("\n").entries()) {
		const prefix = index === 0 ? deps.fg("dim", "› ") : deps.fg("dim", "  ");
		addWrapped(lines, prefix, highlightLine(rawLine, deps) || " ", width, deps);
	}
	return true;
}

function renderOutput(
	state: ExecuteRenderState,
	lines: string[],
	width: number,
	hasCode: boolean,
	deps: RenderDeps,
): void {
	const details = state.details;
	let outputStarted = false;
	const startOutput = () => {
		if (outputStarted) return;
		outputStarted = true;
		if (hasCode) lines.push("");
	};

	const sections: Array<{ text: string | undefined; color: string }> = [
		{ text: details?.stdout, color: "toolOutput" },
		{ text: details?.stderr, color: "muted" },
		{ text: details?.result, color: "toolOutput" },
	];
	let renderedText = false;
	for (const { text, color } of sections) {
		if (!text?.trim()) continue;
		startOutput();
		renderedText = true;
		for (const line of text.split("\n")) addWrapped(lines, OUTPUT_INDENT, deps.fg(color, line || " "), width, deps);
	}

	if (!renderedText && !details && state.contentText?.trim()) {
		startOutput();
		renderedText = true;
		const color = state.isError ? "muted" : "toolOutput";
		for (const line of state.contentText.trim().split("\n")) {
			addWrapped(lines, OUTPUT_INDENT, deps.fg(color, line || " "), width, deps);
		}
	}

	if (details?.errorStack && details.errorStack.length > 0) {
		startOutput();
		for (const line of details.errorStack) addWrapped(lines, OUTPUT_INDENT, deps.fg("muted", line || " "), width, deps);
	} else if (!renderedText) {
		startOutput();
		const message = state.isPartial || statusKind(state) === "running" ? "waiting for output..." : "no output";
		addWrapped(lines, OUTPUT_INDENT, deps.fg("muted", message), width, deps);
	}
}

/** Paint the status-matched panel background across the row, surviving inner SGR resets. */
export function paintBackground(line: string, width: number, kind: StatusKind, deps: RenderDeps): string {
	const bgAnsi = deps.getBgAnsi(backgroundFor(kind));
	const padded = line + " ".repeat(Math.max(0, width - deps.visibleWidth(line)));
	const rearmed = padded.replaceAll("\x1b[0m", `\x1b[0m${bgAnsi}`);
	return `${bgAnsi}${rearmed}\x1b[0m`;
}

export function renderExecuteCell(state: ExecuteRenderState, width: number, deps: RenderDeps): string[] {
	const safeWidth = Math.max(1, width);
	const lines = [deps.truncateToWidth(` ${topLine(state, safeWidth, deps)}`, safeWidth, "")];
	// What the cell touched. Collapsed: one summary line under the header, so
	// a reader can follow without expanding; absent entirely when nothing was
	// touched, so a pure-computation cell keeps its one-row height. Expanded:
	// the full list after the output instead, one action per line.
	const activity = state.details?.activity;
	if (activity && activity.length > 0 && !state.expanded) lines.push(activityLine(activity, safeWidth, deps));
	if (state.expanded) {
		const hasCode = renderCode(state, lines, safeWidth, deps);
		renderOutput(state, lines, safeWidth, hasCode, deps);
		if (activity && activity.length > 0) renderActivityList(activity, lines, safeWidth, deps);
	}
	// The stack grows out of the cell that spawned it: one line per frame,
	// beneath the output, indented by depth. A live stack asserts itself —
	// while anything runs the frames show even on a collapsed cell, because
	// supervision should not require a keypress. Settled stacks fold into the
	// header chip.
	if (state.frames && state.frames.length > 0 && (state.expanded || summarizeFrames(state.frames).running > 0)) {
		lines.push("");
		// Frames are laid out one column narrower than the pane: the leading
		// space added here would otherwise push a full-width line over the edge
		// and the outer truncate would eat its ellipsis.
		for (const line of renderFrames(state.frames, safeWidth - 1, deps)) {
			lines.push(deps.truncateToWidth(` ${line}`, safeWidth, ""));
		}
	}
	const kind = statusKind(state);
	return lines.map((line) => paintBackground(line, safeWidth, kind, deps));
}

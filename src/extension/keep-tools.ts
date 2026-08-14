/**
 * RLM model-visible tool surface: keep-all with a short drop list.
 *
 * Upstream collapses the LLM surface to `execute` alone. Local installs that
 * register session tools (ask_user_question, advisor, subagent, …) need those
 * tools to stay model-visible — cell code cannot open TUI dialogs or own the
 * parent session. File builtins stay off the model list by default because the
 * execute bridge already mounts them as tools.* inside the evaluator.
 *
 * PI_RLM_DROP_TOOLS   comma-separated extra names to drop (replaces the default
 *                     extra list when set, including empty string = extras none)
 * PI_RLM_KEEP_BUILTINS=1  also keep read/bash/edit/… on the model surface
 */

/** Mounted inside the evaluator as tools.*; dropped from the model list by default. */
export const BRIDGED_BUILTIN_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
] as const;

/**
 * Default extras: internal/meta tools that waste schema or fight RLM.
 * Keep this list short — new extension tools should appear automatically.
 */
export const DEFAULT_EXTRA_DROP_TOOLS = [
	"compaction_continue_state",
	"watchdog_answer",
] as const;

export function resolveRlmDropSet(env: NodeJS.ProcessEnv = process.env): Set<string> {
	const raw = env.PI_RLM_DROP_TOOLS;
	const extras =
		raw !== undefined
			? raw
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean)
			: [...DEFAULT_EXTRA_DROP_TOOLS];
	const drop = new Set<string>(extras);
	if (env.PI_RLM_KEEP_BUILTINS !== "1") {
		for (const name of BRIDGED_BUILTIN_TOOLS) drop.add(name);
	}
	return drop;
}

/**
 * Build the active tool list for an RLM session.
 * `always` names are forced on when present in `allToolNames` (execute, and
 * locally rlm_mode). Everything else is kept unless it is in the drop set.
 * `execute` is sorted first when present so the primary surface stays obvious.
 */
export function resolveRlmActiveTools(
	allToolNames: readonly string[],
	options?: { drop?: ReadonlySet<string>; always?: readonly string[] },
): string[] {
	const drop = options?.drop ?? resolveRlmDropSet();
	const always = options?.always ?? ["execute"];
	const alwaysSet = new Set(always);
	const available = new Set(allToolNames);
	const out: string[] = [];
	const seen = new Set<string>();

	const push = (name: string) => {
		if (seen.has(name) || !available.has(name)) return;
		seen.add(name);
		out.push(name);
	};

	for (const name of always) push(name);
	for (const name of allToolNames) {
		if (alwaysSet.has(name)) continue;
		if (drop.has(name)) continue;
		push(name);
	}
	return out;
}

/** One-line summary for the system prompt; empty description → name only. */
export function summarizeHostTool(tool: { name: string; description?: string }): string {
	const desc = (tool.description ?? "").trim();
	if (!desc) return tool.name;
	const first = desc.split(/\.(?:\s|$)/)[0]?.trim() || desc;
	const clipped = first.length > 160 ? `${first.slice(0, 157)}...` : first;
	return `${tool.name} — ${clipped}${first.endsWith(".") || clipped.endsWith("...") ? "" : "."}`;
}

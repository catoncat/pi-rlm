/**
 * RLM model-visible tool surface: a resident tier plus a loadable tier.
 *
 * Upstream collapses the LLM surface to `execute` alone. Local installs that
 * register session tools (ask_user_question, advisor, subagent, …) need those
 * tools to stay model-visible — cell code cannot open TUI dialogs or own the
 * parent session. Keeping every extension tool resident cost ~67 KB of schema
 * per turn, so the surface is tiered: a short resident set is always active,
 * and everything else stays registered but inactive until the model activates
 * it through `load_tools` (pi's dynamic tool loading, additive-only). File
 * builtins stay off the model list by default because the execute bridge
 * already mounts them as tools.* inside the evaluator.
 *
 * PI_RLM_RESIDENT_TOOLS  comma-separated resident names (replaces the default
 *                        list when set; unregistered names are ignored)
 * PI_RLM_DROP_TOOLS      comma-separated extra names to drop (replaces the default
 *                        extra list when set, including empty string = extras none);
 *                        a dropped tool is neither resident nor loadable
 * PI_RLM_KEEP_BUILTINS=1 do not drop read/bash/edit/… (list them in
 *                        PI_RLM_RESIDENT_TOOLS to put them on the model surface)
 */

/** Mounted inside the evaluator as tools.*; dropped from the model list by default. */
export const BRIDGED_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

/**
 * Default extras: internal/meta tools that waste schema or fight RLM.
 * Keep this list short — new extension tools should appear automatically.
 */
export const DEFAULT_EXTRA_DROP_TOOLS = ["compaction_continue_state", "watchdog_answer"] as const;

/**
 * Resident regardless of configuration: the evaluator, and the loader that
 * reaches every other tool. Without the loader the loadable tier is unreachable.
 */
export const ALWAYS_RESIDENT_TOOLS = ["execute", "load_tools"] as const;

/**
 * Default resident tier: tools a turn reaches for without warning (session UI,
 * memory, web, background processes). Names that are not registered in a
 * session are ignored, so `process` only counts when pi-processes is installed.
 */
export const DEFAULT_RESIDENT_TOOLS = [
	"execute",
	"rlm_mode",
	"todo",
	"ask_user_question",
	"intercom",
	"recall",
	"fetch_content",
	"web_search",
	"process",
	"load_tools",
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
 * Configured resident names, in order, before intersecting with the registry.
 * PI_RLM_RESIDENT_TOOLS replaces the default list; execute and load_tools are
 * appended when missing so an override cannot strand the loadable tier.
 */
export function resolveRlmResidentTools(env: NodeJS.ProcessEnv = process.env): string[] {
	const raw = env.PI_RLM_RESIDENT_TOOLS;
	const configured =
		raw !== undefined
			? raw
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean)
			: [...DEFAULT_RESIDENT_TOOLS];
	const out: string[] = [];
	for (const name of [...configured, ...ALWAYS_RESIDENT_TOOLS]) {
		if (!out.includes(name)) out.push(name);
	}
	return out;
}

export interface RlmSurfaceOptions {
	drop?: ReadonlySet<string>;
	resident?: readonly string[];
	/** Forced on whenever registered, even if dropped. Defaults to execute + load_tools. */
	always?: readonly string[];
}

/**
 * The resident surface: `always` (when registered) first, then the configured
 * resident names that are registered and not dropped. This is what a session
 * starts with, and the only list applied non-additively — pi treats any later
 * removal as a reason to fall back from deferred loading.
 */
export function resolveRlmResidentSurface(allToolNames: readonly string[], options?: RlmSurfaceOptions): string[] {
	const drop = options?.drop ?? resolveRlmDropSet();
	const resident = options?.resident ?? resolveRlmResidentTools();
	const always = options?.always ?? ALWAYS_RESIDENT_TOOLS;
	const available = new Set(allToolNames);
	const out: string[] = [];
	for (const name of always) {
		if (available.has(name) && !out.includes(name)) out.push(name);
	}
	for (const name of resident) {
		if (available.has(name) && !drop.has(name) && !out.includes(name)) out.push(name);
	}
	return out;
}

/**
 * The per-turn surface: every currently active tool that is still registered
 * and neither dropped nor a bridged builtin, in its current order, plus any
 * resident tool that is missing. Tools the model activated through load_tools
 * are never removed here — pi records additive changes on the loader's result
 * and only keeps deferred loading while the set keeps growing.
 */
export function resolveRlmEnsuredSurface(
	activeToolNames: readonly string[],
	allToolNames: readonly string[],
	options?: RlmSurfaceOptions,
): string[] {
	const drop = options?.drop ?? resolveRlmDropSet();
	const desired = resolveRlmResidentSurface(allToolNames, { ...options, drop });
	const desiredSet = new Set(desired);
	const available = new Set(allToolNames);
	const bridged = new Set<string>(BRIDGED_BUILTIN_TOOLS);
	const out: string[] = [];
	for (const name of activeToolNames) {
		if (!available.has(name) || out.includes(name)) continue;
		if (!desiredSet.has(name) && (drop.has(name) || bridged.has(name))) continue;
		out.push(name);
	}
	for (const name of desired) {
		if (!out.includes(name)) out.push(name);
	}
	return out;
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

/** Order-insensitive equality, so an unchanged surface is never re-applied. */
export function sameToolSet(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	const set = new Set(a);
	return b.every((name) => set.has(name));
}

/**
 * Whether pi-rlm may take over this session: the RLM flag/env alone is not
 * enough, `execute` must actually be registered. A launcher's tool allowlist
 * can exclude it — pi-subagents' builtin worker/delegate agents pass
 * `read, bash, …, contact_supervisor` — while the child still inherits
 * PI_RLM_FORCE=1 from an RLM parent. Taking over anyway replaced the prompt
 * with one advertising a tool that does not exist and dropped the builtins
 * it claimed were bridged, leaving the child with `contact_supervisor` alone
 * (observed 2026-09-17: 16 of 21 background children in one day).
 */
export function rlmCanTakeOver(requested: boolean, allToolNames: readonly string[]): boolean {
	return requested && allToolNames.includes("execute");
}

/** One-line summary for the system prompt; empty description → name only. */
export function summarizeHostTool(tool: { name: string; description?: string }): string {
	const desc = (tool.description ?? "").trim();
	if (!desc) return tool.name;
	const first = desc.split(/\.(?:\s|$)/)[0]?.trim() || desc;
	const clipped = first.length > 160 ? `${first.slice(0, 157)}...` : first;
	return `${tool.name} — ${clipped}${first.endsWith(".") || clipped.endsWith("...") ? "" : "."}`;
}

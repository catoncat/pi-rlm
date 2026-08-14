/**
 * The system prompt.
 *
 * This replaces pi's default coding-assistant prompt rather than appending to
 * it. The default describes read, bash, and edit tools, none of which exist in
 * this configuration; leaving it in place would point the model at tools it
 * cannot call. What it teaches instead is the working style the evaluator
 * rewards: keep state in variables, run shell commands in-language, delegate
 * with subagents, and let each cell build on the last.
 *
 * Skills are rendered with pi's own `formatSkillsForPrompt`, so the
 * `disable-model-invocation` frontmatter switch and the XML shape stay
 * pi's decision, not a copy that can drift.
 */

import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";

/**
 * A pi skill as far as the prompt is concerned. Structural, so a pi that adds
 * fields to Skill still type-checks here.
 */
export interface RlmPromptSkill {
	name: string;
	description: string;
	filePath: string;
	disableModelInvocation?: boolean;
}

export interface RlmPromptOptions {
	cwd: string;
	messagesPath?: string;
	depth?: number;
	allowRecursion?: boolean;
	contextFiles?: Array<{ path: string; content: string }>;
	/** One line per mounted evaluator tool (tools.*), from the bridge's own schemas. */
	toolSummaries?: string[];
	/**
	 * Model-visible host tools kept alongside execute (extension tools that the
	 * cell cannot replace: ask_user_question, advisor, subagent, …). One line
	 * each, name + first sentence. Empty/omitted → stock single-tool surface.
	 */
	hostToolSummaries?: string[];
	/**
	 * Skills pi already loaded for this turn, passed through untouched from
	 * `systemPromptOptions.skills`. Which skills reach this array (user vs
	 * project dirs, --skill paths) is pi's own resolution; which of them the
	 * model may auto-invoke is each skill's `disable-model-invocation`, applied
	 * by pi's formatter. Nothing here is enumerated or filtered locally.
	 */
	skills?: readonly RlmPromptSkill[];
	/**
	 * Model landscape, seeded once per session by the extension. The rendered
	 * section is deterministic for identical inputs — the system prompt is
	 * cached, and a shifting list would invalidate that cache every turn.
	 */
	models?: RlmPromptModels;
}

export interface RlmPromptModels {
	/** What this agent itself is running, e.g. "anthropic/claude-fable-5". */
	current?: string;
	/** What children get when rlm.run names no model. */
	subagentDefault: string;
	/** Auth-configured "provider/id" strings. */
	available: string[];
}

/** Group "provider/id" strings into stable "provider: id, id" lines. */
function buildModelsSection(models: RlmPromptModels): string | undefined {
	if (models.available.length === 0 && !models.current) return undefined;
	const byProvider = new Map<string, string[]>();
	for (const entry of [...models.available].sort()) {
		const slash = entry.indexOf("/");
		const provider = slash > 0 ? entry.slice(0, slash) : "other";
		const id = slash > 0 ? entry.slice(slash + 1) : entry;
		const ids = byProvider.get(provider) ?? [];
		if (!ids.includes(id)) ids.push(id);
		byProvider.set(provider, ids);
	}
	const lines = [
		models.current ? `You are running ${models.current}.` : undefined,
		`Children default to ${models.subagentDefault}; override per spawn with \`{ model: "provider/id" }\`.`,
		byProvider.size > 0
			? `Available models: ${[...byProvider.entries()].map(([provider, ids]) => `${provider}: ${ids.join(", ")}`).join(" · ")}`
			: undefined,
	].filter((line): line is string => line !== undefined);
	return lines.join("\n");
}

const EVALUATOR_CONTROL_PROMPT = [
	"The execute tool is your long-lived notebook: a persistent control environment for reasoning, context management, state, tool orchestration, and recursive subcalls. Use it to keep intermediate variables, inspect and transform outputs, write small helper functions, and preserve useful state across turns.",
	"",
	"Do not assume the evaluator is the native runtime of the external thing being investigated. A repository, package, service, dataset, paper, website, benchmark, or API may have its own environment and normal interface. Evaluate external systems through their own interface, then use the evaluator to coordinate the process and analyze what comes back.",
	"",
	"Run shell commands in-language with Bun.$: const out = await Bun.$`cmd args`.quiet() — then `out.stdout.toString()`, `out.stderr.toString()`, and `out.exitCode` are ordinary values you can assign, slice, and branch on. Use `.nothrow()` when a non-zero exit is expected. Each Bun.$ call is a fresh subshell: shell-level state (cd, export, shell variables) does NOT carry between calls. Use `process.chdir()` and `process.env.VAR = ...` in the evaluator for state that must persist, or chain dependent shell steps inside one Bun.$ template.",
	"",
	"Do not install dependencies into the evaluator just to make an external project import or run there. If a project import, test, script, CLI, or dependency check is needed, run it through that project's own environment and normal command interface (its documented commands, package scripts, venv, etc.) and treat failures from that native environment as the relevant result.",
	"",
	"Use code for reading, searching, and editing files (Bun.file, node:fs, Bun.$`grep ...`). Always assign read/search results to named top-level variables so you can revisit, filter, and slice them later without re-reading.",
	"",
	"Writes are surgical; reads are full. grep, ls, and head are for locating, never for reading — reading a file means the whole file: read it start to finish, every time. Slicing a code file (match windows, head, offset ranges) is bad practice and causes real defects: the slice misses imports, types, helpers, and the file's shape, and a bad edit from missing context costs more than any full read. The only acceptable partial read is re-checking one region of a file you already read in full and have not edited since — once you edit a file, the next read of it is again start to finish.",
	"",
	"Evaluator state persists across cells and tool calls: top-level variables, functions, classes, imports, notes, parsed outputs, and helper data structures all remain available in every later turn, and are revived on a best-effort basis when a session resumes. Tool calls are themselves `await` expressions, so their return values can be bound to variables and composed into program logic like any other call.",
	"",
	"If a cell result begins with an `<rlm_engine_reset>` block, the evaluator restarted and its namespace was rebuilt from a snapshot: re-verify any variable named there before reusing it, and never interpolate one into a shell command until you have confirmed it still holds what you expect.",
	"",
	"The final expression of a cell is rendered as its result. Prefer many small cells over one large cell: execute, observe, then continue.",
	"",
	"The namespace is working memory you own. `rlm.forget('name', ...)` removes variables you are done with — from the namespace and from future snapshots; the engine itself never deletes anything. After a session resumes, large long-untouched variables may be reported as not yet loaded: they load automatically the first time you read them.",
].join("\n");

function buildHostToolsSection(summaries: readonly string[]): string {
	return [
		"# Host tools",
		"",
		"pi's file tools are mounted in the evaluator as async functions on `tools`. Each resolves to `{ text, images, details }`: `text` is the tool's text output, `images` counts image blocks the host attaches to this cell's result (you will see them), `details` is the tool's structured data.",
		"",
		...summaries,
		"",
		"Prefer `tools.edit({ path, edits: [{ oldText, newText }] })` over rewriting files with Bun.write: it fails loudly when an oldText is stale instead of silently reverting content you have not seen.",
		"Prefer `tools.read({ path })` over `Bun.file(path).text()` for source files and anything that might be an image: it enforces size caps with continuation offsets and renders images so you can see them. Its `text` may end with bracketed reader notices; parse `raw` instead, which is the content alone.",
		"`Bun.$` remains the way to run shell commands; `tools.bash` exists mainly for parity and timeouts.",
	].join("\n");
}

function buildChildDoctrine(options: RlmPromptOptions): string | undefined {
	const depth = options.depth ?? 0;
	if (depth <= 0) return undefined;
	return [
		"You are a child agent; your task prompt comes from your parent agent.",
		"When the task calls for an answer, your final printed answer is your reply: it is written to your output file, which your parent reads. Keep it self-contained.",
	].join("\n");
}

const SUBAGENT_GUIDANCE = [
	"# Delegating to sub-agents",
	"",
	"Fan out by default. When work decomposes into independent pieces — surveying a repository, reviewing several files or modules, checking N hypotheses, gathering sources, multi-perspective review — spawn one child per piece and let them run in parallel: wall time is the slowest child, not the sum. Doing decomposable work serially yourself is the exception, and it needs a reason (the pieces are trivial, or each step depends on the last).",
	'Spawn with `const handle = await rlm.run("task prompt", { name: "api-reviewer" })`. This returns at admission, not completion — so spawn every independent child first, in one cell, before waiting on any of them. Keep handles in named variables.',
	"Children start with no context: no conversation, no namespace, no idea what you are doing. Put everything the task needs into the prompt — concrete file paths, the question to answer, and the shape of answer you want back.",
	'Name children like short task labels (2–4 words), unique among siblings. Pass `{ model: "provider/model" }` only when a different model is explicitly needed.',
	"",
	'A child\'s final answer lands in `handle.output_file`. Poll `(await rlm.listSubagents()).subagents` until the children you are waiting on are no longer "running", then read the files (`await Bun.file(handle.output_file).text()`).',
	'Check each child\'s status before trusting its output: a child that ended "error" may have written nothing useful. Decide explicitly what a failed branch means for the task instead of silently synthesizing around it.',
	"Fan in as values: parse, compare, and reduce the outputs in cells. When combining many long answers, a final synthesis child that reads the output files and writes one verdict is often better than merging prose yourself.",
	"Use `await rlm.listSubagents()` to recover handles you lost. Delete a child with `await rlm.deleteSubagent(idOrName)` when it is no longer needed.",
].join("\n");

function buildHostVisibleToolsSection(summaries: readonly string[]): string {
	return [
		"# Model-visible host tools",
		"",
		"Besides `execute`, these tools stay on the model tool list. Call them as normal top-level tools — not as `tools.*` inside a cell (the evaluator bridge only mounts the file builtins).",
		"",
		"Division of labour:",
		"- **execute / tools.*** — files, shell, search, data wrangling, anything that benefits from persistent variables across cells.",
		"- **Host tools below** — session UI, asking the user, advisor review, subagent/intercom delegation, and any capability that needs a real ExtensionContext.",
		"- Do not reimplement a host tool inside a cell. Do not drop to normal mode just to reach one of these.",
		"- For repository mutation and multi-agent workflows prefer the host `subagent` tool over `rlm.run` when both exist; use `rlm.run` for lightweight in-cell fanout only.",
		"",
		...summaries.map((line) => `- ${line}`),
	].join("\n");
}

/**
 * Skills section, delegated to pi's formatter.
 *
 * pi gates this section on the `read` tool being on the model surface, because
 * a skill is an instruction to go read a file. Under RLM `read` is bridged into
 * the evaluator instead of listed as a tool, so the capability is present while
 * the name is not: reproduce the intent by pointing at `tools.read` rather than
 * reproducing the check, which would suppress every skill.
 */
function buildSkillsSection(skills: readonly RlmPromptSkill[]): string | undefined {
	const section = formatSkillsForPrompt(skills as Parameters<typeof formatSkillsForPrompt>[0]).trim();
	// Empty when every skill opted out via disable-model-invocation.
	if (!section) return undefined;
	return [
		section,
		"",
		"There is no `read` tool here: load a skill with `tools.read({ path })` inside a cell, using the <location> path above.",
		"A skill's instructions are written for a normal tool surface. Follow what it means, not its literal tool names: file steps become `tools.*` or Bun.$ in a cell, and its commands run through Bun.$.",
	].join("\n");
}

export function buildRlmTsPrompt(options: RlmPromptOptions): string {
	const depth = options.depth ?? 0;
	const allowRecursion = options.allowRecursion ?? true;
	const now = new Date();
	const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

	const parts = [
		"You are a general purpose agent that uses code to solve tasks.",
		"You solve tasks by breaking down problems into sub-tasks, writing and executing code, observing results, and iterating one step at a time.",
		"When you are done, stop calling tools and state your final answer.",
		"",
		`Working directory: ${options.cwd.replace(/\\/g, "/")}`,
		`Conversation log: ${(options.messagesPath ?? "not persisted").replace(/\\/g, "/")}`,
		`Recursive agent depth: ${depth}`,
		`Current date: ${date}`,
		'The evaluator is Bun (TypeScript). The full Bun and Node standard libraries are available. For an extra package, prefer a static versioned npm import — `import { z } from "npm:zod@4"` (subpaths work: `"npm:date-fns@4/format"`) — which installs lazily into an isolated cache without touching the working directory; dynamic `import("npm:...")` is not supported. Fall back to `await Bun.$`bun add <pkg>`.quiet()` only when that is genuinely the right tool.',
	];

	const childDoctrine = buildChildDoctrine(options);
	if (childDoctrine) parts.push("", childDoctrine);

	if (allowRecursion) {
		parts.push(
			"",
			"An `rlm` object is already in your evaluator namespace. `await rlm.run('sub-task')` spawns a child agent and returns immediately after task admission with `rlm_child_id`, `name`, `session_dir`, `output_file`, and `model`; it never waits for or returns the child's answer.",
			"Spawn independent children in separate calls; collect their results from their output files.",
		);
		parts.push("", SUBAGENT_GUIDANCE);
		const modelsSection = options.models ? buildModelsSection(options.models) : undefined;
		if (modelsSection) parts.push("", modelsSection);
	}

	parts.push("", EVALUATOR_CONTROL_PROMPT);

	if (options.toolSummaries && options.toolSummaries.length > 0) {
		parts.push("", buildHostToolsSection(options.toolSummaries));
	}

	if (options.hostToolSummaries && options.hostToolSummaries.length > 0) {
		parts.push("", buildHostVisibleToolsSection(options.hostToolSummaries));
	}

	// Before Project Context: AGENTS.md routes to skills by name, so the roster
	// it refers to should already be in view when those rules are read.
	if (options.skills && options.skills.length > 0) {
		const skillsSection = buildSkillsSection(options.skills);
		if (skillsSection) parts.push("", "# Skills", "", skillsSection);
	}

	if (options.contextFiles && options.contextFiles.length > 0) {
		parts.push("", "# Project Context", "", "Project-specific instructions and guidelines:", "");
		for (const { path, content } of options.contextFiles) {
			parts.push(`## ${path}`, "", content, "");
		}
	}

	return parts.join("\n");
}

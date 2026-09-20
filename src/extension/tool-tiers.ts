/**
 * The loadable tier: the catalog `load_tools` advertises and the selection it
 * resolves. Pure functions over pi's ToolInfo shape so the tool body in
 * index.ts stays a thin call and the catalog budget can be tested.
 *
 * Loadable = registered − resident − dropped − bridged builtins. The catalog
 * rides inside the load_tools description, so every character here is paid
 * on every turn: one line per tool, first sentence clipped, grouped by source
 * so a model can ask for a whole package by group.
 */

import { BRIDGED_BUILTIN_TOOLS } from "./keep-tools.js";

/** The subset of pi's ToolInfo the catalog reads; structural so tests need no pi types. */
export interface LoadableToolInfo {
	name: string;
	description?: string;
	sourceInfo?: { source: string; path: string };
}

/** Catalog line budget: the first sentence, clipped. */
export const CATALOG_SUMMARY_CHARS = 80;
/** Query results are capped so a broad keyword cannot reactivate the whole registry. */
export const QUERY_MATCH_LIMIT = 5;

export interface LoadToolsParams {
	names?: string[];
	group?: string;
	query?: string;
}

export interface LoadToolsSelection {
	/** Loadable tools that were inactive and are now to be activated. */
	added: string[];
	/** Requested tools that were already on the surface (resident or loaded earlier). */
	alreadyActive: string[];
	/** Requested names that are not loadable: unregistered, dropped, or bridged. */
	unknown: string[];
	/** A group or query that matched nothing, as the caller wrote it. */
	unmatched: string[];
}

/**
 * Group name from pi's SourceInfo. Package tools carry the package spec as
 * `source` ("npm:@scope/name@tag", "git:github.com/o/r"); the last path
 * segment minus scheme, version tag, and extension is the package name. User
 * extensions and builtins carry a generic `source` ("auto", "local",
 * "builtin"), so the file path names them instead: `extensions/control.ts`
 * → "control", and an `index.ts` entry takes its directory's name.
 */
export function toolGroupName(sourceInfo: LoadableToolInfo["sourceInfo"]): string {
	if (!sourceInfo) return "other";
	const { source, path } = sourceInfo;
	if (source === "builtin") return "builtin";
	if (source.includes("/") || source.includes(":")) {
		const segment = source.split("/").filter(Boolean).at(-1) ?? source;
		const unscoped = segment.includes(":") ? segment.slice(segment.indexOf(":") + 1) : segment;
		const untagged = unscoped.indexOf("@") > 0 ? unscoped.slice(0, unscoped.indexOf("@")) : unscoped;
		return stripExtension(untagged) || "other";
	}
	const parts = path.replace(/^<|>$/g, "").split("/").filter(Boolean);
	const file = stripExtension(parts.at(-1) ?? "");
	if (file === "index" && parts.length >= 2) return parts[parts.length - 2] ?? file;
	return file || "other";
}

function stripExtension(name: string): string {
	return name.replace(/\.(ts|js|mjs|cjs|tsx|jsx)$/, "");
}

/** First sentence of a description, whitespace collapsed, clipped to the catalog budget. */
export function summarizeForCatalog(description: string | undefined, max = CATALOG_SUMMARY_CHARS): string {
	const flat = (description ?? "").replace(/\s+/g, " ").trim();
	if (!flat) return "";
	const first = flat.split(/\.(?:\s|$)/)[0]?.trim() || flat;
	return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

/**
 * The loadable tier, in registry order. Resident names are excluded whether or
 * not they are registered, dropped names are unreachable by design, and the
 * bridged builtins are never loadable: read/bash/write/grep/find/ls are
 * already mounted as tools.* inside the evaluator, and the one that belongs
 * on the model surface (edit) gets there by being resident, not by loading.
 */
export function resolveLoadableTools<T extends LoadableToolInfo>(
	allTools: readonly T[],
	options: { resident: readonly string[]; drop: ReadonlySet<string> },
): T[] {
	const excluded = new Set<string>([...options.resident, ...options.drop, ...BRIDGED_BUILTIN_TOOLS]);
	return allTools.filter((tool) => !excluded.has(tool.name));
}

/** Grouped catalog text: a `group:` header line, then `name — summary` per tool. Empty tier → "". */
export function buildLoadToolsCatalog(loadable: readonly LoadableToolInfo[]): string {
	const groups = new Map<string, LoadableToolInfo[]>();
	for (const tool of loadable) {
		const group = toolGroupName(tool.sourceInfo);
		const list = groups.get(group);
		if (list) list.push(tool);
		else groups.set(group, [tool]);
	}
	const lines: string[] = [];
	for (const group of [...groups.keys()].sort()) {
		lines.push(`${group}:`);
		for (const tool of groups.get(group) ?? []) {
			const summary = summarizeForCatalog(tool.description);
			lines.push(summary ? `${tool.name} — ${summary}` : tool.name);
		}
	}
	return lines.join("\n");
}

export function buildLoadToolsDescription(catalog: string): string {
	return [
		"Activate registered tools that are not on your tool list yet; from the next turn call them directly at the top level. " +
			"Additive only: nothing already active is removed. Select by exact names, by group (the package/extension a tool comes from), " +
			`or by query (keyword match on name and description, at most ${QUERY_MATCH_LIMIT} tools). Loadable tools by group:`,
		catalog || "(none — every registered tool is already on the list)",
	].join("\n");
}

/** Lower-cased alphanumeric terms, so "model list" matches "model_list". */
function queryTerms(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

/**
 * Resolve a load request against the loadable tier and the current surface.
 * Every selector contributes; nothing throws for an unknown name so the model
 * reads the outcome in the result text instead of retrying blind.
 */
export function selectToolsToLoad(
	params: LoadToolsParams,
	context: { loadable: readonly LoadableToolInfo[]; active: readonly string[] },
): LoadToolsSelection {
	const loadableByName = new Map(context.loadable.map((tool) => [tool.name, tool]));
	const active = new Set(context.active);
	const selection: LoadToolsSelection = { added: [], alreadyActive: [], unknown: [], unmatched: [] };
	const take = (name: string) => {
		if (active.has(name)) {
			if (!selection.alreadyActive.includes(name)) selection.alreadyActive.push(name);
		} else if (loadableByName.has(name)) {
			if (!selection.added.includes(name)) selection.added.push(name);
		} else if (!selection.unknown.includes(name)) {
			selection.unknown.push(name);
		}
	};

	for (const name of params.names ?? []) take(name.trim());

	if (params.group !== undefined) {
		const wanted = params.group.trim().toLowerCase();
		const members = context.loadable.filter((tool) => toolGroupName(tool.sourceInfo).toLowerCase() === wanted);
		if (members.length === 0) selection.unmatched.push(`group "${params.group}"`);
		for (const tool of members) take(tool.name);
	}

	if (params.query !== undefined) {
		const terms = queryTerms(params.query);
		const scored = context.loadable
			.map((tool) => {
				const haystack = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
				return { name: tool.name, score: terms.filter((term) => haystack.includes(term)).length };
			})
			.filter((match) => match.score > 0)
			.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
			.slice(0, QUERY_MATCH_LIMIT);
		if (scored.length === 0) selection.unmatched.push(`query "${params.query}"`);
		for (const match of scored) take(match.name);
	}

	return selection;
}

export function formatLoadToolsResult(selection: LoadToolsSelection): string {
	const lines: string[] = [];
	if (selection.added.length > 0) {
		lines.push(`Activated: ${selection.added.join(", ")}. From the next turn call them directly at the top level.`);
	}
	if (selection.alreadyActive.length > 0) {
		lines.push(`Already active: ${selection.alreadyActive.join(", ")}.`);
	}
	if (selection.unknown.length > 0) {
		lines.push(`Not loadable (unregistered or excluded): ${selection.unknown.join(", ")}.`);
	}
	if (selection.unmatched.length > 0) {
		lines.push(`No loadable tool matched ${selection.unmatched.join(" or ")}.`);
	}
	return lines.join("\n") || "Nothing to activate.";
}

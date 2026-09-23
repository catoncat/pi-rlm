#!/usr/bin/env bun
/**
 * Verify pi-rlm-keep-extension-tools: tiered surface helpers (resident +
 * load_tools), prompt wiring, and rlm-toggle importing this repo's keep-tools.ts.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ROOT = new URL("..", import.meta.url).pathname; // fork 仓库根目录

function mustInclude(rel, needle) {
  const p = join(ROOT, rel);
  if (!existsSync(p) || !readFileSync(p, "utf8").includes(needle)) {
    console.error("missing", JSON.stringify(needle), "in", rel);
    process.exit(1);
  }
}

mustInclude("src/extension/keep-tools.ts", "resolveRlmResidentTools");
mustInclude("src/extension/keep-tools.ts", "resolveRlmResidentSurface");
mustInclude("src/extension/keep-tools.ts", "resolveRlmEnsuredSurface");
mustInclude("src/extension/keep-tools.ts", "PI_RLM_RESIDENT_TOOLS");
mustInclude("src/extension/keep-tools.ts", "PI_RLM_DROP_TOOLS");
mustInclude("src/extension/keep-tools.ts", "BRIDGED_BUILTIN_TOOLS");
mustInclude("src/extension/index.ts", 'from "./keep-tools.js"');
mustInclude("src/extension/index.ts", "resolveRlmResidentSurface");
mustInclude("src/extension/index.ts", "resolveRlmEnsuredSurface");
mustInclude("src/extension/index.ts", 'name: "load_tools"');
mustInclude("src/extension/index.ts", "hostToolSummaries");
mustInclude("src/extension/prompt.ts", "hostToolSummaries");
mustInclude("src/extension/prompt.ts", "Model-visible host tools");
mustInclude("src/extension/prompt.ts", "load_tools");
const index = readFileSync(join(ROOT, "src/extension/index.ts"), "utf8");
if (index.includes('pi.setActiveTools(["execute"])')) {
  console.error("still collapses to execute-only");
  process.exit(1);
}
console.log("0 source contract ok");

const {
  resolveRlmDropSet,
  resolveRlmResidentTools,
  resolveRlmResidentSurface,
  resolveRlmEnsuredSurface,
  sameToolSet,
  summarizeHostTool,
  BRIDGED_BUILTIN_TOOLS,
  ALWAYS_RESIDENT_TOOLS,
} = await import(join(ROOT, "src/extension/keep-tools.ts"));
const { buildRlmTsPrompt } = await import(join(ROOT, "src/extension/prompt.ts"));
const { resolveLoadableTools, buildLoadToolsCatalog, selectToolsToLoad } = await import(
  join(ROOT, "src/extension/tool-tiers.ts")
);

// Bridged builtins are dropped unless named resident: edit is resident by
// default (hybrid surface: top-level and tools.edit), the other six are not.
const d = resolveRlmDropSet({});
const CELL_ONLY_BUILTINS = BRIDGED_BUILTIN_TOOLS.filter((n) => n !== "edit");
for (const n of CELL_ONLY_BUILTINS) {
  if (!d.has(n)) {
    console.error("A missing builtin in drop", n);
    process.exit(1);
  }
}
if (d.has("edit")) {
  console.error("A edit must not be dropped while resident");
  process.exit(1);
}
if (!d.has("compaction_continue_state")) {
  console.error("A missing default extra");
  process.exit(1);
}
console.log("A default drop", d.size);

const dEmpty = resolveRlmDropSet({ PI_RLM_DROP_TOOLS: "" });
if (dEmpty.has("compaction_continue_state") || dEmpty.size !== CELL_ONLY_BUILTINS.length) {
  console.error("B empty extras failed", [...dEmpty]);
  process.exit(1);
}
const dCustom = resolveRlmDropSet({ PI_RLM_DROP_TOOLS: "only_this" });
if (!dCustom.has("only_this") || dCustom.has("compaction_continue_state") || !dCustom.has("read")) {
  console.error("B custom failed", [...dCustom]);
  process.exit(1);
}
// An explicit drop beats the resident listing, even for edit.
const dEditOff = resolveRlmDropSet({ PI_RLM_DROP_TOOLS: "edit" });
if (!dEditOff.has("edit")) {
  console.error("B explicit drop of edit failed", [...dEditOff]);
  process.exit(1);
}
console.log("B env override ok");

const dKeep = resolveRlmDropSet({ PI_RLM_KEEP_BUILTINS: "1" });
if (dKeep.has("read") || !dKeep.has("compaction_continue_state")) {
  console.error("C keep builtins failed", [...dKeep]);
  process.exit(1);
}
console.log("C keep builtins ok");

const all = [
  "execute",
  "read",
  "bash",
  "edit",
  "ask_user_question",
  "advisor",
  "subagent",
  "rlm_mode",
  "compaction_continue_state",
  "todo",
  "load_tools",
];
const resident = resolveRlmResidentTools({});
for (const n of ALWAYS_RESIDENT_TOOLS) {
  if (!resident.includes(n)) {
    console.error("D resident missing forced", n);
    process.exit(1);
  }
}
const residentOverride = resolveRlmResidentTools({ PI_RLM_RESIDENT_TOOLS: "advisor" });
if (JSON.stringify(residentOverride) !== JSON.stringify(["advisor", "execute", "load_tools"])) {
  console.error("D resident override failed", residentOverride);
  process.exit(1);
}
const surfaceOptions = { drop: d, resident, always: ["execute", "load_tools", "rlm_mode"] };
const active = resolveRlmResidentSurface(all, surfaceOptions);
const expect = ["execute", "load_tools", "rlm_mode", "edit", "todo", "ask_user_question"];
if (JSON.stringify(active) !== JSON.stringify(expect)) {
  console.error("D resident surface mismatch", active, expect);
  process.exit(1);
}
if (active.includes("read") || active.includes("compaction_continue_state") || active.includes("advisor")) {
  console.error("D leaked dropped or loadable tools");
  process.exit(1);
}
// The per-turn ensure keeps a model-loaded tool (advisor) and re-adds a lost resident (todo).
const ensured = resolveRlmEnsuredSurface(["execute", "load_tools", "rlm_mode", "advisor", "read"], all, surfaceOptions);
if (!ensured.includes("advisor") || !ensured.includes("todo") || !ensured.includes("edit") || ensured.includes("read")) {
  console.error("D ensured surface failed", ensured);
  process.exit(1);
}
if (!sameToolSet(ensured, resolveRlmEnsuredSurface(ensured, all, surfaceOptions))) {
  console.error("D ensure is not idempotent", ensured);
  process.exit(1);
}
console.log("D resident surface", active.join(","));

// Loadable tier = registered − resident − drop − bridged; query and names resolve against it.
const infos = all.map((name) => ({ name, description: `${name} tool.`, sourceInfo: { source: "npm:x", path: "/x" } }));
const loadable = resolveLoadableTools(infos, { resident, drop: d });
const loadableNames = loadable.map((t) => t.name);
if (JSON.stringify(loadableNames) !== JSON.stringify(["advisor", "subagent"])) {
  console.error("D2 loadable tier mismatch", loadableNames);
  process.exit(1);
}
const catalog = buildLoadToolsCatalog(loadable);
for (const n of ["todo", "read", "bash", "edit", "compaction_continue_state", "execute"]) {
  if (new RegExp(`^${n}( |$)`, "m").test(catalog)) {
    console.error("D2 catalog leaks", n);
    process.exit(1);
  }
}
const picked = selectToolsToLoad({ names: ["advisor", "todo", "nope"], query: "subagent" }, { loadable, active });
if (
  JSON.stringify(picked.added) !== JSON.stringify(["advisor", "subagent"]) ||
  JSON.stringify(picked.alreadyActive) !== JSON.stringify(["todo"]) ||
  JSON.stringify(picked.unknown) !== JSON.stringify(["nope"])
) {
  console.error("D2 selection mismatch", picked);
  process.exit(1);
}
console.log("D2 loadable tier", loadableNames.join(","));

const prompt = buildRlmTsPrompt({
  cwd: "/tmp",
  toolSummaries: ["tools.read({ path }) — Read."],
  hostToolSummaries: [
    summarizeHostTool({ name: "ask_user_question", description: "Ask the user structured questions." }),
    summarizeHostTool({ name: "advisor", description: "Escalate to a stronger reviewer." }),
  ],
});
for (const n of ["Model-visible host tools", "ask_user_question", "advisor", "activate it with `load_tools`"]) {
  if (!prompt.includes(n)) {
    console.error("E prompt missing", n);
    process.exit(1);
  }
}
// prompt-slim (stacked): summaries collapse to a name list; per-tool description
// sentences and the Division-of-labour bullets must stay out of the prompt.
if (prompt.includes("Division of labour") || prompt.includes("Ask the user structured questions")) {
  console.error("E prompt still renders per-tool summaries");
  process.exit(1);
}
console.log("E prompt section ok");

// rlm-toggle 现在作为独立包安装(github.com/catoncat/pi-rlm-local → packages/rlm-toggle/src);
// 旧布局(~/.pi/agent/extensions 目录扩展)仍兼容,P I_RLM_TOGGLE_SRC_DIR 可覆盖。
const EXT_DIR = process.env.PI_RLM_TOGGLE_SRC_DIR ?? join(homedir(), ".pi", "agent", "git", "github.com", "catoncat", "pi-rlm-local", "packages", "rlm-toggle", "src");
// rlm-toggle 直接 import 本仓库的 keep-tools.ts(不再有镜像):本地副本一旦出现就是漂移源。
const toggle = [
  join(EXT_DIR, "index.ts"),
  join(EXT_DIR, "rlm-toggle", "index.ts"),
  join(EXT_DIR, "rlm-toggle.ts"),
].find(existsSync);
if (!toggle) {
  console.error("F missing rlm-toggle entry (looked for rlm-toggle/ dir and flat layout)");
  process.exit(1);
}
const strayMirror = [
  join(EXT_DIR, "keep-tools.ts"),
  join(EXT_DIR, "rlm-toggle", "keep-tools.ts"),
  join(EXT_DIR, "rlm-keep-tools.ts"),
].find(existsSync);
if (strayMirror) {
  console.error("F rlm-toggle has a local keep-tools mirror again; import pi-rlm's instead:", strayMirror);
  process.exit(1);
}
const toggleSrc = readFileSync(toggle, "utf8");
if (!toggleSrc.includes('/pi-rlm/src/extension/keep-tools.ts"')) {
  console.error("F rlm-toggle does not import pi-rlm's keep-tools.ts");
  process.exit(1);
}
// 真正按 rlm-toggle 的相对路径解析一次,确认指到的就是本仓库这份。
const importPath = /from "(\.[^"]*\/pi-rlm\/src\/extension\/keep-tools\.ts)"/.exec(toggleSrc)?.[1];
const resolved = importPath ? new URL(importPath, "file://" + toggle).pathname : "";
if (!existsSync(resolved)) {
  console.error("F rlm-toggle keep-tools import does not resolve:", importPath, "->", resolved);
  process.exit(1);
}
const linked = await import(resolved);
if (JSON.stringify(linked.resolveRlmResidentTools({})) !== JSON.stringify(resident)) {
  console.error("F rlm-toggle resolves a different keep-tools.ts:", resolved);
  process.exit(1);
}
if (!toggleSrc.includes("resolveRlmResidentSurface") || !toggleSrc.includes("resolveRlmEnsuredSurface")) {
  console.error("F rlm-toggle not using the tiered surface");
  process.exit(1);
}
if (toggleSrc.includes("resolveRlmActiveTools")) {
  console.error("F rlm-toggle still applies keep-all");
  process.exit(1);
}
if (toggleSrc.includes('setActiveTools(["execute", "rlm_mode"])')) {
  console.error("F rlm-toggle still hard-collapses");
  process.exit(1);
}
console.log("F rlm-toggle uses pi-rlm keep-tools ok");

console.log("all keep-extension-tools checks passed");

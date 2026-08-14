#!/usr/bin/env bun
/**
 * Verify pi-rlm-keep-extension-tools: keep-all surface helpers + prompt wiring.
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

mustInclude("src/extension/keep-tools.ts", "resolveRlmActiveTools");
mustInclude("src/extension/keep-tools.ts", "PI_RLM_DROP_TOOLS");
mustInclude("src/extension/keep-tools.ts", "BRIDGED_BUILTIN_TOOLS");
mustInclude("src/extension/index.ts", 'from "./keep-tools.js"');
mustInclude("src/extension/index.ts", "resolveRlmActiveTools");
mustInclude("src/extension/index.ts", "hostToolSummaries");
mustInclude("src/extension/prompt.ts", "hostToolSummaries");
mustInclude("src/extension/prompt.ts", "Model-visible host tools");
const index = readFileSync(join(ROOT, "src/extension/index.ts"), "utf8");
if (index.includes('pi.setActiveTools(["execute"])')) {
  console.error("still collapses to execute-only");
  process.exit(1);
}
console.log("0 source contract ok");

const {
  resolveRlmDropSet,
  resolveRlmActiveTools,
  summarizeHostTool,
  BRIDGED_BUILTIN_TOOLS,
} = await import(join(ROOT, "src/extension/keep-tools.ts"));
const { buildRlmTsPrompt } = await import(join(ROOT, "src/extension/prompt.ts"));

const d = resolveRlmDropSet({});
for (const n of BRIDGED_BUILTIN_TOOLS) {
  if (!d.has(n)) {
    console.error("A missing builtin in drop", n);
    process.exit(1);
  }
}
if (!d.has("compaction_continue_state")) {
  console.error("A missing default extra");
  process.exit(1);
}
console.log("A default drop", d.size);

const dEmpty = resolveRlmDropSet({ PI_RLM_DROP_TOOLS: "" });
if (dEmpty.has("compaction_continue_state") || dEmpty.size !== BRIDGED_BUILTIN_TOOLS.length) {
  console.error("B empty extras failed", [...dEmpty]);
  process.exit(1);
}
const dCustom = resolveRlmDropSet({ PI_RLM_DROP_TOOLS: "only_this" });
if (!dCustom.has("only_this") || dCustom.has("compaction_continue_state") || !dCustom.has("read")) {
  console.error("B custom failed", [...dCustom]);
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
  "ask_user_question",
  "advisor",
  "subagent",
  "rlm_mode",
  "compaction_continue_state",
  "todo",
];
const active = resolveRlmActiveTools(all, { drop: d, always: ["execute", "rlm_mode"] });
const expect = ["execute", "rlm_mode", "ask_user_question", "advisor", "subagent", "todo"];
if (JSON.stringify(active) !== JSON.stringify(expect)) {
  console.error("D active mismatch", active, expect);
  process.exit(1);
}
if (active.includes("read") || active.includes("compaction_continue_state")) {
  console.error("D leaked dropped tools");
  process.exit(1);
}
console.log("D active list", active.join(","));

const prompt = buildRlmTsPrompt({
  cwd: "/tmp",
  toolSummaries: ["tools.read({ path }) — Read."],
  hostToolSummaries: [
    summarizeHostTool({ name: "ask_user_question", description: "Ask the user structured questions." }),
    summarizeHostTool({ name: "advisor", description: "Escalate to a stronger reviewer." }),
  ],
});
for (const n of ["Model-visible host tools", "ask_user_question", "advisor"]) {
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

// rlm-toggle is a directory extension (index.ts + keep-tools.ts); older layout was flat files.
const EXT_DIR = process.env.PI_AGENT_EXTENSIONS_DIR ?? join(homedir(), ".pi", "agent", "extensions");
const toggleKeep = [
  join(EXT_DIR, "rlm-toggle/keep-tools.ts"),
  join(EXT_DIR, "rlm-keep-tools.ts"),
].find(existsSync);
const toggle = [
  join(EXT_DIR, "rlm-toggle/index.ts"),
  join(EXT_DIR, "rlm-toggle.ts"),
].find(existsSync);
if (!toggleKeep || !toggle) {
  console.error("F missing rlm-toggle helpers (looked for rlm-toggle/ dir and flat layout)");
  process.exit(1);
}
const mirror = await import(toggleKeep);
const md = mirror.resolveRlmDropSet({});
if (md.size !== d.size) {
  console.error("F mirror drop size drift", md.size, d.size);
  process.exit(1);
}
const ma = mirror.resolveRlmActiveTools(all, { drop: md, always: ["execute", "rlm_mode"] });
if (JSON.stringify(ma) !== JSON.stringify(active)) {
  console.error("F mirror active drift", ma, active);
  process.exit(1);
}
const toggleSrc = readFileSync(toggle, "utf8");
if (!toggleSrc.includes("resolveRlmActiveTools")) {
  console.error("F rlm-toggle not using keep-all");
  process.exit(1);
}
if (toggleSrc.includes('setActiveTools(["execute", "rlm_mode"])')) {
  console.error("F rlm-toggle still hard-collapses");
  process.exit(1);
}
console.log("F rlm-toggle mirror ok");

console.log("all keep-extension-tools checks passed");

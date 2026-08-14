#!/usr/bin/env bun
/**
 * Verify pi-rlm-restore-skills: pi's loaded skills reach the RLM system prompt,
 * and the decision about which skills the model may auto-invoke stays pi's.
 *
 * The contract under test is "pass through, decide nothing":
 *   - index.ts must hand systemPromptOptions.skills to the prompt builder
 *   - prompt.ts must render them via pi's own formatSkillsForPrompt, so
 *     disable-model-invocation keeps working without a local reimplementation
 *   - no skill name may be hardcoded anywhere in the patch surface
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ROOT = new URL("..", import.meta.url).pathname; // fork 仓库根目录
const AGENT_DIR = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");

function fail(...msg) {
  console.error(...msg);
  process.exit(1);
}

function mustInclude(rel, needle) {
  const p = join(ROOT, rel);
  if (!existsSync(p) || !readFileSync(p, "utf8").includes(needle)) {
    fail("missing", JSON.stringify(needle), "in", rel);
  }
}

// --- 0. source contract -----------------------------------------------------
mustInclude("src/extension/index.ts", "skills: options?.skills");
mustInclude("src/extension/index.ts", "RlmPromptSkill");
mustInclude("src/extension/prompt.ts", "formatSkillsForPrompt");
mustInclude("src/extension/prompt.ts", "buildSkillsSection");

const promptSrc = readFileSync(join(ROOT, "src/extension/prompt.ts"), "utf8");
const indexSrc = readFileSync(join(ROOT, "src/extension/index.ts"), "utf8");

// The old narrow cast is exactly what dropped skills; it must not come back.
if (/systemPromptOptions\?: \{ contextFiles\?: Array<\{ path: string; content: string \}> \}/.test(indexSrc)) {
  fail("index.ts still narrows systemPromptOptions to contextFiles only");
}
// A local copy of pi's filter would drift from pi's semantics.
if (/disableModelInvocation\s*(===|!==|\?|\))/.test(promptSrc.replace(/disableModelInvocation\?: boolean;/, ""))) {
  fail("prompt.ts filters disable-model-invocation locally instead of delegating to pi");
}
console.log("0 source contract ok");

// --- 1. pi's formatter is the one doing the filtering -----------------------
const { formatSkillsForPrompt, loadSkills } = await import("@earendil-works/pi-coding-agent");
const { buildRlmTsPrompt } = await import(join(ROOT, "src/extension/prompt.ts"));

const synthetic = [
  { name: "visible-one", description: "should reach the prompt", filePath: "/s/visible-one/SKILL.md", baseDir: "/s/visible-one", disableModelInvocation: false },
  { name: "muted-one", description: "opted out via frontmatter", filePath: "/s/muted-one/SKILL.md", baseDir: "/s/muted-one", disableModelInvocation: true },
];
const synthPrompt = buildRlmTsPrompt({ cwd: "/tmp", skills: synthetic });
if (!synthPrompt.includes("visible-one")) fail("A visible skill missing from prompt");
if (synthPrompt.includes("muted-one")) fail("A disable-model-invocation skill leaked into prompt");
if (!synthPrompt.includes("<available_skills>")) fail("A not using pi's XML section");
console.log("A disable-model-invocation respected");

// Every skill muted, and no skills at all: no empty section, no stray heading.
const allMuted = buildRlmTsPrompt({ cwd: "/tmp", skills: synthetic.filter((s) => s.disableModelInvocation) });
if (allMuted.includes("# Skills") || allMuted.includes("<available_skills>")) {
  fail("B all-muted still rendered a skills section");
}
if (buildRlmTsPrompt({ cwd: "/tmp", skills: [] }).includes("# Skills")) fail("B empty array rendered a section");
if (buildRlmTsPrompt({ cwd: "/tmp" }).includes("# Skills")) fail("B omitted skills rendered a section");
console.log("B empty cases render nothing");

// --- 2. rendering matches pi's own output, verbatim -------------------------
const rendered = buildRlmTsPrompt({ cwd: "/tmp", skills: synthetic });
for (const line of formatSkillsForPrompt(synthetic).trim().split("\n")) {
  if (!rendered.includes(line)) fail("C prompt diverges from pi's formatter:", JSON.stringify(line));
}
console.log("C matches pi's formatter verbatim");

// --- 3. the read-tool pointer is corrected for RLM --------------------------
// pi's text says "use the read tool"; under RLM read is only tools.read.
if (!rendered.includes("tools.read({ path })")) fail("D no tools.read pointer for loading skills");
console.log("D tools.read pointer present");

// --- 4. against this machine's real skills ----------------------------------
const loaded = loadSkills({ cwd: process.cwd(), agentDir: AGENT_DIR, skillPaths: [], includeDefaults: true });
const muted = loaded.skills.filter((s) => s.disableModelInvocation);
const visible = loaded.skills.filter((s) => !s.disableModelInvocation);
const live = buildRlmTsPrompt({ cwd: "/tmp", skills: loaded.skills });
const names = [...live.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => m[1]);
if (names.length !== visible.length) {
  fail("E rendered count != pi-visible count", names.length, visible.length);
}
for (const s of muted) {
  if (names.includes(s.name)) fail("E muted skill rendered:", s.name);
}
// Ordering: the roster must precede the AGENTS.md rules that route to it.
const withContext = buildRlmTsPrompt({
  cwd: "/tmp",
  skills: loaded.skills,
  contextFiles: [{ path: "AGENTS.md", content: "routes to skills" }],
});
if (visible.length > 0 && !(withContext.indexOf("# Skills") < withContext.indexOf("# Project Context"))) {
  fail("E skills section must come before Project Context");
}
console.log(`E live skills: ${loaded.skills.length} loaded, ${muted.length} muted, ${names.length} rendered`);

// --- 5. nothing hardcoded ---------------------------------------------------
// A skill name baked into the patch surface would survive the user renaming,
// muting, or deleting that skill — the failure mode this patch exists to avoid.
for (const s of loaded.skills.slice(0, 400)) {
  if (promptSrc.includes(`"${s.name}"`) || indexSrc.includes(`"${s.name}"`)) {
    fail("F skill name hardcoded in source:", s.name);
  }
}
if (/skills\/[a-z0-9-]+\/SKILL\.md/.test(promptSrc + indexSrc)) {
  fail("F a concrete SKILL.md path is hardcoded in source");
}
console.log("F no skill names or paths hardcoded");

console.log("all restore-skills checks passed");

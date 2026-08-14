# pi-rlm keep host surface

Supersedes `keep-extension-tools.md` (patch id `pi-rlm-keep-extension-tools`),
which covered part 1 only. Merged into one patch — see *Why one patch* below.

## Problem
Upstream RLM replaces two things pi has already resolved, and both replacements
drop what they do not explicitly copy forward.

**1. The model tool surface.** `setActiveTools(["execute"])` leaves only
`execute`; the seven pi builtins are bridged as `tools.*` inside the evaluator.
Extension tools (ask_user_question, advisor, subagent, intercom, todo,
web_search, ...) disappear from the model list. Session/UI tools cannot be
reimplemented inside a cell (`tools.*` has no ExtensionContext), so RLM sessions
lose structured questions, advisor review, and host-side delegation unless
another extension happens to re-append itself on `before_agent_start`.

**2. The system prompt.** `before_agent_start` returns a wholesale replacement
built from `systemPromptOptions`, but narrows that payload to `contextFiles`:

```ts
const options = (event as { systemPromptOptions?: { contextFiles?: ... } }).systemPromptOptions;
```

`systemPromptOptions.skills` is a sibling field pi has already populated
(`BuildSystemPromptOptions.skills?: Skill[]`). It is structurally invisible to
that cast, so **every skill is silently dropped** — no error, no empty section,
the model simply never learns any skill exists. On this machine that meant an
AGENTS.md section routing to `sherlog` / `mainline` / `herdr-orchestration` /
`pi-intercom` while the model could not see them: instructions pointing at
capabilities that were never presented.

## Local fix

### Part 1 — tools: keep-all with a short drop list (not a long allowlist)
1. **`src/extension/keep-tools.ts`** — `resolveRlmDropSet` / `resolveRlmActiveTools`
   - Default drop: the seven bridged builtins + `compaction_continue_state` /
     `watchdog_answer`
   - `PI_RLM_DROP_TOOLS` replaces the *extra* drop list (empty string = extras none)
   - `PI_RLM_KEEP_BUILTINS=1` also keeps read/bash/... model-visible
2. **`session_start` / `before_agent_start`** — set active tools via keep-all
   instead of `["execute"]`; re-assert each turn
3. **`prompt.ts`** — when host tools remain, add a "Model-visible host tools"
   section with division-of-labour guidance (execute for files/data; host tools
   for session UI / delegation)

### Part 2 — skills: pass through, decide nothing
1. **`index.ts`** — widen the cast to read `skills` alongside `contextFiles` and
   forward it untouched. No filtering, no enumeration, no name lists.
2. **`prompt.ts`** — render via pi's own exported `formatSkillsForPrompt`, so
   `disable-model-invocation` and the `<available_skills>` XML shape stay pi's
   decision and cannot drift from a local copy. Section is omitted entirely when
   nothing is visible.
3. **The `read`-tool gate is reproduced by intent, not by literal.** pi gates its
   skills section on `read` being on the model surface (`if (hasRead && ...)`),
   because a skill is an instruction to go read a file. Under RLM the capability
   exists as `tools.read` while the *name* is absent, so copying the check would
   suppress every skill. The section instead points at `tools.read({ path })` and
   tells the model to follow a skill's meaning rather than its literal tool names.
4. **Ordering** — the roster is emitted before `# Project Context`, so AGENTS.md
   rules that route to skills by name are read with that roster already in view.

What stays configuration, not code: which skills load at all (pi's user/project
dirs and `--skill` paths) and which may auto-trigger (each skill's
`disable-model-invocation`). Verified by `verify-pi-rlm-restore-skills.mjs`
check F, which fails if any skill name or concrete SKILL.md path appears in the
patched source.

Companion local change (not in this package patch):
`~/.pi/agent/extensions/rlm-toggle.ts` + `rlm-keep-tools.ts` apply the same tool
surface so the force-on default path cannot collapse back to execute-only.

## Why one patch
Tools and skills are one patch because the skills change edits lines the tools
change itself adds (the `systemPromptOptions` cast, `hostToolSummaries`, and the
`RlmPromptOptions` field block). As two manifest entries the second breaks the
first's reverse-detection: on the final tree `patch --reverse --dry-run` of the
tools patch fails, `patch_state` reports `conflict`, and both `check` and
`apply` exit 1 — which makes pi's post-update hook fail even though the tree is
correct. Measured, not assumed: two entries gave
`[pi-rlm-keep-extension-tools] cannot apply (conflict)` / exit 1; merged gives
status/check/apply all exit 0.

`hang-timeouts` stays a separate patch: it touches different regions and
different files, and reverse-detects cleanly alongside this one.

## Deliberately not included
- Bridging extension `execute` into evaluator `tools.*` (needs ToolDefinition
  access pi's public ExtensionAPI does not expose)
- Long per-tool allowlists
- Any local reimplementation of pi's skill filtering or XML format

## Upstream path
Two asks, both small:
1. `ExtensionAPI.getToolDefinition(name)` + an optional RLM hook to mount or keep
   selected tools.
2. `before_agent_start` prompt replacement should either forward the whole
   `systemPromptOptions` or make dropping `skills` explicit. A replacement prompt
   silently discarding a populated sibling field is a footgun for any extension
   that rebuilds the prompt.

Until then this stays a local patch stacked on hang-timeouts.

## Applies on
`@shift-labs/pi-rlm@0.4.0` **after** `0.4.0-hang-timeouts.patch`.

## Verify
```
bun local-patches/scripts/verify-pi-rlm-keep-extension-tools.mjs
cd ~/.pi/agent/npm && bun local-patches/scripts/verify-pi-rlm-restore-skills.mjs
```

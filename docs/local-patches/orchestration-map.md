# orchestration-map: one-line `subagent` vs `rlm.run` distinction in the RLM prompt

## Problem

Under RLM the delegation section ("Delegating to sub-agents") teaches
`rlm.run` exclusively. The `subagent` host tool (pi-subagents) is a
*different* mechanism — a full peer session with a `contact_supervisor`
escalation channel — but nothing always-on says so. A fresh session sees both
`rlm.run` (in the evaluator namespace) and `subagent` (in the host-tool
name list) with no guidance on which to pick, so it defaults to `rlm.run` and
silently loses the escalation capability it would need for long-running workers.

`prompt-slim` had removed the original division-of-labour note because at the
time `subagent` was dropped from the tool surface (bin/pi listed it in
`PI_RLM_DROP_TOOLS`). That drop is now removed, so `subagent` is back and the
distinction is live again.

## Local change

One sentence appended to `SUBAGENT_GUIDANCE`:

> `subagent` (host tool, when present) spawns a full peer session with a
> `contact_supervisor` escalation channel — use it for long-running workers
> that must escalate decisions; `rlm.run` is the lightweight fan-out path
> whose child only writes an output file and cannot escalate.

Stacks on hang-timeouts + keep-host-surface + prompt-slim.

## Upstream potential

An upstream PR could fold this into `SUBAGENT_GUIDANCE` directly, or gate it
on the presence of the `subagent` tool (the "when present" hedge is because
the tool can be dropped via `PI_RLM_DROP_TOOLS`).

# pi-rlm hang timeouts

## Problem
An `execute` cell that polls subagents, sleeps, or awaits something that never resolves has no
deadline of its own. Upstream's only escape is cooperative: pi passes an abort signal when the
**user presses Esc**, and the extension then discards the wedged engine (`EngineBusyError` →
`lifecycle.discard()`). That path works. What it requires is a human sitting there.

Unattended, nothing stops the cell. Measured against clean 0.4.0 with the cell timer disabled:
an aborted-but-uncooperative `while(true){}` leaves the guest alive at **99% CPU**, and with no
signal at all the cell was still hanging when the test gave up at 8s. Subagents make this the
common case rather than the exotic one — a child pi process has no user to press Esc for it.

Bridged `tools.bash` has a second, unrelated gap: pi's bash-timeout extension injects defaults on
the `tool_call` hook, which the RLM bridge never takes, so bridged bash is strictly worse than
stock pi.

## Local fix — host-side hard rails only
All three are passive timers in the pi process. They do not depend on what the model writes, on
guest cooperation, or on anyone being present.

1. **Cell wall-clock timeout** (default 300s, `PI_RLM_CELL_TIMEOUT_MS`, 0 disables) — raises
   `CellTimeoutError`, and on timeout tears the guest down with `killSync()`. The teardown is the
   half that matters: cooperative abort cannot interrupt a synchronous loop, so without it the
   cell "ends" while the guest keeps burning a core.
2. **Bridged bash default timeout** (180s, `PI_RLM_BASH_TIMEOUT_SECONDS` /
   `PI_BASH_DEFAULT_TIMEOUT_SECONDS`) — closes the `tool_call` gap above.
3. **Subagent max lifetime** (600s, `PI_RLM_SUBAGENT_TIMEOUT_MS`) — SIGTERM then SIGKILL, and
   finalizes the child's frame record so a killed child cannot linger as `"running"`.

## Deliberately not included
- **`rlm.wait` bounded-join API** (was #2) and **prompt doctrine** (was #5), both dropped at
  0.4.0. They were model-facing: they tried to stop the model from *writing* an unbounded loop,
  whereas the rails above make it not matter if it does. Upstream now has its own opinionated
  `SUBAGENT_GUIDANCE` (fan-out-first, teaches a `listSubagents` poll loop), and a local patch
  fighting it for the same prompt real estate would need re-resolving on every upstream edit —
  which is exactly what happened at 0.4.0. Upstream owns model guidance; this patch owns the
  fuses. Dropping both also removed the only two conflicting files.
- A note on the dropped doctrine's substance: the `Promise.all(handles.map(rlm.wait))` fan-in it
  recommended was actively worse than upstream's single poll loop — `rlm.wait` defaults to
  `killOnTimeout: true`, so one slow child gets deleted while its siblings' promises dangle, and
  N concurrent waiters each re-fetch the same full `list_subagents` payload every 2s.

## Upstream ask
Please consider shipping as first-class safety rails:
- cell wall-clock timeout with a clear `CellTimeoutError`, including guest teardown (cooperative
  abort alone cannot stop a synchronous loop)
- default timeout on mounted bash, matching the host bash-timeout extension's contract
- child process max lifetime

Repo: https://github.com/shift-labs-ai/pi-rlm

## Rebase log
- 0.3.0 (2026-08-09): upstream added npm: imports, incremental/lazy snapshots, `rlm.forget`,
  and cell-scoped host_request attribution (`cellRecords`, mandatory `HostRequestContext.signal`,
  `hostAbort.abort()` on settle). None of the timeout rails landed upstream, so the patch was
  rebased unchanged in intent. Interaction check: `requestCancel` still guards on
  `settled || abortRequested`, so upstream's new settle-time abort cannot double-fire it, and
  `rememberCell(cellId, ...)` stays intact ahead of the timer setup.
- 0.4.0: upstream added durable frame records (`frames.ts`, `<childId>.json` per child, stack
  view), availability-aware subagent model defaults (`resolveDefaultSubagentModel`), a models
  section in the prompt, and a rewritten fan-out-first `SUBAGENT_GUIDANCE`. Still no timeout
  rails upstream. Patch **narrowed from 6 files/365 lines to 4 files/228 lines**:
  - Dropped `engine/guest.ts` and `extension/prompt.ts` entirely (see "Deliberately not
    included"). Both files are now pristine upstream.
  - `engine/index.ts`: the `CellTimeoutError` message no longer advertises `rlm.wait` (it would
    name a nonexistent API); it now suggests giving loops an explicit deadline instead.
  - `extension/subagents.ts`: the lifetime timer also finalizes the **frame record**
    (`status: "error"`, `exit_code`, `finished_at`) when it hard-kills a child, so a killed child
    cannot stay `"running"` in the new stack view. `clearLifetime()` re-attached to the upstream
    exit/error handlers that now write frames.
  - `extension/index.ts`: kept only the `CellTimeoutError` → `lifecycle.discard()` hunk. An old
    `rlm_mode` tool-preservation hunk was dropped as unrelated to timeouts; it served
    `extensions.disabled/rlm-toggle.ts`, which is disabled. If that extension is re-enabled, note
    that pi-rlm's `before_agent_start` resets active tools to `["execute"]`, so `rlm_mode`
    survives only if rlm-toggle's handler runs after it.

## Verification
`scripts/verify-pi-rlm-hang-timeouts.mjs` asserts the rails are present **and** that `rlm.wait`
is fully gone (a stale reference in the timeout message would advertise a missing API), then
covers: sync infinite loop times out *and the guest process is actually dead*; bash injection;
an unattended async poll loop over a never-settling child; an unattended never-resolving await.
`scripts/verify-pi-rlm-subagent-timeout.mjs` covers the child hard-kill.

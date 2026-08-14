# pi-rlm × DSH Code Mode: execution-contract port

Local patch `0.4.0-code-contract.patch` (stacks on hang-timeouts → keep-host-surface → prompt-slim → orchestration-map).

## What was ported, and what was deliberately kept

DSH Code Mode (`run_code`) and pi-rlm (`execute`) share one shape — the model
writes an async TypeScript body that calls host tools — but they draw the
execution boundary differently:

| Concern | DSH Code Mode | pi-rlm before this patch | After this patch |
| --- | --- | --- | --- |
| State between runs | none (fresh worker per run) | persistent Bun namespace + snapshot | unchanged (RLM's advantage kept) |
| Tool namespace | own-keys-only null-prototype object | plain object literal | null-prototype, own keys only |
| Wire values | lossless-JSON snapshot, fail-loud | `JSON.stringify` (silent `undefined` drop, raw BigInt throw) | explicit lossless-JSON gate with teaching errors; `undefined` keeps legacy drop semantics |
| Output budget | combined logs+result byte cap + output-limit | per-stream char caps | per-stream caps + shared combined budget + truncation flags |
| Dispatch history | durable `tool/code-dispatch` events, only curated result enters model history | none | durable JSONL dispatch ledger keyed by cell |
| Cell intent | required `description` | none | optional `description` riding cell record into ledger |
| Sandbox | worker thread, containment ≠ security boundary | full Bun/Node (documented) | unchanged (documented) |

Deliberately **not** ported (RLM keeps its advantages): persistent namespace and
snapshot/restore, recursive `rlm.run` subagents with depth limits, the Pi host
tool bridge, and the cell renderer. Deliberately **not** copied either: DSH's
worker-thread isolation (pi-rlm's guest is already a separate Bun process with a
nonce-authenticated fd-3 protocol channel) and DSH's fresh-runtime model (state
persistence is the reason this plugin exists).

## Upstream candidates

- `src/engine/protocol.ts`: `normalizeLosslessJsonValue` is standalone and reusable.
- `src/engine/index.ts`: `dispatchLog` option + `appendDispatchLog`; combined
  budget fields on `ExecuteResult`.
- `src/engine/guest.ts`: null-prototype tools handle.

## Env knobs

- `PI_RLM_MAX_COMBINED_OUTPUT_CHARS`: combined stdout+stderr+result budget
  (default 3 × maxOutputChars, preserving the legacy worst case).
- Dispatch ledger: `<cwd>/.pi-rlm/<session>/dispatch.jsonl`, one JSON line per
  bridged host request (cellId, requestType, status, durationMs, capped result).

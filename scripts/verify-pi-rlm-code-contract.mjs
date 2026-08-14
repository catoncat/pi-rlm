#!/usr/bin/env bun
// Verifies the code-contract patch: lossless-JSON boundary, null-prototype
// tools handle, optional description + dispatch ledger, combined output budget.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = new URL("..", import.meta.url).pathname; // fork 仓库根目录
const fail = (m, detail) => { console.error("FAIL", m, detail ?? ""); process.exit(1); };

// ── 0. source contract ─────────────────────────────────────────────────────
for (const [rel, needle] of [
  ["src/extension/index.ts", "description: Type.Optional("],
  ["src/extension/index.ts", 'dispatchLog: sessionKey ? { path: join(stateDir, "dispatch.jsonl") }'],
  ["src/extension/index.ts", "description: params.description"],
  ["src/extension/index.ts", "outputLimitReached: r.outputLimitReached"],
  ["src/engine/index.ts", "normalizeLosslessJsonValue"],
  ["src/engine/index.ts", "appendDispatchLog("],
  ["src/engine/index.ts", "maxCombinedOutputChars"],
  ["src/engine/index.ts", "resolveMaxCombinedOutputChars"],
  ["src/engine/index.ts", "outputLimitReached"],
  ["src/engine/guest.ts", "const TOOLS_HANDLE: Record<string, unknown> = Object.create(null)"],
  ["src/engine/guest.ts", "normalizeLosslessJsonValue(payload)"],
  ["src/engine/protocol.ts", "export function normalizeLosslessJsonValue"],
]) {
  const p = join(ROOT, rel);
  if (!existsSync(p) || !readFileSync(p, "utf8").includes(needle)) fail(`missing ${needle} in ${rel}`);
}
console.log("0 source contract ok");

const { normalizeLosslessJsonValue } = await import(join(ROOT, "src/engine/protocol.ts"));

// ── 1. lossless-JSON boundary (unit) ───────────────────────────────────────
const big = normalizeLosslessJsonValue({ x: 1n });
if (big.ok || !/BigInt/.test(big.error.message)) fail("1a BigInt must be rejected with teaching error", big);
const nan = normalizeLosslessJsonValue({ x: Number.NaN });
if (nan.ok || !/non-finite/.test(nan.error.message)) fail("1b NaN must be rejected", nan);
const cyc = { a: {} }; cyc.a = cyc;
const circ = normalizeLosslessJsonValue(cyc);
if (circ.ok || !/circular/.test(circ.error.message)) fail("1c circular must be rejected", circ);
const drop = normalizeLosslessJsonValue({ keep: 1, gone: undefined, arr: [undefined, 2] });
if (!drop.ok) fail("1d valid value must normalize", drop);
if ("gone" in drop.value || drop.value.keep !== 1 || drop.value.arr[0] !== null) fail("1e undefined drop semantics", drop.value);
console.log("1 lossless-json boundary ok");

// ── 2. engine runtime: gate + ledger + budget ───────────────────────────────
const { EngineManager } = await import(join(ROOT, "src/engine/index.ts"));

{
  const e = new EngineManager({ cwd: process.cwd() });
  const r = await e.execute(
    `let gate = false; try { await tools.read({ path: 1n }); } catch (err) { gate = err.message.includes("BigInt"); } gate`,
    { cellId: "cell-gate" },
  );
  await e.dispose().catch(() => {});
  if (r.status !== "ok" || r.result !== "true") fail("2a BigInt bridge args must hit the lossless-json gate", r);
  console.log("2a bridge json gate ok");
}

{
  const dir = mkdtempSync(join(tmpdir(), "rlm-code-contract-"));
  const logPath = join(dir, "dispatch.jsonl");
  const e = new EngineManager({
    cwd: process.cwd(),
    dispatchLog: { path: logPath },
    hostHandlers: {
      probe: async (payload) => ({ echo: payload.x }),
      bad: async () => ({ oops: 10n }),
    },
  });
  const r = await e.execute(
    `const h = await rlm.hostRequest("probe", { x: 7 }); h.echo === 7`,
    { cellId: "cell-ledger", description: "ledger test" },
  );
  if (r.status !== "ok" || r.result !== "true") fail("2b probe cell failed", r);
  let lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const entry = lines.find((l) => l.requestType === "probe");
  if (!entry || entry.status !== "ok" || entry.cellId !== "cell-ledger" || entry.cellDescription !== "ledger test" || entry.result?.echo !== 7) fail("2c dispatch ledger entry wrong", entry);

  const r2 = await e.execute(
    `let gate = false; try { await rlm.hostRequest("bad", {}); } catch (err) { gate = err.message.includes("BigInt"); } gate`,
    { cellId: "cell-bad" },
  );
  if (r2.status !== "ok" || r2.result !== "true") fail("2d host reply gate failed", r2);
  lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const badEntry = lines.find((l) => l.requestType === "bad");
  if (!badEntry || badEntry.status !== "error" || !/BigInt/.test(badEntry.errorMessage ?? "")) fail("2e error dispatch entry wrong", badEntry);
  await e.dispose().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
  console.log("2b-e dispatch ledger + reply gate ok");
}

{
  const e = new EngineManager({ cwd: process.cwd() });
  const r = await e.execute(
    `console.log("a".repeat(400)); console.error("b".repeat(400)); "c".repeat(400)`,
    { cellId: "cell-budget", maxOutputChars: 200, maxCombinedOutputChars: 500 },
  );
  await e.dispose().catch(() => {});
  if (r.status !== "ok") fail("2f budget cell failed", r);
  if (!r.stdoutTruncated || !r.stderrTruncated || !r.resultTruncated || !r.outputLimitReached) fail("2g combined budget flags missing", r);
  console.log("2f-g combined output budget ok");
}

console.log("all code-contract checks passed");

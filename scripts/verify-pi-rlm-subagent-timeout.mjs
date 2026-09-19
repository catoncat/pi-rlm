#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_RLM_SUBAGENT_TIMEOUT_MS = "700";
const { createSubagentHost } = await import(new URL("../src/extension/subagents.ts", import.meta.url).pathname);
const dir = mkdtempSync(join(tmpdir(), "pi-rlm-sub-timeout-"));
const pidFile = join(dir, "grandchild.pid");
const host = createSubagentHost({
	cwd: process.cwd(),
	subagentDir: dir,
	defaultModel: "x/y",
	depth: 0,
	maxDepth: 2,
	spawnCommand: () => ({ command: "bash", args: ["-lc", `sleep 30 & echo $! > ${pidFile}; wait`] }),
});
try {
	await host.handlers["rlm.run"]({ prompt: "x" });
	await Bun.sleep(1_400);
	const listed = await host.handlers["rlm.list_subagents"]({});
	const entry = listed.subagents?.[0];
	if (entry?.status !== "error" || entry.timed_out !== true) {
		console.error(listed);
		process.exitCode = 1;
	} else {
		const pid = Number(readFileSync(pidFile, "utf8"));
		let alive = true;
		try {
			process.kill(pid, 0);
		} catch {
			alive = false;
		}
		if (alive) {
			console.error("grandchild survived process-group timeout", pid);
			process.exitCode = 1;
		} else {
			console.log("subagent process-group timeout ok");
		}
	}
} finally {
	host.killAll();
	rmSync(dir, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);

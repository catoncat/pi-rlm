/**
 * The subagent contract: what a parent gets back when it delegates.
 *
 * Spawning returns a handle at admission, the registry tracks each child's
 * fate, and results arrive as files. These tests inject the spawn command so
 * they exercise the contract without launching real agents; that the real
 * command works is established separately against a live child.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineManager } from "../src/engine/index.js";
import {
	buildDefaultSpawnSpec,
	createSubagentHost,
	defaultSubagentName,
	type SubagentEntry,
	toPublicEntry,
} from "../src/extension/subagents.js";

const managers: EngineManager[] = [];
const tempDirs: string[] = [];

function tempDir(): string {
	const d = mkdtempSync(join(tmpdir(), "pi-rlm-sub-"));
	tempDirs.push(d);
	return d;
}

afterEach(async () => {
	await Promise.allSettled(managers.splice(0).map((m) => m.kill()));
	for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeHost(dir: string, script = 'echo "child-output-proof"') {
	return createSubagentHost({
		cwd: dir,
		subagentDir: dir,
		defaultModel: "anthropic/haiku",
		depth: 0,
		maxDepth: 2,
		spawnCommand: () => ({ command: "sh", args: ["-c", script] }),
	});
}

describe("subagent host", () => {
	test("rlm.run admits immediately with a handle; child result lands in output_file", async () => {
		const d = tempDir();
		const host = fakeHost(d);
		const m = new EngineManager({ hostHandlers: host.handlers });
		managers.push(m);
		const r = await m.execute(
			'const h = await rlm.run("summarize the repo"); `${h.rlm_child_id.startsWith("sub-")}:${h.name.startsWith("subagent-")}`',
		);
		expect(r.status).toBe("ok");
		expect(r.result).toContain("true:true");

		// Child (sh -c echo) finishes quickly; its stdout is the output file.
		await new Promise((resolve) => setTimeout(resolve, 300));
		const entry = host.entries()[0];
		expect(entry.status).toBe("completed");
		expect(readFileSync(entry.output_file, "utf8")).toContain("child-output-proof");
	});

	test("guest can poll rlm.listSubagents until completed, then read the output file in-cell", async () => {
		const d = tempDir();
		const host = fakeHost(d);
		const m = new EngineManager({ hostHandlers: host.handlers });
		managers.push(m);
		const r = await m.execute(
			`
			const h = await rlm.run("do the thing");
			let entry;
			for (let i = 0; i < 50; i++) {
				const { subagents } = await rlm.listSubagents();
				entry = subagents.find((s) => s.rlm_child_id === h.rlm_child_id);
				if (entry.status !== "running") break;
				await new Promise((r) => setTimeout(r, 100));
			}
			const output = await Bun.file(entry.output_file).text();
			\`\${entry.status}|\${output.trim()}\`
			`,
		);
		expect(r.status).toBe("ok");
		expect(r.result).toContain("completed|child-output-proof");
	});

	test("failed child is reported as error in the registry", async () => {
		const d = tempDir();
		const host = fakeHost(d, "exit 3");
		const m = new EngineManager({ hostHandlers: host.handlers });
		managers.push(m);
		await m.execute('await rlm.run("doomed task");');
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(host.entries()[0].status).toBe("error");
	});

	test("depth limit refuses recursion beyond maxDepth", async () => {
		const d = tempDir();
		const host = createSubagentHost({
			cwd: d,
			subagentDir: d,
			defaultModel: "anthropic/haiku",
			depth: 2,
			maxDepth: 2,
			spawnCommand: () => ({ command: "sh", args: ["-c", "echo nope"] }),
		});
		const m = new EngineManager({ hostHandlers: host.handlers });
		managers.push(m);
		const r = await m.execute('await rlm.run("too deep");');
		expect(r.status).toBe("error");
		expect(r.error?.message).toContain("depth");
	});

	test("delete_subagent kills a running child and removes it", async () => {
		const d = tempDir();
		const host = fakeHost(d, "sleep 60");
		const m = new EngineManager({ hostHandlers: host.handlers });
		managers.push(m);
		const r = await m.execute(
			'const h = await rlm.run("long task"); const del = await rlm.deleteSubagent(h.rlm_child_id); del.subagent.rlm_child_id === h.rlm_child_id',
		);
		expect(r.status).toBe("ok");
		expect(r.result).toContain("true");
		expect(host.entries()).toHaveLength(0);
	});

	// The frame record is the durable half of the registry: rendering, lineage
	// across processes, and post-mortem inspection all read these files, so a
	// spawn must leave one behind and an exit must finalize it in place.
	test("spawn writes a frame record; exit finalizes it; the child learns its own id", async () => {
		const d = tempDir();
		const host = createSubagentHost({
			cwd: d,
			subagentDir: d,
			defaultModel: "anthropic/haiku",
			depth: 0,
			maxDepth: 2,
			selfChildId: "sub-parent-id",
			spawnCommand: () => ({ command: "sh", args: ["-c", 'echo "my-id:$PI_RLM_CHILD_ID"'] }),
		});
		const m = new EngineManager({ hostHandlers: host.handlers });
		managers.push(m);
		const r = await m.execute('await rlm.run("audit the pdfs");', { cellId: "cell-spawn-site" });
		expect(r.status).toBe("ok");
		const entry = host.entries()[0];
		const metaPath = join(d, `${entry.rlm_child_id}.json`);
		const meta = JSON.parse(readFileSync(metaPath, "utf8"));
		expect(meta.rlm_child_id).toBe(entry.rlm_child_id);
		expect(meta.prompt).toBe("audit the pdfs");
		expect(meta.status).toBe("running");
		expect(meta.spawn_cell_id).toBe("cell-spawn-site");
		expect(meta.parent_child_id).toBe("sub-parent-id");
		expect(typeof meta.spawned_at).toBe("string");

		await new Promise((resolve) => setTimeout(resolve, 300));
		const final = JSON.parse(readFileSync(metaPath, "utf8"));
		expect(final.status).toBe("completed");
		expect(typeof final.finished_at).toBe("string");
		// The child can label its own records: lineage links grandchildren to it.
		expect(readFileSync(entry.output_file, "utf8")).toContain(`my-id:${entry.rlm_child_id}`);
	});

	test("delete_subagent removes the frame record along with the registry entry", async () => {
		const d = tempDir();
		const host = fakeHost(d, "sleep 60");
		const m = new EngineManager({ hostHandlers: host.handlers });
		managers.push(m);
		await m.execute('const h = await rlm.run("long task"); await rlm.deleteSubagent(h.rlm_child_id);');
		expect(host.entries()).toHaveLength(0);
		const { readdirSync } = await import("node:fs");
		expect(readdirSync(d).filter((f) => f.endsWith(".json"))).toHaveLength(0);
	});

	test("names: explicit name respected, oversized rejected, default is a slug", async () => {
		const d = tempDir();
		const host = fakeHost(d);
		const m = new EngineManager({ hostHandlers: host.handlers });
		managers.push(m);
		const r1 = await m.execute('(await rlm.run("t", { name: "my-worker" })).name');
		// The registry speaks the same field: a poll matching on `name` must work.
		const listed = await m.execute(
			'(await rlm.listSubagents()).subagents.find((s) => s.name === "my-worker") !== undefined',
		);
		expect(listed.result).toContain("true");
		expect(r1.result).toContain("my-worker");
		const r2 = await m.execute(`await rlm.run("t", { name: "${"x".repeat(80)}" });`);
		expect(r2.status).toBe("error");
		expect(r2.error?.message).toContain("64");
		expect(defaultSubagentName("Fix the parser bug!", "sub-abc12345")).toMatch(
			/^subagent-fix-the-parser-bug-[a-z0-9]+$/,
		);
	});

	// ── the registry answers as fully as disk ─────────────────────────────────
	// A parent that polls listSubagents must be able to tell a timeout (exit 124)
	// from a business failure (exit 1), and to collect durations for load stats —
	// with status alone both look identical. The public entry must therefore
	// carry exit_code, spawned_at, finished_at, duration_ms, and a reason on error.

	test("toPublicEntry exposes exit_code, spawn/finish timestamps, duration_ms, and reason", async () => {
		const d = tempDir();
		const outputFile = join(d, "child.output.md");
		writeFileSync(outputFile, "Error: Failed to load extension: path does not exist\n");
		const settled: SubagentEntry = {
			rlm_child_id: "sub-1",
			session_name: "worker",
			session_dir: d,
			output_file: outputFile,
			model: "anthropic/haiku",
			status: "error",
			exit_code: 3,
			spawned_at: "2026-08-14T10:00:00.000Z",
			finished_at: "2026-08-14T10:00:01.250Z",
			pid: undefined,
		};
		const pub = toPublicEntry(settled);
		expect(pub.exit_code).toBe(3);
		expect(pub.status).toBe("error");
		expect(pub.spawned_at).toBe("2026-08-14T10:00:00.000Z");
		expect(pub.finished_at).toBe("2026-08-14T10:00:01.250Z");
		expect(pub.duration_ms).toBe(1250);
		expect(pub.reason).toContain("Failed to load extension");

		// A still-running child: no finished_at, no duration_ms, no reason, but a
		// spawned_at so the parent can compute elapsed itself.
		const running = toPublicEntry({ ...settled, status: "running", finished_at: undefined, exit_code: null });
		expect(running.finished_at).toBeUndefined();
		expect(running.duration_ms).toBeUndefined();
		expect(running.reason).toBeUndefined();
		expect(typeof running.spawned_at).toBe("string");

		// A completed child exposes exit_code 0 and a duration but no reason.
		const done = toPublicEntry({ ...settled, status: "completed", exit_code: 0 });
		expect(done.exit_code).toBe(0);
		expect(done.reason).toBeUndefined();
		expect(typeof done.duration_ms).toBe("number");
	});

	test("failed child's listSubagents entry carries exit_code, timestamp, duration, and reason", async () => {
		const d = tempDir();
		const host = fakeHost(d, 'echo "boom: extension path does not exist" >&2; exit 3');
		const m = new EngineManager({ hostHandlers: host.handlers });
		managers.push(m);
		const r = await m.execute(`
			const h = await rlm.run("doomed task");
			let entry;
			for (let i = 0; i < 50; i++) {
				const { subagents } = await rlm.listSubagents();
				entry = subagents.find((s) => s.rlm_child_id === h.rlm_child_id);
				if (entry.status !== "running") break;
				await new Promise((r) => setTimeout(r, 100));
			}
			\`exit=\${entry.exit_code}|status=\${entry.status}|fin=\${typeof entry.finished_at}|dur=\${typeof entry.duration_ms}|reason=\${entry.reason ?? ""}\`
		`);
		expect(r.status).toBe("ok");
		expect(r.result).toContain("exit=3");
		expect(r.result).toContain("status=error");
		expect(r.result).toContain("fin=string");
		expect(r.result).toContain("dur=number");
		expect(r.result).toContain("reason=boom: extension path does not exist");
	});

	// ── pre-flight guard at admission ──────────────────────────────────────────
	// The child spawns `pi -p --no-extensions -e <extensionPath>`. If that path
	// has gone missing (npm install reset node_modules, moved checkout), admission
	// used to still succeed and the failure surfaced only seconds later by
	// polling. The guard must fail the rlm.run call synchronously instead.

	test("buildDefaultSpawnSpec stats the extension path and fails fast when it is missing", () => {
		const missing = join(tmpdir(), "definitely-not-here", "index.ts");
		expect(() => buildDefaultSpawnSpec("anthropic/haiku", "worker", "/tmp/subs", "task", missing)).toThrow(
			/rlm.run refused.*does not exist/s,
		);

		// A real, existing path builds the spec with -e pointing at it.
		const d = tempDir();
		const real = join(d, "index.ts");
		writeFileSync(real, "");
		const spec = buildDefaultSpawnSpec("anthropic/haiku", "worker", d, "task", real);
		expect(spec.command).toBe("pi");
		expect(spec.args).toContain("-e");
		expect(spec.args).toContain(real);
		expect(spec.args[spec.args.length - 1]).toBe("task");
	});
});

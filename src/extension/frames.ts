/**
 * Frame records: the durable half of the subagent registry.
 *
 * Every process in the agent tree writes one JSON record per child it spawns,
 * under its own `.pi-rlm/<session>/subagents/` in the shared cwd. The full
 * tree across all depths is therefore one directory walk away — no IPC, no
 * aggregation daemon, and it works post-mortem after every process has exited.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface FrameRecord {
	rlm_child_id: string;
	name: string;
	prompt: string;
	model: string;
	/** "lost" is display truth only: derived at read time, never written. */
	status: "running" | "completed" | "error" | "lost";
	/** ISO timestamps; age math needs no live process. */
	spawned_at: string;
	finished_at?: string;
	/** The cell (pi toolCallId) whose rlm.run created this frame. */
	spawn_cell_id?: string;
	/** The agent that spawned this frame, linking depth n+1 to depth n. */
	parent_child_id?: string;
	exit_code?: number | null;
	/** A hard lifetime deadline signalled this child group. */
	timed_out?: boolean;
	pid?: number;
}

/** Signal 0 probes without killing; ESRCH means the process is gone. */
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function isFrameRecord(value: unknown): value is FrameRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.rlm_child_id === "string" &&
		typeof record.name === "string" &&
		typeof record.status === "string" &&
		typeof record.spawned_at === "string"
	);
}

/**
 * Read every frame record under `cwd/.pi-rlm/`. Sessions' subagent dirs also
 * hold output files and pi session files; only parseable records load, and a
 * corrupt file costs itself, not the walk.
 */
export function readFrameRecords(cwd: string): FrameRecord[] {
	const root = join(cwd, ".pi-rlm");
	let sessions: string[];
	try {
		sessions = readdirSync(root);
	} catch {
		return [];
	}
	const records: FrameRecord[] = [];
	for (const session of sessions) {
		const dir = join(root, session, "subagents");
		let files: string[];
		try {
			files = readdirSync(dir);
		} catch {
			continue;
		}
		for (const file of files) {
			if (!file.endsWith(".json")) continue;
			try {
				const parsed: unknown = JSON.parse(readFileSync(join(dir, file), "utf8"));
				if (!isFrameRecord(parsed)) continue;
				// A record can outlive its writer: if that process was killed
				// abruptly, the final status write never happened and "running"
				// would be a permanent lie. Downgrade at read time; the file is
				// left as written.
				if (parsed.status === "running" && typeof parsed.pid === "number" && !isProcessAlive(parsed.pid)) {
					records.push({ ...parsed, status: "lost" });
				} else {
					records.push(parsed);
				}
			} catch {
				// Corrupt or mid-write; the next poll will see the finished write.
			}
		}
	}
	return records;
}

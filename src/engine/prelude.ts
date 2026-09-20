/**
 * Names the guest binds into every fresh namespace before the first cell.
 *
 * Functions cannot ride the snapshot, so after every engine restart the model
 * used to re-import the same handful of fs/path/os helpers — and read a
 * "Failed: existsSync, readdirSync, …" line about the ones it had bound the
 * time before. Preloading them makes the restart invisible for the common
 * case. The list lives here, outside guest.ts, so the prompt can name exactly
 * what is preloaded without importing the guest module (which starts the
 * evaluator's message loop on load).
 */
export const PRELUDE_MODULES = {
	"node:fs": [
		"existsSync",
		"readFileSync",
		"writeFileSync",
		"appendFileSync",
		"readdirSync",
		"statSync",
		"mkdirSync",
		"rmSync",
		"renameSync",
		"copyFileSync",
	],
	"node:path": ["join", "resolve", "dirname", "basename", "extname", "relative"],
	"node:os": ["homedir", "tmpdir"],
} as const;

export type PreludeModule = keyof typeof PRELUDE_MODULES;

/** One line for the system prompt: what is already bound, grouped by module. */
export function describePrelude(): string {
	return Object.entries(PRELUDE_MODULES)
		.map(([module, names]) => `${module}: ${names.join(", ")}`)
		.join("; ");
}

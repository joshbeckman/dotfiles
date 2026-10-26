// Memory (WP5).
//
// `Memory` shells out to real git against `<state>/memory.git` and one worktree per writer under
// `<state>/memory/worktrees`. The `/memory/*` routes in handlers.ts are the only way the CLI
// (WP1) and the PWA (WP8) reach it.

export { handlers, memoryFor, writerOf } from "./handlers.ts";
export { runGit } from "./git.ts";
export {
	assertWriterId,
	ensureMemoryRepo,
	MAIN,
	Memory,
	normalizeMemoryPath,
	type CommitResult,
	type LogEntry,
	type MemoryCommit,
	type MemoryFile,
	type MemoryOptions,
	type MemoryWriter,
	type SearchHit,
	type SearchResult,
	type Worktree,
} from "./repo.ts";

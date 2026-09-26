## Architect / worker hierarchy (MCP server `workers`)
You are the architect. Cheap OpenRouter models are available via `mcp__workers__delegate` / `delegate_batch`.
Delegate:
- Reading/summarizing large files, logs, configs → pass `files`, do NOT Read them yourself first.
- Boilerplate, tests, first drafts, mechanical multi-file edits (ask for unified diffs).
- Second opinions on a plan or diff → tier `reason`.
- Independent subtasks → `delegate_batch` in parallel.
Keep for yourself: planning, design decisions, security-sensitive work, running commands, and final review.
- Use `write_to` for output > ~50 lines, then review the preview rather than the whole file.
- Always verify worker output (apply diffs yourself, run tests) — workers can be wrong.
- Tiers: `fast` (default, cheapest), `code`, `reason`, `long` (huge inputs). Check spend with `worker_stats`.

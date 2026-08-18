# Roadmap

## Milestone 0 - Foundation

- [x] Define canonical and disposable storage boundaries.
- [x] Define stable semantic graph identities.
- [x] Establish the English-only repository policy.
- [x] Deliver a working file-level bootstrap, sync, curate, audit, and status
  loop.
- [x] Add continuous integration.

## Milestone 1 - Structural contributions

- Add Git-aware repository discovery.
- Introduce parser adapters and a language registry.
- Store per-file symbol and relationship contributions.
- Re-resolve only keys affected by changed files.
- Produce deterministic impact sets.

## Milestone 2 - AI bootstrap

- Add provider-neutral summarizer and curator ports.
- Create resumable full-repository summarization jobs.
- Propose stable semantic nodes from summaries and structural facts.
- Add confidence, rationale, and provenance to proposals.
- Support offline and local-model adapters.

## Milestone 3 - Curator workflow

- Build an interactive review queue.
- Merge, split, rename, lock, and connect semantic nodes.
- Show source evidence for every proposed operation.
- Store review decisions as graph patches.

## Milestone 4 - Incremental semantic maintenance

- Map structural deltas to curated impact sets.
- Generate small semantic patches only for affected nodes.
- Auto-apply mechanical provenance updates.
- Require review for classification, deletion, and cross-system edges.
- Add configurable full-audit triggers.

## Milestone 5 - Agent integrations

- [x] Expose graph queries, review state, audit, sync, and guarded curation over
  local stdio MCP.
- Add Codex, Claude Code, Cursor, and editor integrations.
- Provide repository map, semantic search, trace, and impact tools.
- Add token and latency measurements.

## Milestone 6 - Visualization and scale

- Build a focused neighborhood graph instead of rendering every symbol.
- Add semantic and structural layers.
- Add local database projections for very large repositories.
- Support multi-repository workspaces and worktrees.

# Roadmap

## Milestone 0 - Foundation

- [x] Define canonical and disposable storage boundaries.
- [x] Define stable semantic graph identities.
- [x] Establish the English-only repository policy.
- [x] Deliver a working file-level bootstrap, sync, curate, audit, and status
  loop.
- [x] Add continuous integration.

## Milestone 1 - Structural contributions

- [x] Add Git-aware repository discovery.
- [x] Introduce TypeScript/JavaScript, C#, Python, and Lua parser adapters with a shared
  language registry.
- [x] Store per-file symbol and relationship contributions.
- [x] Re-resolve only changed files and files that reference changed definition
  names through a persisted reverse index.
- [x] Produce deterministic symbol search and bounded reference traces.
- [x] Add natural-language structural symbol search and bounded source bodies.
- [x] Combine natural-language ranking and verified source bodies in one-call Agent retrieval.

## Milestone 2 - AI bootstrap

- Define direct provider-neutral summarizer and curator adapter ports.
- [x] Create resumable full-repository Agent summarization jobs.
- [x] Expose complete file summaries and structural facts for stable Agent graph proposals.
- [x] Add confidence, producer, model, risk, and source evidence to summaries.
- Support offline and local-model adapters.

## Milestone 2.5 - Documents and unsupported artifacts

- [x] Inventory Git-visible artifacts outside the eligible-text policy.
- [x] Define deterministic `.strellis.json` and `.strellis.md` projections.
- [x] Guard projection writes with source/content/target validation tokens.
- [x] Detect stale projections with changed-file-only hash refresh.
- [x] Add Markdown heading, table, and link contributions.
- Add Markdown front-matter contributions.
- Add native workbook extraction and code-to-configuration relationships.

## Milestone 3 - Curator workflow

- Build an interactive review queue.
- Merge, split, rename, lock, and connect semantic nodes.
- Show source evidence for every proposed operation.
- [x] Store review decisions as graph patches.

## Milestone 4 - Incremental semantic maintenance

- [x] Map structural deltas to curated impact sets, including both sides of a
  cross-file reference change.
- [x] Generate small semantic draft patches only for affected nodes.
- [x] Prefill mechanical provenance updates for validate-token-apply. Do not
  write them without a validation token.
- [x] Require review for classification, deletion, and cross-system edges.
- [x] Add configurable full-audit triggers based on changes that need semantic
  judgment.

## Milestone 5 - Agent integrations

- [x] Expose graph queries, review state, audit, sync, and guarded curation over
  local stdio MCP.
- [x] Expose structural build, grep, file-symbol, and trace tools over MCP.
- Add Codex, Claude Code, Cursor, and editor integrations.
- Provide repository map, semantic search, trace, and impact tools.
- Add token and latency measurements.

## Milestone 6 - Visualization and scale

- Build a focused neighborhood graph instead of rendering every symbol.
- Add semantic and structural layers.
- Add local database projections for very large repositories.
- Support multi-repository workspaces and worktrees.

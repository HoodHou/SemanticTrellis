# ADR 0009: Structural queries repair and cache repository deltas

- Status: Accepted
- Date: 2026-08-18

## Context

Cache-only MCP queries previously failed when any indexed source changed, while
CLI queries forced a complete structural refresh by default. Warm refreshes
still hashed the full repository, re-resolved every reference, rewrote the full
JSON index, and later query calls reread both the index and source files.

Large repositories also need useful source context, visible ambiguity metrics,
and safe behavior when Agents issue imprecise symbol names or regular
expressions.

## Decision

- Make cached structural reads the CLI and MCP default.
- Probe Git revision, dirty paths, untracked paths, or source stats before
  querying and repair a stale index once automatically.
- Reuse hashes when size and modification time are unchanged, but hash every
  changed Git path before trusting it.
- Cache parsed structural indexes by index-file stat and verified source by
  source stat plus content hash inside long-lived processes.
- Persist target-name-to-reference-file reverse indexes and per-file resolution
  metrics. Re-resolve only changed files and files referencing changed
  definition names; a no-change refresh performs no edge resolution or write.
- Use owner-local semantic reference ordinals instead of source line/column in
  reference identity.
- Default grep to fixed text. Guard explicit regular expressions against common
  nested-quantifier denial-of-service patterns.
- Return match columns, fair importance-ranked group samples, bounded context or
  bodies, natural-language symbol search, ambiguity metrics, and trace miss
  suggestions.

## Consequences

- Ordinary edits no longer turn read tools into cold errors, and Agents do not
  need to remember a separate structure call.
- Git repositories get exact delta hashing; filesystem-only repositories use a
  concurrent stat probe and retain verified-hash fallback behavior.
- The reverse index increases disposable index size but removes repository-wide
  reference resolution from normal single-file maintenance.
- The regular-expression guard is intentionally conservative and not a formal
  proof of linear-time execution. Fixed search remains the safest default.
- Type-aware overload and receiver binding remain outside the syntactic
  resolver; their ambiguity is now observable instead of silently discarded.

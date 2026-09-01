# ADR 0015: Add guarded Agent-assisted artifact projections

- Status: Accepted
- Date: 2026-09-01

## Context

The eligible-text source policy cannot safely disclose or decode binary formats
such as `.xlsx`, and a native adapter will never exist for every repository
artifact. Relying on an Agent to notice excluded files independently produces
incomplete inventories, while allowing arbitrary derived files would weaken
provenance, concurrency, and deterministic maintenance.

## Decision

- Inventory every Git-visible regular file outside configured excluded
  directories, then classify files outside the eligible-text policy as
  unsupported without reading them as text.
- Define projection schema version 1 for source-bound `.strellis.json` and
  `.strellis.md` sidecars. Both formats record the original repository-relative
  path, exact SHA-256, media type, producer tool and version, omissions, and
  warnings.
- Require JSON projections to contain structured object or array content and
  Markdown projections to begin with a strict JSON metadata block followed by
  a non-empty body.
- Normalize projection documents deterministically before persistence.
- Use a validate-token-register workflow. The token binds the source hash,
  normalized projection digest, exact target path, and existing target digest.
- Never overwrite the original artifact. A target must be exactly the source
  path plus `.strellis.json` or `.strellis.md`, and one source may have at most
  one registered sidecar.
- Store stat-assisted unsupported hashes and parsed sidecar metadata in local
  projection-index schema version 1. The index is disposable and never
  authoritative.
- Block bootstrap start and completion when an existing projection is stale,
  invalid, orphaned, or points at a now-supported source. Unprojected artifacts
  remain visible for relevance review but do not block eligible-text bootstrap.

## Consequences

- Bootstrap preview and MCP can enumerate unsupported artifacts completely and
  page large inventories without disclosing their bytes.
- Agents with format-aware host tools can safely normalize formats for which
  SemanticTrellis has no native adapter.
- A changed source invalidates only its bound projection; unchanged source and
  projection hashes are reused.
- The first unsupported-artifact scan may hash large files, but subsequent
  refreshes use Git dirty paths plus size and modification time to avoid
  repository-wide rehashing.
- Sidecars are visible repository evidence and may be reviewed or committed;
  the curated graph remains the only canonical semantic classification.
- Native adapters can supersede projections without changing graph authority.

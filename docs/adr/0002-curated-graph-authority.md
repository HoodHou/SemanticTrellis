# ADR 0002: The curated graph is authoritative

- Status: Accepted
- Date: 2026-08-18

## Context

Regenerating a complete semantic graph after every repository change causes
classification drift, unnecessary model cost, and unstable node identity.

## Decision

The curated semantic graph is canonical, versioned, and changed only through a
validated patch. Extracted facts, snapshots, summaries, embeddings, and query
indexes are disposable projections.

An automatic sync may update local structural state and create review work, but
it must not silently rewrite approved semantic classifications.

## Consequences

- Initial curation costs more but becomes durable.
- Review history can explain why architecture changed.
- Local caches can be deleted safely.
- Sync remains useful even when no AI provider is configured.

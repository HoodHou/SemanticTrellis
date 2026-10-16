# ADR 0016: Classify review items from structural deltas

- Status: Accepted
- Date: 2026-10-16

## Context

Sync already queues added, changed, and removed files, but each item only
records a content hash and the curated nodes that cite that path. An agent
then has to reconstruct whether the edit changed a signature, a cross-file
reference, or only an implementation, and whether a removed path is really a
move.

## Decision

- Keep review-queue schema version 1. Add an optional `structuralDelta` object.
  Queues written before this field are read with `structuralDelta: null`.
- When sync refreshes the structural index, compare the previous and next
  contributions for each changed path.
- Label a hash-identical removed and added pair as `file-moved`.
- Otherwise label a comparable edit as `symbol-signature-changed`,
  `cross-node-reference-changed`, or `implementation-only`. Added and removed
  files that are not moves keep `source-added` and `source-removed`.
- `review_context` returns the delta, affected curated-node summaries, and one
  candidate patch. The patch rewrites provenance for pure moves and marks
  implementation-only paths plus both sides of a move as reviewed. It does not
  write the graph; apply still requires validate-token-apply.

## Consequences

- Routine sync now refreshes disposable structural state before queueing work.
- A changed file with no stored previous contribution stays
  `symbol-signature-changed`, so missing evidence is never auto-cleared.
- Signature comparison ignores file and callback symbols. Body-only edits do
  not count as signature changes.
- The candidate patch sets `overrideLocked` only when a moved source belongs
  to a locked node.

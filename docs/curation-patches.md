# Curation patches

The curator boundary is an explicit JSON transaction. An AI adapter, a visual
reviewer, or a person can produce the same format. The domain layer applies the
operations in memory, audits the complete result, and writes only a valid graph.

Agent integrations add an optimistic-concurrency boundary:

1. call `semantic_trellis_validate_patch` with the exact patch;
2. review the proposed counts, warnings, and graph digests;
3. obtain user approval for the canonical write;
4. call `semantic_trellis_apply_patch` with the unchanged patch and returned
   validation token.

The token becomes invalid when either the graph or patch changes.

See `examples/curation-patch.example.json` for a minimal patch.

## Operations

### `upsert-node`

Create or replace a semantic node by stable ID.

Replacing an existing locked node requires `overrideLocked: true` on the
operation. New locked nodes do not require an override.

### `remove-node`

Remove a semantic node. The transaction is rejected if any resulting edge is
dangling, so incident edges must also be removed in the same patch.

Removing a locked node also requires `overrideLocked: true`.

### `upsert-edge`

Create or replace a semantic edge by stable ID. Both endpoint nodes must exist
in the final transaction.

### `remove-edge`

Remove an edge by stable ID.

### `mark-reviewed`

Remove matching source paths from the local review queue after their semantic
classification has been handled.

## Review rule

Applying a patch is an explicit review boundary. Routine `sync` never generates
or applies one automatically. Future automation may auto-apply mechanical
provenance patches, but classification, deletion, and cross-system relationship
changes will remain reviewable operations.

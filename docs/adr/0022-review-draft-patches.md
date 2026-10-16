# ADR 0022: Draft semantic patches without bypassing validation

- Status: Accepted
- Date: 2026-10-16

## Context

Sync can already classify an edit as implementation-only, a pure move, a
signature change, or a cross-file reference change. Only the first two
produced a patch an agent could validate. Signature and reference changes
still required the agent to reconstruct affected nodes by hand.

Silently applying either kind of patch would break the validate-token-apply
boundary.

## Decision

- `review_context` keeps `candidatePatch` for implementation-only edits and
  pure file moves. That patch may mark those paths reviewed and may rewrite
  provenance, including `overrideLocked` when the node is locked.
- Add `draftPatch` for signature changes, cross-file reference changes, added
  sources, and removed sources. It upserts clones of the curated nodes that
  cite either side of the change. It does not change summaries and does not
  include `mark-reviewed`.
- A cross-file reference change reports curated nodes for both the edited
  file and the other file in the reference delta.
- `fullAuditChangeRatio` counts only review items that are not
  implementation-only and not file-moved. The denominator remains the
  previous snapshot size.
- Neither patch writes the graph. Both go through `validate_patch` and
  `apply_patch`.

## Consequences

- Applying an unchanged draft leaves the review item in place.
- An agent edits the draft summary or edges, adds `mark-reviewed`, and
  validates that exact patch.
- A run of body-only edits no longer recommends a full audit by file count
  alone.

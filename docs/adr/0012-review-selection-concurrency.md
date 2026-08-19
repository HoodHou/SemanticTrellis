# ADR 0012: Bind curation tokens to selected review entries

- Status: Accepted
- Date: 2026-08-19

## Context

Curation validation tokens originally bound the current canonical graph and the
exact graph patch. A patch can also contain `mark-reviewed` operations that
remove paths from the disposable review queue. If one of those paths changed
again between validation and application, the old token could clear the newer
review item even though the reviewed source hash had changed.

Binding the complete review queue would prevent that race but would also make an
unrelated repository change invalidate an otherwise independent graph patch.

## Decision

- Derive a deterministic digest from the current review items whose paths are
  selected by the patch's `mark-reviewed` operations.
- Bind that selected-review digest, the current graph digest, and the exact
  patch into validation token version 2.
- Reload the queue and recompute the selected-review digest immediately before
  applying the patch.
- Reject the token if a selected item was added, removed, or changed.
- Do not invalidate a token for review-queue changes on unrelated paths.

## Consequences

- A reviewed path cannot silently clear a newer source delta.
- Independent repository changes do not force unnecessary patch revalidation.
- Graph-only patches use the stable digest of an empty review selection.
- The review queue remains disposable and non-authoritative even though its
  selected entries participate in the write concurrency guard.

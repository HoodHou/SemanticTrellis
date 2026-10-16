# ADR 0020: Keep warm queries and review packages small

- Status: Accepted
- Date: 2026-10-16

## Context

Warm structural queries spent most of their time scanning a Git tree that had
not changed. Ask's one-hop supplement preferred same-file helpers with no
incoming edges over the cross-file implementation a reviewer needed. Grep still
returned test callbacks after a production hit. Bootstrap's 12,000-character
chunks also split many source files into exactly two pieces, and
`package-lock.json` consumed summary rounds without semantic value.

## Decision

- Probe Git with one porcelain status call. When the revision matches and no
  tracked structural path or untracked structural path is dirty, return the
  cached index without scanning or loading parser adapters.
- Store an extractor fingerprint on the disposable index. A missing or
  different fingerprint forces one rebuild. The structural cache schema stays
  version 8.
- Fill ask's callee slots with cross-file call targets when any exist.
  Same-file helpers are used only when every direct callee is in the caller's
  file.
- Drop test paths and synthetic test callbacks from grep when a production
  group exists. A test path prefix or an explicit `callback` symbol kind keeps
  them.
- Raise the default bootstrap chunk size to 20,000 characters.
- Omit generated lockfiles from bootstrap summaries, the initial review queue,
  sync review items, and unclassified-source audit findings.
- Return only review items that carry a structural delta from
  `review_context`, and report how many unclassified bootstrap items were
  omitted. Callers can request those items explicitly.

## Consequences

- Repeated asks in a clean Git repository no longer restat every source file.
- An edit to an untracked structural file still hashes that file before reuse.
- One-hop context follows the implementation across files.
- Lockfile churn does not enter the semantic review queue.
- Raising the chunk default changes the bootstrap session id for repositories
  that start a new session without an explicit chunk size.

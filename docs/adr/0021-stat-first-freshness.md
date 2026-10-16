# ADR 0021: Check indexed file stats before repeating Git status

- Status: Accepted
- Date: 2026-10-16

## Context

A clean structural read still spent most of its time in one `git status`.
Repeated ask and grep calls in the same process repeated that probe even when
no indexed source file had changed. The one-hop supplement also spent a slot
on infrastructure loaders such as `loadGraph` when a domain implementation was
also a direct callee.

## Decision

- Compare each indexed contribution's size and modification time before
  running Git. A mismatch marks the index stale immediately.
- When those files match, also compare the modification times of their parent
  directories and the repository root. An unchanged stamp skips Git status.
  Creating a file updates a parent directory, so a new source file still
  forces the next probe to run Git.
- Score cross-file callees in `domain/` above callees in `infrastructure/`.

## Consequences

- A burst of warm reads skips Git status after the first clean probe.
- Editing, deleting, or adding a file still forces a refresh on the next read.
- Ask's two callee slots prefer domain rules over persistence helpers.

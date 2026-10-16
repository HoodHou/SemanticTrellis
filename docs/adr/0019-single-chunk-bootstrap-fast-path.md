# ADR 0019: Let single-chunk files submit one file summary

- Status: Accepted
- Date: 2026-10-16

## Context

Bootstrap splits every file into chunks of at most 12,000 characters and then
requires a chunk summary before a file rollup. Most source files fit in one
chunk, so the agent summarized the same text twice.

## Decision

- Keep the frozen snapshot, chunk identities, and hash checks unchanged.
- When a source batch unit has `chunkCount === 1`, mark `fastPath` and include
  the file's structural symbols, references, and diagnostics with the source.
- Accept a file summary for that file before a chunk summary exists. Derive
  the chunk summary from the file summary, then store the file summary.
- Reject the same shortcut when any chunk is still unsummarized or the file
  hash does not match the frozen snapshot.
- Completion still requires 100 percent chunk coverage, 100 percent file
  coverage, and a clean audit.

## Consequences

- Single-chunk files no longer need a separate rollup round trip.
- Multi-chunk files keep the existing checkpoint order.
- Derived chunk summaries are real submitted content, not placeholders, so
  coverage accounting stays exact.
- The bootstrap session schema stays version 1 because the stored chunk and
  file records do not change shape.

# Storage model

## Design rule

Canonical decisions and disposable computation must never share authority.

## Canonical files

### `.semantic-trellis/config.json`

Versioned project policy:

- project identity;
- source extensions;
- excluded directories;
- maximum source file size;
- review and audit thresholds.

### `.semantic-trellis/graph.json`

Versioned curated graph:

- stable semantic nodes;
- typed semantic edges;
- source provenance;
- approval and lock state.

These files are intended to be reviewed and committed.

## Local files

### `.semantic-trellis/local/snapshot.json`

A content-hash inventory of the last observed repository state. It is a local
optimization and can be rebuilt.

### `.semantic-trellis/local/review-queue.json`

Pending bootstrap and maintenance work. It records which files changed, why
they require review, which curated nodes may be affected, and an optional
structural delta. The delta names the change class, moved paths, symbol
signature changes, and cross-file reference changes. Entries created before
that field existed are read with a null delta. Entries selected
by `mark-reviewed` participate in the curation validation token so a newer delta
for the same path cannot be cleared by an older approval.

### `.semantic-trellis/local/structural-index.json`

Disposable per-file structural contributions and their resolved edges. Each
contribution is keyed by repository-relative path, source hash, language, and
extractor version and contains symbols, unresolved references, and parser
diagnostics. Callable symbols include accepted argument ranges, references
include observed argument counts, C# declarations record partial identity, and
Python and Lua dynamic calls use the `invoke` relation.
The index also stores repository revision/untracked state, per-file resolution
metrics, and target-name reverse references for incremental edge repair. An
unchanged file reuses its contribution without parsing. A clean Git tree whose
revision matches the index skips the repository scan. Repeated reads compare indexed file and directory timestamps and skip Git
status when that stamp is unchanged. The current structural
cache schema is version 8; older local indexes are discarded and rebuilt.
Version 8 adds heading, table, and sheet symbols plus `references` edges for
Markdown links and code-to-document or code-to-projection mentions. Each index
also stores an extractor fingerprint; a missing or different fingerprint forces
one rebuild.

### `.semantic-trellis/local/agent-bootstrap.json`

The resumable Agent AI-review session: frozen snapshot digest, disclosure
approval, stable chunk units, chunk summaries, file summaries, reuse counters,
coverage, and the completed curated-graph digest. Source text is never stored in
this file; it is reread from the frozen hash when an approved Agent asks for a
batch.

### `.semantic-trellis/local/projection-index.json`

Disposable projection-index schema version 1 caches Git-visible unsupported
artifact hashes, size and modification-time hints, parsed projection metadata,
repository revision, and sidecar hashes. It contains no unsupported artifact
bytes or normalized projection body. A changed source invalidates only
projections bound to that source hash.

### Repository projection sidecars

`.strellis.json` and `.strellis.md` files are reviewable, source-bound derived
evidence. Projection schema version 1 records the original path and SHA-256,
media type, producer tool and version, omissions, and warnings. Registration
normalizes the sidecar deterministically and writes only the exact
`<source-path>.strellis.json` or `<source-path>.strellis.md` target after token
validation. Sidecars participate in normal eligible-text snapshots, but they do
not share authority with the curated graph.

Local files are ignored by Git and are never authoritative.

Only the five local runtime documents above should persist between normal sessions.
One-off probes, temporary MCP callers, and applied patch payloads belong in a
temporary workspace and should be removed after handoff. Durable curation
history is the versioned graph and Git history, not an accumulation of helper
files under `local/`.

## Stable identity

Node IDs are explicit opaque strings chosen at curation time. Display names,
file paths, and symbol names may change without changing node identity.

A locked node cannot be modified or removed by an ordinary patch. An explicit
reviewed operation must set `overrideLocked: true`; this intent is visible in
the patch and still passes through the validation-token workflow.

Edge IDs are explicit and stable so reviews can update an edge without relying
on array position.

## Graph patch format

The initial patch format supports:

- `upsert-node`
- `remove-node`
- `upsert-edge`
- `remove-edge`
- `mark-reviewed`

Patches are validated as a complete transaction. If the resulting graph has a
dangling edge or duplicate identity, nothing is written.

## Schema evolution

Every canonical and local document contains `schemaVersion`. A change that
cannot be read backward-compatibly requires:

1. a new schema version;
2. an ADR;
3. an explicit migration;
4. round-trip tests.

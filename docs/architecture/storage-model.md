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
they require review, and which curated nodes may be affected.

Local files are ignored by Git and are never authoritative.

## Stable identity

Node IDs are explicit opaque strings chosen at curation time. Display names,
file paths, and symbol names may change without changing node identity.

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

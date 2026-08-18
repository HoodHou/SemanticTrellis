# SemanticTrellis agent guide

All repository content must be written in English. This includes source code,
identifiers, comments, tests, documentation, configuration, commit messages,
and generated examples.

## Required reading

Before changing architecture or storage behavior, read:

1. `docs/architecture/overview.md`
2. `docs/architecture/storage-model.md`
3. the relevant records under `docs/adr/`

## Architectural boundaries

- `src/domain/` contains pure rules and must not import Node.js file-system APIs.
- `src/application/` coordinates use cases through domain functions and
  infrastructure adapters.
- `src/infrastructure/` owns file-system access, hashing, and persistence.
- `src/cli/` only parses input, calls application use cases, and formats output.
- `src/mcp/` exposes application use cases to agents and must bind each server
  instance to one fixed repository root.
- `src/ports/` defines provider-facing interfaces; provider SDKs must not leak
  into the domain model.
- `src/adapters/` contains language and provider implementations behind ports.
- `src/structural/` owns language-neutral contribution resolution and queries.

## Product invariants

- Approved curated graph data is canonical and versioned.
- Local snapshots and caches are disposable and never authoritative.
- Stable node IDs must not be derived from a mutable display name.
- Routine sync must produce a review queue, not silently rewrite semantic
  classifications.
- Patch application must validate graph referential integrity before writing.
- MCP graph writes must use the validate-token-apply workflow; no direct write
  tool may bypass it.
- MCP bootstrap must preview the disclosure manifest and obtain explicit user
  approval before returning repository source chunks.
- A bootstrap cannot be marked complete until chunk and file coverage are 100%
  and the curated graph audit is clean.
- Every node must be able to cite repository-relative source paths.
- New storage formats require a schema version and an ADR.

## Verification

Run before handing off a change:

```bash
npm run verify
```

Add or update tests for every change to domain rules, persistence formats, or
CLI behavior.

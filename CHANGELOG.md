# Changelog

## 0.5.0 - 2026-08-18

### Added

- AST-backed C# structural extraction through the ast-grep Node API and
  prebuilt Tree-sitter C# grammar.
- C# symbols for namespaces, classes, interfaces, structs, records, enums,
  delegates, methods, local functions, constructors, destructors, operators,
  properties, fields, and events.
- C# references for using directives, inheritance, interface implementation,
  invocations, and object construction.
- Scope-first and unique-qualified-suffix reference resolution for partial-type
  and same-type call chains.
- Per-file non-fatal parser diagnostics and aggregate diagnostic metrics.

### Changed

- Structural cache schema is version 2 and invalidates older disposable indexes.
- Structural MCP, CLI, and AI-bootstrap rollups report parser diagnostics.

## 0.4.0 - 2026-08-18

### Added

- Agent-driven full-repository AI bootstrap over MCP.
- Read-only source-disclosure preview with file, byte, extension, largest-file,
  and suspicious-path inventory.
- Explicit source-disclosure approval before any source chunk is returned.
- Frozen snapshot chunk planning with resumable content-hash checkpoints.
- Chunk-summary and file-rollup submission stages with confidence, producer,
  model, risk, evidence, and responsibility fields.
- Structural symbols and references included in file rollup context.
- Paginated curation context for Agent-generated semantic graph patches.
- Audit-clean graph-digest completion gate and unchanged-summary reuse after a
  new snapshot.
- Nine MCP tools covering preview, start, status, source batches, summary
  checkpoints, curation context, and completion.

### Changed

- `strellis bootstrap` now starts or resumes the complete Agent AI-review
  workflow instead of stopping after file inventory.
- File inventory remains an internal prerequisite and the bootstrap workflow is
  resumable across Agent sessions.
- General project status now distinguishes a repository inventory snapshot from
  completed AI bootstrap.
- Cache-only structural grep rejects source whose bytes no longer match the
  indexed contribution instead of risking stale symbol attribution.

## 0.3.0 - 2026-08-18

### Added

- Git-aware repository discovery with a filesystem fallback.
- Per-file structural contributions with source hashes and extractor identities.
- TypeScript and JavaScript extraction through the TypeScript Compiler API.
- Symbol-aware structural grep with curated semantic attribution.
- File-symbol and bounded incoming/outgoing trace queries.
- Four MCP tools for structural refresh, grep, file symbols, and trace.
- Enforced locked curated nodes; modification or removal now requires the
  explicit `overrideLocked: true` patch intent.

### Changed

- TypeScript 7 remains the project compiler while the runtime parser uses the
  `typescript-compiler` npm alias pinned to the stable TypeScript 5.9 Compiler
  API.
- The self-curated graph now models language adapters and the structural index
  as stable semantic nodes.

## 0.2.0 - 2026-08-18

### Added

- First-class local stdio MCP server using the official TypeScript SDK v2.
- Eight agent tools for status, graph neighborhoods, search, review state,
  audit, delta sync, patch validation, and guarded patch application.
- Three MCP resources for status, the canonical graph, and the review queue.
- Validation tokens bound to the exact patch and current graph digest.
- In-memory and real stdio MCP integration tests.
- Codex and generic MCP host configuration documentation.

### Changed

- Added the `strellis mcp` command and `strellis-mcp` binary.
- Added graph neighborhood and semantic node search domain services.
- Extended the self-curated graph with the MCP agent adapter.

## 0.1.0 - 2026-08-18

### Added

- Initial modular TypeScript foundation.
- Canonical curated graph and disposable repository snapshot boundaries.
- File-level init, bootstrap, sync, curate, audit, and status workflow.
- Self-curated project graph, architecture documentation, tests, and CI.

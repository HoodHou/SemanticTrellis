# Changelog

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

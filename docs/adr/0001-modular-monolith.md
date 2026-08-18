# ADR 0001: Start as a modular monolith

- Status: Accepted
- Date: 2026-08-18

## Context

SemanticTrellis needs clear boundaries between graph rules, repository
maintenance, AI providers, parsers, persistence, CLI, and future MCP/UI
adapters. A multi-package architecture would encode those boundaries but would
also add release and dependency overhead before the contracts are proven.

## Decision

Start as a single TypeScript package with explicit module boundaries:

- domain;
- application;
- ports;
- infrastructure;
- adapters such as CLI.

The domain layer remains free of provider SDKs and file-system APIs. Modules may
be extracted into packages later when independent release or runtime boundaries
become useful.

## Consequences

- The first vertical slice stays small and testable.
- Boundary violations are governed by review and documentation initially.
- Package extraction remains possible because provider types do not enter the
  domain model.

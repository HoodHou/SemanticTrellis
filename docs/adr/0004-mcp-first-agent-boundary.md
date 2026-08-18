# ADR 0004: MCP is the primary agent boundary

- Status: Accepted
- Date: 2026-08-18

## Context

SemanticTrellis exists to maintain durable context for coding agents. Shell
commands are useful for people and automation, but agents need discoverable,
typed, host-neutral tools and resources. Canonical graph writes also need a
stronger boundary than a single unconstrained tool call.

## Decision

Use Model Context Protocol as the primary agent-facing adapter.

The first transport is local stdio. Each server process is bound to exactly one
repository root at startup. Tools never accept a repository root argument.

The server exposes:

- read-only status, graph, search, review queue, and audit tools;
- a local-state-only sync tool;
- a read-only patch validation tool;
- a canonical patch application tool that requires the validation token for the
  exact patch and current graph.

Status, graph, and review queue are also available as MCP resources. Tool
annotations describe read, write, destructive, and idempotent behavior, but
application-level validation remains authoritative.

## Consequences

- Codex, Claude Code, Cursor, and other MCP hosts can share one integration.
- Agents cannot use tool arguments to escape the configured repository.
- Standard output is reserved exclusively for MCP protocol messages.
- Canonical graph writes are optimistic-concurrency controlled and remain
  visible to host approval systems.
- A future Streamable HTTP transport can reuse the same server factory and tool
  registrations.

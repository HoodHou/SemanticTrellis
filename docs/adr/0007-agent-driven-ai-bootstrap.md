# ADR 0007: First AI bootstrap is Agent-driven and resumable

- Status: Accepted
- Date: 2026-08-18

## Context

The product promise requires an AI to review every eligible repository file
before the first semantic graph is curated. Binding that workflow directly to
one model API would duplicate the model and approval systems already available
in Codex, Claude Code, Cursor, and other MCP hosts.

Large repositories also exceed one model context window and may change during a
long review. Source disclosure must be explicit, work must be resumable, and a
mixed-snapshot graph must never be accepted silently.

## Decision

Make the first implementation Agent-driven over MCP.

1. Preview paths and byte counts without source content.
2. Require explicit source-disclosure approval.
3. Freeze a content-hash snapshot and split every file into stable chunks.
4. Let the Agent submit chunk summaries as local checkpoints.
5. Let the Agent roll complete chunk summaries and structural facts into file
   summaries.
6. Page the complete file-summary corpus to the Curator Agent.
7. Reuse the existing validate-token-apply graph patch boundary.
8. Complete only when chunk and file coverage are 100% and the graph audit has
   no errors, warnings, or unclassified sources.

Source text is returned on demand but never persisted in bootstrap state.
Changing source bytes invalidates the frozen batch. A new session reuses chunk
and file summaries whose content-derived identities remain unchanged.

## Consequences

- Any MCP-capable Agent host can perform the first full review without a second
  model credential in SemanticTrellis.
- Long reviews survive process and conversation restarts.
- Direct OpenAI-compatible and local-model adapters can implement the same
  checkpoint contracts later.
- Host token and cost telemetry is not always visible to the MCP server; coverage
  and character metrics are available now, while provider usage metrics remain
  optional future data.

# MCP integration

SemanticTrellis exposes one curated repository through a local stdio Model
Context Protocol server.

## Build

```bash
npm install
npm run build
```

Start the server manually:

```bash
node dist/mcp/stdio.js /absolute/path/to/repository
```

The process waits for an MCP host on standard input. Standard output is reserved
for protocol messages; diagnostics are written to standard error.

## Tools

| Tool | Effect |
|---|---|
| `semantic_trellis_status` | Read project, graph, file, and review counts |
| `semantic_trellis_graph` | Read the complete graph or a directional neighborhood |
| `semantic_trellis_search` | Search curated nodes and source provenance |
| `semantic_trellis_review_queue` | Read pending semantic review work |
| `semantic_trellis_audit` | Read integrity, provenance, and coverage findings |
| `semantic_trellis_sync` | Update disposable snapshot state and review queue |
| `semantic_trellis_validate_patch` | Validate a patch without writing |
| `semantic_trellis_apply_patch` | Apply the exact validated patch to the canonical graph |

## Resources

- `semantic-trellis://status`
- `semantic-trellis://graph`
- `semantic-trellis://review-queue`

## Safe curation workflow

Agents must never call `semantic_trellis_apply_patch` directly.

1. Read status and pending review work.
2. Read or search the relevant curated neighborhood.
3. Build a small graph patch with source evidence.
4. Call `semantic_trellis_validate_patch`.
5. Present the proposed change to the user and obtain approval.
6. Call `semantic_trellis_apply_patch` with the unchanged patch and validation
   token.

The server rejects the write if the graph or patch changed after validation.

## Codex project configuration

Codex supports project-scoped MCP servers through `.codex/config.toml` in a
trusted project. Copy and edit the example below with absolute paths:

```toml
[mcp_servers.semantic_trellis]
command = "node"
args = [
  "C:\\absolute\\path\\to\\SemanticTrellis\\dist\\mcp\\stdio.js",
  "C:\\absolute\\path\\to\\the\\target-repository"
]
cwd = 'C:\absolute\path\to\SemanticTrellis'
startup_timeout_sec = 30
tool_timeout_sec = 120
enabled = true
default_tools_approval_mode = "writes"
```

The `writes` approval mode lets read-only context tools run normally while the
host asks before tools that update local state or the canonical graph.

Restart Codex after changing MCP configuration. The ChatGPT desktop app, Codex
CLI, and IDE extension share the same Codex-host configuration.

Official Codex MCP documentation:
<https://developers.openai.com/codex/mcp>

## Generic MCP host configuration

Hosts using the common JSON shape can launch the same server:

```json
{
  "mcpServers": {
    "semantic_trellis": {
      "command": "node",
      "args": [
        "/absolute/path/to/SemanticTrellis/dist/mcp/stdio.js",
        "/absolute/path/to/the/target-repository"
      ]
    }
  }
}
```

## Inspector

Use the official MCP Inspector for interactive development:

```bash
npx @modelcontextprotocol/inspector node dist/mcp/stdio.js /path/to/repository
```

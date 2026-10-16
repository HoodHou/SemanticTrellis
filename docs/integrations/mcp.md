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

Server instructions only keep the approval and projection rules. See
[Artifact projections](../artifact-projections.md).

Structural tools support TypeScript, JavaScript, C#, Python, Python stubs, and
Lua through the same fixed-repository index. Python and Lua dynamic calls are
exposed as conservative `invoke` edges.

## Tools

| Tool | Effect |
|---|---|
| `semantic_trellis_bootstrap_preview` | Preview the source disclosure set without source content |
| `semantic_trellis_bootstrap_start` | Freeze or resume the approved full AI review |
| `semantic_trellis_bootstrap_status` | Read chunk/file coverage and reuse metrics |
| `semantic_trellis_bootstrap_next_batch` | Read the next frozen source chunks |
| `semantic_trellis_bootstrap_submit_chunk_summaries` | Checkpoint Agent chunk summaries |
| `semantic_trellis_bootstrap_next_rollups` | Read completed chunk summaries plus structural evidence |
| `semantic_trellis_bootstrap_submit_file_summaries` | Checkpoint Agent file-level rollups |
| `semantic_trellis_bootstrap_context` | Page complete file summaries for curation |
| `semantic_trellis_bootstrap_complete` | Complete only after clean graph application |
| `semantic_trellis_unsupported_list` | Page every Git-visible artifact outside the eligible-text policy |
| `semantic_trellis_projection_status` | Read current, stale, invalid, unprojected, and orphaned projection state |
| `semantic_trellis_projection_validate` | Validate and normalize a source-bound projection without writing |
| `semantic_trellis_projection_register` | Register the exact validated projection without modifying its source |
| `semantic_trellis_status` | Read project, graph, file, and review counts |
| `semantic_trellis_graph` | Read the complete graph or a directional neighborhood |
| `semantic_trellis_search` | Search curated nodes and source provenance |
| `semantic_trellis_review_queue` | Read pending semantic review work |
| `semantic_trellis_review_context` | Read structural deltas, a safe candidate patch, and a draft patch |
| `semantic_trellis_audit` | Read integrity, provenance, and coverage findings |
| `semantic_trellis_sync` | Update disposable snapshot state and review queue |
| `semantic_trellis_structure` | Incrementally refresh symbols, references, and edges |
| `semantic_trellis_grep` | Search source with stale repair, columns, fair grouping, and optional bounded context/body |
| `semantic_trellis_file_symbols` | Read every extracted symbol and optionally bounded bodies in one file |
| `semantic_trellis_trace` | Trace structural edges, return miss suggestions, and optionally bounded bodies |
| `semantic_trellis_symbol_search` | Rank symbols by natural-language terms, signatures, graph importance, and curated provenance |
| `semantic_trellis_ask` | Return a ranked top-4 with query-aware eight-line cruxes; full bodies are opt-in |
| `semantic_trellis_validate_patch` | Validate a patch without writing |
| `semantic_trellis_apply_patch` | Apply the exact validated patch to the canonical graph |

## Resources

- `semantic-trellis://status`
- `semantic-trellis://graph`
- `semantic-trellis://review-queue`

## One server, one repository

Each MCP process receives one repository root and cannot be redirected by a
tool argument. Run a separate process for each repository. Three servers bound
to three roots in one test process keep their indexes, asks, sync results, and
review queues apart (`test/multi-instance.test.ts`).

## First review

1. `semantic_trellis_bootstrap_preview`. Show the disclosure manifest to the user.
2. After explicit approval, `semantic_trellis_bootstrap_start` with
   `sourceDisclosureApproved: true`.
3. For each `fastPath` unit from `semantic_trellis_bootstrap_next_batch`, submit
   one file summary. Other files use chunk summaries, then
   `semantic_trellis_bootstrap_next_rollups` and file summaries.
4. Page `semantic_trellis_bootstrap_context`, propose a sourced graph patch,
   `semantic_trellis_validate_patch`, obtain approval, then
   `semantic_trellis_apply_patch`.
5. `semantic_trellis_bootstrap_complete`.

Details are in `docs/ai-bootstrap.md`.

## Daily maintenance

1. `semantic_trellis_sync`.
2. `semantic_trellis_review_context`.
3. Apply `candidatePatch` for implementation-only edits and pure file moves.
4. Edit `draftPatch` for signature changes, cross-file reference changes,
   additions, and removals. Add `mark-reviewed` only after the node text is
   updated. Do not apply an unchanged draft as if the review were finished.
5. `semantic_trellis_validate_patch`.
6. Show the patch to the user and obtain approval.
7. `semantic_trellis_apply_patch` with the same patch and token.

Never call `semantic_trellis_apply_patch` without that validation. The server
rejects the write if the graph, patch, or a review entry selected by
`mark-reviewed` changed. Unrelated review items do not invalidate the token.

Use `semantic_trellis_ask` when the task needs source. Use grep or trace when
the identifier is already known.

## Host configuration

Copy [mcp.json.example](mcp.json.example) and replace both absolute paths.
The first argument is this package's `dist/mcp/stdio.js`. The second is the
repository to bind. Cursor reads `.cursor/mcp.json`. Claude Code reads
`.mcp.json` in the project root. Both use the same `mcpServers` object.

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

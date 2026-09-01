# SemanticTrellis

SemanticTrellis is a curated semantic graph for large codebases. It performs an
intentional full bootstrap once, lets an agent organize the result into stable
systems and relationships, and then maintains only the affected part of the
graph as the repository changes.

## Product thesis

Most code intelligence systems repeatedly rediscover the same repository.
SemanticTrellis treats repository understanding as a durable asset:

1. **Bootstrap** - inventory the complete repository and prepare it for semantic
   classification.
2. **Curate** - let an agent propose stable nodes, ownership boundaries, and
   typed relationships; review uncertain decisions explicitly.
3. **Sync** - detect file deltas and update only the affected nodes and edges.
4. **Audit** - occasionally verify the curated graph against the complete
   repository without regenerating it by default.

## Non-negotiable properties

- Curated node identities are stable across file moves and symbol renames.
- Generated facts and curated meaning live in separate layers.
- Routine maintenance is proportional to the change set, not repository size.
- An automated refresh never overwrites an approved classification silently.
- Every semantic claim carries source provenance.
- Local caches are disposable; approved graph data is reviewable and versioned.
- AI providers are adapters, not dependencies of the domain model.

## Current milestone

The current implementation provides a working local vertical slice:

- initialize the project metadata;
- inventory source files with content hashes;
- create a bootstrap review queue;
- compute added, changed, and removed files incrementally;
- apply reviewed graph patches;
- audit graph integrity and source coverage;
- expose the workflow through the `strellis` CLI.
- expose the curated graph and guarded maintenance workflow over MCP.
- drive a resumable, full-repository AI review through an MCP-connected Agent.

Agent-driven AI bootstrap, TypeScript, JavaScript, C#, Python, and Lua structural
extraction, and MCP are available. Direct model-provider adapters, additional
languages, and a visual curator remain later milestones.

Bootstrap preview also inventories every Git-visible artifact outside the
eligible-text policy. A format-aware Agent host can validate and register a
deterministic `.strellis.json` or `.strellis.md` projection without modifying
the original. Source, projection, and target hashes are concurrency-bound, and
only projections for changed sources become stale.

## Quick start

Requirements: Node.js 22 or newer and npm.

```bash
npm install
npm run verify
```

Run the CLI from source:

```bash
npm run dev -- help
npm run dev -- init /path/to/repository
npm run dev -- bootstrap-preview /path/to/repository
npm run dev -- bootstrap /path/to/repository --allow-source-disclosure
npm run dev -- status /path/to/repository
```

Or build it first:

```bash
npm run build
node dist/cli/index.js help
```

## CLI workflow

```text
strellis init [repository]
strellis bootstrap-preview [repository]
strellis bootstrap [repository] --allow-source-disclosure
strellis bootstrap-status [repository]
strellis curate <patch-file> [repository]
strellis sync [repository]
strellis audit [repository]
strellis status [repository]
strellis structure [repository]
strellis grep <pattern> [repository] --in src --context-lines 2 --include-body
strellis symbols <file> [repository] --include-body
strellis trace <symbol> [repository] --direction incoming --depth 2 --include-body
strellis search-symbols <query> [repository]
strellis ask <query> [repository] --in src
strellis mcp [repository]
```

The `curate` command consumes an explicit JSON patch. This is the first durable
seam for a future curator agent: the agent proposes operations, the domain layer
validates them, and only then does the canonical graph change.

The full AI bootstrap is Agent-driven: preview the disclosure set, obtain user
approval, review every frozen source chunk, roll those summaries up per file,
page through the complete curation context, and apply an audit-clean graph
patch. See [AI bootstrap](docs/ai-bootstrap.md).

## MCP for coding agents

SemanticTrellis ships a local stdio MCP server. Build the project, then start it
for one fixed repository:

```bash
npm run build
node dist/mcp/stdio.js /path/to/repository
```

The server exposes curated graph search, graph neighborhoods, status, audit,
review queue access, incremental sync, and guarded curation. Canonical writes
require a validation token tied to the exact patch and current graph state.

The disposable structural layer uses the TypeScript Compiler API for TypeScript
and JavaScript and the ast-grep Node API with a prebuilt Tree-sitter grammar for
C#, Python, and Lua. Python support includes `.py` and `.pyi`, packages, relative
imports, decorators, async and nested functions, and conservative dynamic
`invoke` edges. Lua support includes module tables, dot and colon methods,
anonymous callbacks, and `require` imports. Each file owns its symbols, parser
diagnostics, and unresolved references; unchanged contributions are reused by
stat-assisted content hashes. Queries
repair stale deltas automatically, cache verified source and parsed indexes in
long-lived MCP processes, decode byte-order-marked source, and can return bounded
context or complete symbol bodies. `ask` combines IDF-weighted natural-language
ranking and query-aware eight-line source cruxes in one call; `--full` opts into
complete definitions. Call arity reduces safe overload ambiguity,
equivalent C# partial types resolve as one logical target, and a target-name
reverse index limits edge re-resolution to changed and affected files.

See [MCP integration](docs/integrations/mcp.md) for Codex and generic host
configuration.

## Repository layout

```text
src/
  adapters/          Compiler and future provider implementations
  application/       Use cases and workflow orchestration
  cli/               Command-line adapter
  domain/            Stable graph and change-set rules
  infrastructure/    File system, hashing, and JSON persistence
  mcp/               Agent-facing MCP tools, resources, and stdio transport
  ports/             Interfaces for future AI and parser adapters
  structural/        Language-neutral contribution resolution and queries
docs/
  adr/               Architecture decision records
  architecture/      System and storage design
test/                 Domain and end-to-end tests
```

When SemanticTrellis initializes a target repository, it creates:

```text
.semantic-trellis/
  config.json         Versioned project policy
  graph.json          Versioned curated semantic graph
  local/
    snapshot.json     Disposable repository fingerprint
    review-queue.json Pending local review work
    structural-index.json Disposable per-file symbols and references
    agent-bootstrap.json Resumable AI-review checkpoints and coverage
    projection-index.json Disposable unsupported hashes and projection status
```

Only `.semantic-trellis/local/` is ignored. The config and curated graph are
intended to be reviewed and committed.

## Documentation

- [Architecture overview](docs/architecture/overview.md)
- [Storage model](docs/architecture/storage-model.md)
- [Roadmap](docs/roadmap.md)
- [MCP integration](docs/integrations/mcp.md)
- [AI bootstrap](docs/ai-bootstrap.md)
- [Artifact projections](docs/artifact-projections.md)
- [Contributing](CONTRIBUTING.md)

## Language policy

All repository content is maintained in English: source code, identifiers,
comments, documentation, configuration, tests, issue text, and commit messages.

## License

SemanticTrellis is licensed under the [MIT License](LICENSE). The npm package
remains marked private to prevent accidental publication during early
development.

# ADR 0005: Structural facts are compiler-backed file contributions

- Status: Accepted
- Date: 2026-08-18

## Context

File hashes detect change but cannot answer symbol, caller, or impact questions.
A monolithic symbol graph is expensive to rebuild and makes it difficult to
identify exactly what a changed file contributed.

TypeScript 7 also separates the native build compiler from the legacy Compiler
API. The project needs TypeScript 7 for its own build while retaining a stable
AST API for runtime extraction.

## Decision

Each supported source file owns a disposable structural contribution containing:

- source hash;
- language and extractor version;
- symbols and source spans;
- unresolved references.

Unchanged contributions are replayed by content hash. Resolved edges are a
deterministic projection of the merged contributions.

Use TypeScript 7 as the project compiler. Use the npm alias
`typescript-compiler` pinned to TypeScript 5.9 for the runtime TypeScript and
JavaScript adapter. The extractor identity includes the Compiler API version,
so an upgrade invalidates only disposable contributions.

## Consequences

- Routine parsing cost is proportional to changed supported files.
- Symbol-aware grep and basic call tracing no longer require an AI provider.
- Resolved edges are currently recomputed globally after contribution reuse;
  touched-key resolution remains the next incremental optimization.
- C# implements the same adapter port through ast-grep and a prebuilt
  Tree-sitter grammar as described in ADR 0008. Python and other languages can
  follow the same contribution contract without changing queries.

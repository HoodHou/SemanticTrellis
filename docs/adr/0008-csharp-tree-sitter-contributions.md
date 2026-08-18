# ADR 0008: C# contributions use the ast-grep Node API

- Status: Accepted
- Date: 2026-08-18

## Context

Large Unity repositories require C# classes, structs, methods, fields,
properties, inheritance, invocations, and construction to participate in the
same per-file contribution and incremental-cache lifecycle as TypeScript.

Regular expressions cannot model nested declarations, conditional syntax, or
precise ownership. A Roslyn sidecar would provide semantic binding but would
also require a .NET SDK, a separately built helper, and a long-lived process
protocol for an otherwise Node-distributed tool.

## Decision

Use the official ast-grep Node API with the prebuilt C# Tree-sitter grammar.

- Pin both packages exactly and include their versions in the extractor ID.
- Register dynamic languages once through a shared adapter runtime.
- Extract declarations and references from AST node kinds and named fields.
- Resolve exact and uniquely scoped relationships conservatively; do not invent
  an edge when an overloaded or global target remains ambiguous.
- Preserve Tree-sitter error nodes as non-fatal per-file diagnostics while
  retaining recoverable symbols and references.
- Keep the language adapter synchronous behind the existing port for this
  milestone. Revisit asynchronous multi-core extraction only after profiling.

## Consequences

- Node 22 can parse C# without a local compiler toolchain or native build step.
- Unity conditional-compilation branches and generated code may yield recoverable
  diagnostics even when declarations remain usable.
- This is syntactic binding, not Roslyn type analysis. Variable receiver types,
  overload resolution, project references, and compile symbols are intentionally
  conservative.
- The structural cache schema advances to version 2 so diagnostic-bearing
  contributions never mix with older cache records.

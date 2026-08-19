# ADR 0013: Add compiler-backed Python structural contributions

- Status: Accepted
- Date: 2026-08-19

## Context

SemanticTrellis needs common-language coverage beyond TypeScript, JavaScript,
and C#. Python has lexical classes and functions but dynamic invocation makes a
call expression insufficient to distinguish a function call from class
construction without runtime or type information.

Line-based or regular-expression extraction would also lose nested scope,
decorators, relative imports, async definitions, and recoverable parser
diagnostics.

## Decision

- Parse `.py` and `.pyi` with the prebuilt ast-grep Tree-sitter Python grammar.
- Extract modules, classes, functions, async functions, methods, constructors,
  properties, imports, inheritance, decorators, and invocation references.
- Introduce the language-neutral `invoke` reference kind for Python call
  expressions. It can resolve conservatively to callable symbols or classes
  without claiming whether the runtime operation is a call or construction.
- Preserve stable owner-local reference ordinals and per-file diagnostics.
- Model Python argument ranges when they are syntactically knowable; splatted
  call arguments retain unknown observed arity.
- Resolve absolute and relative Python modules to `.py`, `.pyi`, or
  `__init__` contributions when present.
- Advance the disposable structural cache to schema version 7.

## Consequences

- Existing grep, symbols, trace, search, ask, AI bootstrap, CLI, and MCP paths
  gain Python support through the shared language registry.
- Dynamic receivers and same-name runtime rebinding remain unresolved rather
  than producing speculative edges.
- Class invocation edges use `invoke`, keeping their semantics honest until a
  future type-aware provider can refine them.
- Existing local structural indexes rebuild once after the schema upgrade.

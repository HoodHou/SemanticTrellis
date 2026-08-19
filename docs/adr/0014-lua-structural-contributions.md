# ADR 0014: Add compiler-backed Lua structural contributions

- Status: Accepted
- Date: 2026-08-19

## Context

Lua repositories commonly represent modules as local tables, attach functions
through dot or colon syntax, assign anonymous functions to table fields, load
modules through `require`, and register anonymous callbacks. Regular-expression
extraction cannot preserve these ownership and call relationships reliably.

Lua invocation is also dynamic: a table field can be replaced at runtime and a
receiver's concrete metatable is not generally knowable from syntax alone.

## Decision

- Parse `.lua` with the prebuilt ast-grep Tree-sitter Lua grammar.
- Extract module tables, local and nested functions, dot and colon methods,
  assigned functions, top-level variables and fields, and labelled anonymous
  callbacks.
- Record `require("module.path")` as an import and resolve it to either
  `module/path.lua` or `module/path/init.lua` when uniquely present.
- Represent ordinary Lua calls as the existing conservative `invoke` relation.
- Preserve dot and colon method ownership, stable owner-local reference ordinals,
  fixed or variadic arity, and recoverable parser diagnostics.
- Prefer same-file qualified targets before global candidates, which keeps
  conventional `M.method` module tables deterministic across many files.

## Consequences

- Existing structure, grep, symbols, trace, search, ask, AI bootstrap, CLI, and
  MCP paths gain Lua without language-specific tools.
- `self:method()` and same-file module-table calls can resolve structurally.
- Calls through aliases returned by `require`, metatable inheritance, and runtime
  field replacement remain conservative future work.
- Lua reuses structural cache schema version 7 because `invoke` already exists.

# ADR 0010: Filter structural call targets by argument arity

- Status: Accepted
- Date: 2026-08-19

## Context

Large C# repositories commonly contain method overloads. Name and lexical-scope
resolution correctly refused to choose between overloads, but it also reported
avoidable ambiguity when the candidates accepted different numbers of
arguments.

Full type binding remains outside the disposable syntactic index. A smaller
piece of call-shape information can improve precision without pretending to
know receiver or argument types.

## Decision

- Store the observed argument count on call and construction references.
- Store the minimum and maximum accepted argument count on callable symbols.
- Account for optional parameters and unbounded `params` or rest parameters.
- Filter candidates by compatible arity before requiring a unique target.
- Retain candidates with unknown arity and retain ambiguity when multiple
  candidates still match.
- Advance the disposable structural cache to schema version 6.

## Consequences

- Overloads with distinct argument counts resolve deterministically.
- Same-arity overloads remain ambiguous until a future type-aware adapter can
  distinguish them.
- The index grows slightly because symbols and references carry call-shape
  metadata.
- Existing local structural indexes are rebuilt once after the schema upgrade.

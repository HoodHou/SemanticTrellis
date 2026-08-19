# ADR 0011: Coalesce equivalent C# partial type declarations during resolution

- Status: Accepted
- Date: 2026-08-19

## Context

C# partial types intentionally split one logical type across multiple files.
Per-file structural contributions correctly preserve every declaration, but a
construction or inheritance reference previously saw the declarations as
multiple candidates and reported avoidable ambiguity.

## Decision

- Record whether each extracted declaration carries the C# `partial` modifier.
- When every remaining candidate is partial and all candidates share the same
  symbol kind and fully qualified name, treat them as one logical target.
- Use the lexicographically first stable symbol ID as the navigational edge
  target while retaining every declaration in its owning file contribution.
- Do not coalesce candidates across namespaces, kinds, or non-partial
  declarations.

## Consequences

- References to valid partial types no longer appear ambiguous solely because
  the type spans multiple files.
- Structural traces land on one deterministic representative declaration.
- The curated layer may still model the complete logical type independently of
  this disposable representative choice.

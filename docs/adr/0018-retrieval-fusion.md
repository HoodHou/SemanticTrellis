# ADR 0018: Fuse ask results with callee cruxes and curated nodes

- Status: Accepted
- Date: 2026-10-16

## Context

Ask could return the call site of a domain rule while the implementing symbol
sat one hop away. A follow-up grep then spent budget on test callbacks.
Curated-graph search also used whole-string containment instead of the term
and inverse-document-frequency ranking already used for symbols.

## Decision

- When character budget remains, ask attaches up to two direct `call`,
  `invoke`, or `construct` callees as eight-line cruxes. Ranking prefers scarce
  callees and query-term overlap, and it skips test paths and synthetic test
  callbacks unless the query asks about tests.
- Reserve at most 34 percent of the source budget, and at most 1,600
  characters, for those cruxes. Primary hits keep the rest.
- Ask also returns the top one or two curated-node search hits.
- Curated search splits tokens the same way symbol search does and weights
  them by inverse document frequency.
- Grep accepts `symbolKinds`. Test paths and synthetic `it` or `test`
  callbacks stay in the result but rank below production symbols.

## Consequences

- One ask can include both an entry symbol and the next implementation when
  the budget allows.
- Full-body mode still prefers the requested symbols; callee cruxes use only
  the reserved slice.
- Grep callers can exclude tests explicitly with `symbolKinds` and also get
  the default rank penalty when they do not.

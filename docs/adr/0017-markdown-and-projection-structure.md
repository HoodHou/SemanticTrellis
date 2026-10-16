# ADR 0017: Extract Markdown and projection structure

- Status: Accepted
- Date: 2026-10-16

## Context

Markdown and `.strellis.json` projections are eligible text, but they previously
had no structural symbols. Ask, trace, and grep could not name a heading, a
sheet, or the code that mentions them.

## Decision

- Add a Markdown adapter for heading sections, pipe tables, header fields, and
  repository-relative links.
- Add a `.strellis.json` adapter that matches only that suffix. Other `.json`
  files stay outside the structural index. The adapter records the bound
  artifact name, sheets, fields, and a bounded set of row ids.
- Add symbol kinds `heading`, `table`, and `sheet`, and reference kind
  `references`.
- Advance the disposable structural cache to schema version 8. Older indexes
  are discarded and rebuilt.
- After extraction, bind code string literals to unique document paths and
  unique heading, sheet, table, field, or artifact names. Resolution of
  `references` does not fall through to ordinary call lookup.
- Markdown links resolve to the target file, or to a unique heading when the
  link has an anchor.

## Consequences

- Trace and ask can follow a code literal to a projection sheet or an ADR
  heading when the name or path is unique.
- Ambiguous names stay unresolved.
- Common field names such as `id` and `name` are not used as cross-layer
  lookup keys.
- A documentation or projection change rescans code literals so reused code
  files pick up new targets.

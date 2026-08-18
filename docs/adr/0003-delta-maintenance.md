# ADR 0003: Maintenance is contribution based

- Status: Accepted
- Date: 2026-08-18

## Context

Large repositories make full graph reconstruction too expensive for routine
queries. Caching parses helps, but a design that still recomputes every global
relationship remains proportional to repository size.

## Decision

Each source file will eventually own a structural contribution containing its
definitions and unresolved references. When a file changes, maintenance removes
its old contribution, inserts the new contribution, and re-resolves only keys
touched by the change.

The first milestone establishes the same lifecycle at file granularity using
content hashes and review items.

## Consequences

- Routine cost is tied to the change set and affected keys.
- Contribution records need extractor identities and schema versions.
- Rename detection and broad cross-cutting changes may intentionally expand the
  impact set.
- Periodic audits remain necessary, but they verify rather than regenerate by
  default.

# Contributing

SemanticTrellis is in its architecture-first stage. Prefer small vertical
slices that preserve the product invariants over broad speculative frameworks.

## Development setup

```bash
npm install
npm run verify
```

Use Node.js 22 or newer.

## Change workflow

1. Read the architecture overview and relevant ADRs.
2. Add a failing test for the behavior being introduced or corrected.
3. Implement the smallest coherent change.
4. Run `npm run verify`.
5. Update documentation when a command, schema, or invariant changes.

## Architecture decisions

Create an ADR when a change affects any of the following:

- canonical versus disposable data;
- stable identity rules;
- graph schema or patch operations;
- incremental invalidation boundaries;
- AI provider contracts;
- parser or language integration strategy.

## Language

All project artifacts and collaboration written into the repository please use English.

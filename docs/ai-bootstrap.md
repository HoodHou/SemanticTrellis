# Agent-driven AI bootstrap

SemanticTrellis uses the connected MCP Agent to review every eligible Git-visible
text file before the first semantic graph is accepted.

## Consent and scope

1. Call `semantic_trellis_bootstrap_preview`.
2. Show the eligible-text disclosure manifest and unsupported-artifact summary
   to the user.
3. Obtain explicit approval to disclose this source to the connected Agent
   model.
4. Call `semantic_trellis_bootstrap_start` with
   `sourceDisclosureApproved: true`.

The source policy excludes ignored, generated, dependency, binary, and
configured directories. No source text is stored in bootstrap state.

## Unsupported artifact projection fallback

The preview now inventories unsupported Git-visible files automatically. Page
the complete set with `semantic_trellis_unsupported_list`. Never ignore a
relevant artifact, decode binary bytes as text, or invent a summary.

After explicit read approval, use a format-aware host tool to construct a
source-bound `.strellis.json` or `.strellis.md` document. Call
`semantic_trellis_projection_validate`, present its exact source, target,
digests, byte size, omissions, warnings, and overwrite state, then obtain write
approval before calling `semantic_trellis_projection_register` with the
unchanged document and token. Never write a sidecar directly or overwrite the
original artifact.

Restart bootstrap after registration. Bootstrap start and completion reject
stale, invalid, and orphaned projections. Unprojected artifacts remain visible
for relevance review. See [Artifact projections](artifact-projections.md) for
the complete schema and workflow.

## Stage 1: chunk review

Repeat:

1. `semantic_trellis_bootstrap_next_batch`
2. read every returned source chunk;
3. submit one grounded summary per unit with
   `semantic_trellis_bootstrap_submit_chunk_summaries`.

Each summary records key facts, risks, confidence, producer, and model. The
server binds it to the exact path, hash, and character range.

## Stage 2: file rollup

Repeat:

1. `semantic_trellis_bootstrap_next_rollups`
2. synthesize the complete chunk summaries together with extracted symbols and
   references and any non-fatal parser diagnostics;
3. submit a file-level summary through
   `semantic_trellis_bootstrap_submit_file_summaries`.

File summaries record responsibilities, key symbols, dependencies, inputs,
outputs, side effects, risks, concepts, evidence, and confidence.

## Stage 3: curation

1. Page every summary with `semantic_trellis_bootstrap_context`.
2. Classify stable systems, subsystems, components, concepts, and invariants.
3. Build typed relationships and cite repository-relative source evidence.
4. Call `semantic_trellis_validate_patch`.
5. Present the proposal to the user and obtain approval.
6. Call `semantic_trellis_apply_patch` with the unchanged patch and token.
7. Call `semantic_trellis_bootstrap_complete` with the applied graph digest.

Completion fails unless every chunk and file is summarized and the curated graph
audit is completely clean.

## Resume and incremental reuse

The session lives in `.semantic-trellis/local/agent-bootstrap.json`. Restarting
the same snapshot resumes immediately. After source changes, starting again
creates a new snapshot session and reuses unchanged content-derived chunk and
file summaries.

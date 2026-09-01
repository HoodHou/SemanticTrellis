# Agent-assisted artifact projections

SemanticTrellis inventories Git-visible files outside the eligible-text policy
without decoding or disclosing their bytes. A connected Agent can use a
format-aware host tool to turn a relevant artifact into a deterministic text
sidecar that participates in normal bootstrap, sync, curation, and audit.

## Safety workflow

1. Call `semantic_trellis_unsupported_list` and page until `nextOffset` is
   `null`.
2. Present relevant unsupported paths, sizes, reasons, and hashes to the user.
3. Obtain explicit approval before a format-aware host tool reads an artifact.
4. Construct a source-bound `.strellis.json` or `.strellis.md` document. Do not
   write it directly.
5. Call `semantic_trellis_projection_validate`.
6. Present the exact target, source hash, projection hash, byte size, omissions,
   warnings, and overwrite state to the user.
7. After explicit write approval, call `semantic_trellis_projection_register`
   with the unchanged path, document, and token.
8. Restart bootstrap so the registered sidecar enters a new frozen snapshot.

Registration never modifies the original artifact. A stale source, changed
document, changed target, arbitrary path, invalid UTF-8, or malformed metadata
invalidates validation. One unsupported source may have at most one registered
sidecar; replace the existing format deliberately instead of maintaining two
competing projections.

## JSON projection format

The target must be `<source-path>.strellis.json`. Schema version 1 is strict;
unknown metadata fields are rejected. `content` must be a JSON object or array.

```json
{
  "schemaVersion": 1,
  "kind": "semantic-trellis-projection",
  "source": {
    "path": "design/BattleConfig.xlsx",
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "mediaType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  },
  "producer": {
    "tool": "workbook-reader",
    "version": "1.0.0"
  },
  "omissions": [],
  "warnings": [],
  "content": {
    "sheets": [
      {
        "name": "BattleUnit",
        "fields": ["id", "health"],
        "rows": [
          { "id": 1, "health": 100 }
        ]
      }
    ]
  }
}
```

For workbooks, preserve sheet order, tables, stable row identities, fields,
formulas, named ranges, validations, and cross-sheet references whenever the
host tool exposes them. Record every unsupported workbook feature in
`omissions` or `warnings`.

## Markdown projection format

The target must be `<source-path>.strellis.md`. The file starts exactly with a
JSON metadata block and continues with a non-empty Markdown body:

```markdown
<!-- semantic-trellis-projection
{
  "schemaVersion": 1,
  "kind": "semantic-trellis-projection",
  "source": {
    "path": "design/Overview.binary",
    "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "mediaType": "application/octet-stream"
  },
  "producer": {
    "tool": "document-reader",
    "version": "1.0.0"
  },
  "omissions": [],
  "warnings": []
}
-->
# Overview

Normalized document content begins here.
```

Do not include generation timestamps or machine-specific absolute paths. Array
order must preserve source meaning; object keys, metadata lists, line endings,
and trailing newlines are normalized during registration.

## Status and maintenance

`semantic_trellis_projection_status` reports:

- `current`: the recorded source hash matches;
- `stale`: the source changed and this projection must be regenerated;
- `invalid`: the sidecar violates the format or normalization contract;
- `missing-source`: the source no longer exists;
- `source-supported`: the source now belongs to the native eligible-text path;
- `unprojected`: no sidecar has been registered for the unsupported artifact.

The disposable `.semantic-trellis/local/projection-index.json` reuses hashes for
stat-stable files. Changing one source marks only its projection stale; it does
not regenerate or invalidate unrelated projections.

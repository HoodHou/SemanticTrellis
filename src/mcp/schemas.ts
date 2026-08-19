import * as z from "zod/v4";
import type { GraphPatch } from "../domain/model.js";

export const sourceReferenceSchema = z.object({
  path: z.string().min(1).describe("Repository-relative source path."),
  role: z.enum(["primary", "supporting"]),
});

export const semanticNodeSchema = z.object({
  id: z.string().min(1).describe("Stable semantic node ID."),
  name: z.string().min(1),
  kind: z.enum([
    "system",
    "subsystem",
    "component",
    "concept",
    "invariant",
    "file",
    "external",
  ]),
  summary: z.string(),
  sources: z.array(sourceReferenceSchema),
  tags: z.array(z.string()),
  status: z.enum(["proposed", "approved", "deprecated"]),
  locked: z.boolean(),
});

export const semanticEdgeSchema = z.object({
  id: z.string().min(1).describe("Stable semantic edge ID."),
  from: z.string().min(1),
  to: z.string().min(1),
  relation: z.enum([
    "contains",
    "depends-on",
    "calls",
    "produces",
    "consumes",
    "implements",
    "extends",
    "configures",
    "validates",
    "documents",
    "related-to",
  ]),
  description: z.string(),
  status: z.enum(["proposed", "approved", "deprecated"]),
});

const patchOperationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("upsert-node"),
    node: semanticNodeSchema,
    overrideLocked: z.boolean().optional(),
  }),
  z.object({
    op: z.literal("remove-node"),
    nodeId: z.string().min(1),
    overrideLocked: z.boolean().optional(),
  }),
  z.object({ op: z.literal("upsert-edge"), edge: semanticEdgeSchema }),
  z.object({ op: z.literal("remove-edge"), edgeId: z.string().min(1) }),
  z.object({ op: z.literal("mark-reviewed"), paths: z.array(z.string().min(1)).min(1) }),
]);

export const graphPatchSchema = z.object({
  schemaVersion: z.literal(1),
  operations: z.array(patchOperationSchema).min(1),
});

export function asGraphPatch(value: z.infer<typeof graphPatchSchema>): GraphPatch {
  return value;
}

export const statusOutputSchema = z.object({
  projectId: z.string(),
  bootstrapped: z.boolean(),
  aiBootstrapped: z.boolean(),
  aiBootstrapStage: z.enum([
    "summarize-chunks",
    "summarize-files",
    "ready-for-curation",
    "complete",
  ]).nullable(),
  files: z.number().int().nonnegative(),
  nodes: z.number().int().nonnegative(),
  edges: z.number().int().nonnegative(),
  pendingReviews: z.number().int().nonnegative(),
});

export const graphOutputSchema = z.object({
  projectId: z.string(),
  focusNodeId: z.string().nullable(),
  depth: z.number().int().nonnegative(),
  direction: z.enum(["both", "incoming", "outgoing"]),
  nodes: z.array(semanticNodeSchema),
  edges: z.array(semanticEdgeSchema),
});

export const searchOutputSchema = z.object({
  query: z.string(),
  hits: z.array(
    z.object({
      node: semanticNodeSchema,
      score: z.number(),
      matchedFields: z.array(z.string()),
    }),
  ),
});

export const reviewItemSchema = z.object({
  id: z.string(),
  path: z.string(),
  changeKind: z.enum(["added", "changed", "removed"]),
  reason: z.enum([
    "initial-classification",
    "source-added",
    "source-changed",
    "source-removed",
  ]),
  beforeHash: z.string().nullable(),
  afterHash: z.string().nullable(),
  relatedNodeIds: z.array(z.string()),
});

export const reviewQueueOutputSchema = z.object({
  total: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  items: z.array(reviewItemSchema),
});

export const auditIssueSchema = z.object({
  severity: z.enum(["error", "warning", "info"]),
  code: z.string(),
  message: z.string(),
  subject: z.string(),
});

export const auditOutputSchema = z.object({
  projectId: z.string(),
  errors: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
  information: z.number().int().nonnegative(),
  issues: z.array(auditIssueSchema),
});

export const syncOutputSchema = z.object({
  files: z.number().int().nonnegative(),
  changes: z.number().int().nonnegative(),
  byKind: z.object({
    added: z.number().int().nonnegative(),
    changed: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
  }),
  pendingReviews: z.number().int().nonnegative(),
  fullAuditRecommended: z.boolean(),
});

export const validationOutputSchema = z.object({
  validationToken: z.string().length(64),
  currentGraphDigest: z.string().length(64),
  proposedGraphDigest: z.string().length(64),
  nodes: z.number().int().nonnegative(),
  edges: z.number().int().nonnegative(),
  reviewedPaths: z.array(z.string()),
  warnings: z.number().int().nonnegative(),
  information: z.number().int().nonnegative(),
  reviewStateDigest: z.string().length(64),
});

export const applyOutputSchema = z.object({
  nodes: z.number().int().nonnegative(),
  edges: z.number().int().nonnegative(),
  reviewedPaths: z.number().int().nonnegative(),
  pendingReviews: z.number().int().nonnegative(),
});

export const sourceSpanSchema = z.object({
  startLine: z.number().int().positive(),
  startColumn: z.number().int().positive(),
  endLine: z.number().int().positive(),
  endColumn: z.number().int().positive(),
});

export const structuralSymbolSchema = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  qualifiedName: z.string(),
  kind: z.enum([
    "file",
    "module",
    "class",
    "interface",
    "struct",
    "record",
    "type",
    "enum",
    "delegate",
    "function",
    "callback",
    "method",
    "constructor",
    "destructor",
    "operator",
    "property",
    "field",
    "event",
    "variable",
  ]),
  span: sourceSpanSchema,
  signature: z.string(),
  parentId: z.string().nullable(),
  callArity: z.object({
    min: z.number().int().nonnegative(),
    max: z.number().int().nonnegative().nullable(),
  }).nullable(),
  partial: z.boolean(),
});

export const structuralEdgeSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  kind: z.enum(["call", "construct", "import", "extends", "implements"]),
  referenceId: z.string(),
});

export const structuralBuildMetricsSchema = z.object({
  discoveryMode: z.enum(["git", "filesystem"]),
  filesDiscovered: z.number().int().nonnegative(),
  filesSupported: z.number().int().nonnegative(),
  parsedFiles: z.number().int().nonnegative(),
  reusedFiles: z.number().int().nonnegative(),
  removedFiles: z.number().int().nonnegative(),
  resolvedFiles: z.number().int().nonnegative(),
  symbols: z.number().int().nonnegative(),
  references: z.number().int().nonnegative(),
  diagnostics: z.number().int().nonnegative(),
  diagnosticFiles: z.number().int().nonnegative(),
  edges: z.number().int().nonnegative(),
  resolvedReferences: z.number().int().nonnegative(),
  unresolvedReferences: z.number().int().nonnegative(),
  ambiguousReferences: z.number().int().nonnegative(),
  unknownReceiverReferences: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
});

export const sourceContextSchema = z.object({
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  text: z.string(),
  truncated: z.boolean(),
});

export const structuralSymbolSourceSchema = z.object({
  symbolId: z.string(),
  path: z.string(),
  context: sourceContextSchema,
});

export const structuralGrepHitSchema = z.object({
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  matchLength: z.number().int().nonnegative(),
  text: z.string(),
  context: sourceContextSchema.optional(),
});

export const structuralGrepOutputSchema = z.object({
  pattern: z.string(),
  filesSearched: z.number().int().nonnegative(),
  totalHits: z.number().int().nonnegative(),
  groups: z.array(
    z.object({
      path: z.string(),
      symbolId: z.string(),
      symbolName: z.string(),
      symbolKind: structuralSymbolSchema.shape.kind,
      inDegree: z.number().int().nonnegative(),
      curatedNodeIds: z.array(z.string()),
      totalHits: z.number().int().nonnegative(),
      truncatedHits: z.number().int().nonnegative(),
      sourceContext: sourceContextSchema.optional(),
      hits: z.array(structuralGrepHitSchema),
    }),
  ),
  truncatedHits: z.number().int().nonnegative(),
  symbolAttributionRate: z.number().min(0).max(1),
  curatedAttributionRate: z.number().min(0).max(1),
  queryDurationMs: z.number().nonnegative(),
});

export const fileSymbolsOutputSchema = z.object({
  file: z.string(),
  symbols: z.array(structuralSymbolSchema),
  sourceContexts: z.array(structuralSymbolSourceSchema),
  build: structuralBuildMetricsSchema,
});

export const structuralTraceOutputSchema = z.object({
  trace: z.object({
    query: z.string(),
    direction: z.enum(["incoming", "outgoing", "both"]),
    depth: z.number().int().nonnegative(),
    found: z.boolean(),
    focus: z.array(structuralSymbolSchema),
    symbols: z.array(structuralSymbolSchema),
    edges: z.array(structuralEdgeSchema),
    ambiguous: z.boolean(),
    suggestions: z.array(z.object({
      symbol: structuralSymbolSchema,
      score: z.number(),
    })),
  }),
  sourceContexts: z.array(structuralSymbolSourceSchema),
  build: structuralBuildMetricsSchema,
});

export const structuralSymbolSearchOutputSchema = z.object({
  query: z.string(),
  hits: z.array(z.object({
    symbol: structuralSymbolSchema,
    score: z.number(),
    matchedFields: z.array(z.string()),
    inDegree: z.number().int().nonnegative(),
    curatedNodeIds: z.array(z.string()),
  })),
  build: structuralBuildMetricsSchema,
});

export const structuralAskOutputSchema = structuralSymbolSearchOutputSchema.extend({
  sourceContexts: z.array(structuralSymbolSourceSchema),
});

export const agentBootstrapStatusSchema = z.object({
  sessionId: z.string().length(64),
  snapshotDigest: z.string().length(64),
  stage: z.enum(["summarize-chunks", "summarize-files", "ready-for-curation", "complete"]),
  sourceDisclosureApproved: z.boolean(),
  totalFiles: z.number().int().nonnegative(),
  totalChunks: z.number().int().nonnegative(),
  summarizedChunks: z.number().int().nonnegative(),
  summarizedFiles: z.number().int().nonnegative(),
  totalCharacters: z.number().int().nonnegative(),
  summarizedCharacters: z.number().int().nonnegative(),
  chunkCoverage: z.number().min(0).max(1),
  fileCoverage: z.number().min(0).max(1),
  reusedChunkSummaries: z.number().int().nonnegative(),
  reusedFileSummaries: z.number().int().nonnegative(),
  completedGraphDigest: z.string().length(64).nullable(),
});

export const agentBootstrapStartOutputSchema = z.object({
  status: agentBootstrapStatusSchema,
  structural: z.object({
    parsedFiles: z.number().int().nonnegative(),
    reusedFiles: z.number().int().nonnegative(),
    resolvedFiles: z.number().int().nonnegative(),
    symbols: z.number().int().nonnegative(),
    references: z.number().int().nonnegative(),
    diagnostics: z.number().int().nonnegative(),
    diagnosticFiles: z.number().int().nonnegative(),
    edges: z.number().int().nonnegative(),
    resolvedReferences: z.number().int().nonnegative(),
    unresolvedReferences: z.number().int().nonnegative(),
    ambiguousReferences: z.number().int().nonnegative(),
    unknownReceiverReferences: z.number().int().nonnegative(),
  }),
});

export const agentBootstrapPreviewOutputSchema = z.object({
  discoveryMode: z.enum(["git", "filesystem"]),
  totalFiles: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  extensions: z.record(z.string(), z.number().int().nonnegative()),
  suspiciousPaths: z.array(z.string()),
  largestFiles: z.array(z.object({ path: z.string(), size: z.number().int().nonnegative() })),
});

export const chunkSummarySubmissionSchema = z.object({
  unitId: z.string().length(64),
  summary: z.string().min(1),
  keyFacts: z.array(z.string()),
  risks: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  producer: z.string().min(1),
  model: z.string().nullable(),
});

export const fileSemanticSummarySchema = z.object({
  path: z.string().min(1),
  hash: z.string().length(64),
  summary: z.string().min(1),
  responsibilities: z.array(z.string()),
  keySymbols: z.array(z.string()),
  dependencies: z.array(z.string()),
  inputs: z.array(z.string()),
  outputs: z.array(z.string()),
  sideEffects: z.array(z.string()),
  risks: z.array(z.string()),
  concepts: z.array(z.string()),
  evidence: z.array(
    z.object({
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive(),
      description: z.string().min(1),
    }),
  ),
  confidence: z.number().min(0).max(1),
  producer: z.string().min(1),
  model: z.string().nullable(),
});

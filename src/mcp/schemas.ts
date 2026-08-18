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
  z.object({ op: z.literal("upsert-node"), node: semanticNodeSchema }),
  z.object({ op: z.literal("remove-node"), nodeId: z.string().min(1) }),
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
});

export const applyOutputSchema = z.object({
  nodes: z.number().int().nonnegative(),
  edges: z.number().int().nonnegative(),
  reviewedPaths: z.number().int().nonnegative(),
  pendingReviews: z.number().int().nonnegative(),
});

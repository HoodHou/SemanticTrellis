import { applyGraphPatch, auditGraph } from "../domain/graph.js";
import type { GraphPatch } from "../domain/model.js";
import { markReviewed } from "../domain/review.js";
import { digestJson } from "../infrastructure/digest.js";
import {
  loadGraph,
  loadPatch,
  loadReviewQueue,
  loadSnapshot,
  saveGraph,
  saveReviewQueue,
} from "../infrastructure/project-store.js";

export interface CurateResult {
  nodes: number;
  edges: number;
  reviewedPaths: number;
  pendingReviews: number;
}

export interface CurationValidation {
  validationToken: string;
  currentGraphDigest: string;
  proposedGraphDigest: string;
  nodes: number;
  edges: number;
  reviewedPaths: string[];
  warnings: number;
  information: number;
}

function validationToken(currentGraphDigest: string, patch: GraphPatch): string {
  return digestJson({
    operation: "semantic-trellis-curation",
    schemaVersion: 1,
    currentGraphDigest,
    patch,
  });
}

export async function validateCurationPatch(
  root: string,
  patch: GraphPatch,
): Promise<CurationValidation> {
  const graph = await loadGraph(root);
  const snapshot = await loadSnapshot(root);
  const result = applyGraphPatch(graph, patch);
  const audit = auditGraph(result.graph, snapshot);
  if (audit.errors > 0) {
    throw new Error("Graph patch failed repository-aware audit.");
  }

  return {
    validationToken: validationToken(digestJson(graph), patch),
    currentGraphDigest: digestJson(graph),
    proposedGraphDigest: digestJson(result.graph),
    nodes: result.graph.nodes.length,
    edges: result.graph.edges.length,
    reviewedPaths: result.reviewedPaths,
    warnings: audit.warnings,
    information: audit.information,
  };
}

export async function applyValidatedCurationPatch(
  root: string,
  patch: GraphPatch,
  expectedValidationToken: string,
): Promise<CurateResult> {
  const graph = await loadGraph(root);
  const expected = validationToken(digestJson(graph), patch);
  if (expected !== expectedValidationToken) {
    throw new Error(
      "Curation validation token is invalid or stale. Validate the exact patch again before applying it.",
    );
  }

  const queue = await loadReviewQueue(root);
  const snapshot = await loadSnapshot(root);
  const result = applyGraphPatch(graph, patch);
  const audit = auditGraph(result.graph, snapshot);
  if (audit.errors > 0) throw new Error("Graph patch failed repository-aware audit.");

  const nextQueue = markReviewed(queue, result.reviewedPaths);
  await saveGraph(root, result.graph);
  await saveReviewQueue(root, nextQueue);
  return {
    nodes: result.graph.nodes.length,
    edges: result.graph.edges.length,
    reviewedPaths: result.reviewedPaths.length,
    pendingReviews: nextQueue.items.length,
  };
}

export async function curateProject(root: string, patchFile: string): Promise<CurateResult> {
  const patch = await loadPatch(patchFile);
  const validation = await validateCurationPatch(root, patch);
  return applyValidatedCurationPatch(root, patch, validation.validationToken);
}

import { applyGraphPatch, auditGraph } from "../domain/graph.js";
import type { GraphPatch, ReviewItem, ReviewQueue } from "../domain/model.js";
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
  reviewStateDigest: string;
}

function reviewedPaths(patch: GraphPatch): string[] {
  return [...new Set(
    patch.operations.flatMap((operation) =>
      operation.op === "mark-reviewed" ? operation.paths : [],
    ),
  )].sort();
}

function relevantReviewItems(queue: ReviewQueue, paths: string[]): ReviewItem[] {
  const selected = new Set(paths);
  return queue.items
    .filter((item) => selected.has(item.path))
    .sort((left, right) => left.path.localeCompare(right.path) || left.id.localeCompare(right.id));
}

function reviewStateDigest(queue: ReviewQueue, paths: string[]): string {
  return digestJson(relevantReviewItems(queue, paths));
}

function validationToken(
  currentGraphDigest: string,
  patch: GraphPatch,
  currentReviewStateDigest: string,
): string {
  return digestJson({
    operation: "semantic-trellis-curation",
    schemaVersion: 2,
    currentGraphDigest,
    patch,
    reviewStateDigest: currentReviewStateDigest,
  });
}

export async function validateCurationPatch(
  root: string,
  patch: GraphPatch,
): Promise<CurationValidation> {
  const [graph, snapshot, queue] = await Promise.all([
    loadGraph(root),
    loadSnapshot(root),
    loadReviewQueue(root),
  ]);
  const result = applyGraphPatch(graph, patch);
  const audit = auditGraph(result.graph, snapshot);
  if (audit.errors > 0) {
    throw new Error("Graph patch failed repository-aware audit.");
  }

  const currentReviewStateDigest = reviewStateDigest(queue, result.reviewedPaths);
  return {
    validationToken: validationToken(digestJson(graph), patch, currentReviewStateDigest),
    currentGraphDigest: digestJson(graph),
    proposedGraphDigest: digestJson(result.graph),
    nodes: result.graph.nodes.length,
    edges: result.graph.edges.length,
    reviewedPaths: result.reviewedPaths,
    warnings: audit.warnings,
    information: audit.information,
    reviewStateDigest: currentReviewStateDigest,
  };
}

export async function applyValidatedCurationPatch(
  root: string,
  patch: GraphPatch,
  expectedValidationToken: string,
): Promise<CurateResult> {
  const [graph, queue, snapshot] = await Promise.all([
    loadGraph(root),
    loadReviewQueue(root),
    loadSnapshot(root),
  ]);
  const currentReviewStateDigest = reviewStateDigest(queue, reviewedPaths(patch));
  const expected = validationToken(digestJson(graph), patch, currentReviewStateDigest);
  if (expected !== expectedValidationToken) {
    throw new Error(
      "Curation validation token is invalid or stale. The graph, patch, or reviewed queue entries changed; validate again before applying it.",
    );
  }

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

import { applyGraphPatch, auditGraph } from "../domain/graph.js";
import { markReviewed } from "../domain/review.js";
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

export async function curateProject(root: string, patchFile: string): Promise<CurateResult> {
  const graph = await loadGraph(root);
  const patch = await loadPatch(patchFile);
  const queue = await loadReviewQueue(root);
  const snapshot = await loadSnapshot(root);
  const result = applyGraphPatch(graph, patch);
  const audit = auditGraph(result.graph, snapshot);
  if (audit.errors > 0) {
    throw new Error("Graph patch failed repository-aware audit.");
  }

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

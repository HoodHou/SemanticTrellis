import { createSnapshot } from "../domain/snapshot.js";
import { createInitialReviewQueue } from "../domain/review.js";
import { scanRepository } from "../infrastructure/repository-scanner.js";
import {
  loadConfig,
  loadGraph,
  loadSnapshot,
  saveReviewQueue,
  saveSnapshot,
} from "../infrastructure/project-store.js";

export interface BootstrapResult {
  files: number;
  reviewItems: number;
}

export async function bootstrapProject(root: string): Promise<BootstrapResult> {
  const existingSnapshot = await loadSnapshot(root);
  if (existingSnapshot !== null) {
    throw new Error("Project is already bootstrapped. Run `strellis sync` instead.");
  }

  const config = await loadConfig(root);
  const graph = await loadGraph(root);
  if (graph.projectId !== config.projectId) {
    throw new Error("Project config and curated graph use different project IDs.");
  }

  const files = await scanRepository(root, config.source);
  const snapshot = createSnapshot(files);
  const queue = createInitialReviewQueue(snapshot, graph);
  await saveSnapshot(root, snapshot);
  await saveReviewQueue(root, queue);
  return { files: snapshot.files.length, reviewItems: queue.items.length };
}

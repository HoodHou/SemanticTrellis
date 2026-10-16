import { createReviewItems, mergeReviewQueue } from "../domain/review.js";
import { createSnapshot, diffSnapshots } from "../domain/snapshot.js";
import type { FileChangeKind } from "../domain/model.js";
import { scanRepository } from "../infrastructure/repository-scanner.js";
import { loadStructuralIndex } from "../infrastructure/structural-store.js";
import {
  loadConfig,
  loadGraph,
  loadReviewQueue,
  loadSnapshot,
  saveReviewQueue,
  saveSnapshot,
} from "../infrastructure/project-store.js";
import { buildStructuralIndex } from "./structure.js";

export interface SyncResult {
  files: number;
  changes: number;
  byKind: Record<FileChangeKind, number>;
  pendingReviews: number;
  fullAuditRecommended: boolean;
}

export async function syncProject(root: string): Promise<SyncResult> {
  const previous = await loadSnapshot(root);
  if (previous === null) {
    throw new Error("Project has no snapshot. Run `strellis bootstrap` first.");
  }

  const config = await loadConfig(root);
  const graph = await loadGraph(root);
  const previousStructure = await loadStructuralIndex(root);
  const current = createSnapshot(await scanRepository(root, config.source, {
    previousFiles: previous.files,
  }));
  const changes = diffSnapshots(previous, current);
  const nextStructure = changes.length === 0
    ? previousStructure
    : (await buildStructuralIndex(root)).index;
  const currentQueue = await loadReviewQueue(root);
  const queue = mergeReviewQueue(
    currentQueue,
    createReviewItems(changes, graph, previousStructure, nextStructure),
  );

  await saveReviewQueue(root, queue);
  await saveSnapshot(root, current);

  const byKind: Record<FileChangeKind, number> = { added: 0, changed: 0, removed: 0 };
  for (const change of changes) byKind[change.kind] += 1;
  const baseline = Math.max(previous.files.length, 1);

  return {
    files: current.files.length,
    changes: changes.length,
    byKind,
    pendingReviews: queue.items.length,
    fullAuditRecommended: changes.length / baseline >= config.maintenance.fullAuditChangeRatio,
  };
}

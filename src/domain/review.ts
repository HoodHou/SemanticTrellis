import {
  SCHEMA_VERSION,
  type CuratedGraph,
  type FileChange,
  type RepositorySnapshot,
  type ReviewItem,
  type ReviewQueue,
  type ReviewReason,
} from "./model.js";

function relatedNodes(graph: CuratedGraph, path: string): string[] {
  return graph.nodes
    .filter((node) => node.sources.some((source) => source.path === path))
    .map((node) => node.id)
    .sort();
}

function reviewId(change: FileChange): string {
  const identity = change.after?.hash ?? change.before?.hash ?? "missing";
  return `${change.kind}:${change.path}:${identity}`;
}

function reasonFor(change: FileChange): ReviewReason {
  switch (change.kind) {
    case "added":
      return "source-added";
    case "changed":
      return "source-changed";
    case "removed":
      return "source-removed";
  }
}

export function createInitialReviewQueue(
  snapshot: RepositorySnapshot,
  graph: CuratedGraph,
): ReviewQueue {
  const items: ReviewItem[] = snapshot.files.map((file) => ({
    id: `bootstrap:${file.path}:${file.hash}`,
    path: file.path,
    changeKind: "added",
    reason: "initial-classification",
    beforeHash: null,
    afterHash: file.hash,
    relatedNodeIds: relatedNodes(graph, file.path),
  }));

  return { schemaVersion: SCHEMA_VERSION, items };
}

export function createReviewItems(
  changes: FileChange[],
  graph: CuratedGraph,
): ReviewItem[] {
  return changes.map((change) => ({
    id: reviewId(change),
    path: change.path,
    changeKind: change.kind,
    reason: reasonFor(change),
    beforeHash: change.before?.hash ?? null,
    afterHash: change.after?.hash ?? null,
    relatedNodeIds: relatedNodes(graph, change.path),
  }));
}

export function mergeReviewQueue(
  current: ReviewQueue,
  incoming: ReviewItem[],
): ReviewQueue {
  const changedPaths = new Set(incoming.map((item) => item.path));
  const retained = current.items.filter((item) => !changedPaths.has(item.path));
  return {
    schemaVersion: SCHEMA_VERSION,
    items: [...retained, ...incoming].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  };
}

export function markReviewed(queue: ReviewQueue, paths: string[]): ReviewQueue {
  const reviewed = new Set(paths);
  return {
    schemaVersion: SCHEMA_VERSION,
    items: queue.items.filter((item) => !reviewed.has(item.path)),
  };
}

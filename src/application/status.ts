import {
  loadConfig,
  loadGraph,
  loadReviewQueue,
  loadSnapshot,
} from "../infrastructure/project-store.js";

export interface ProjectStatus {
  projectId: string;
  bootstrapped: boolean;
  files: number;
  nodes: number;
  edges: number;
  pendingReviews: number;
}

export async function projectStatus(root: string): Promise<ProjectStatus> {
  const config = await loadConfig(root);
  const graph = await loadGraph(root);
  const snapshot = await loadSnapshot(root);
  const queue = await loadReviewQueue(root);
  return {
    projectId: config.projectId,
    bootstrapped: snapshot !== null,
    files: snapshot?.files.length ?? 0,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    pendingReviews: queue.items.length,
  };
}

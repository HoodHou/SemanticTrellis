import { agentBootstrapStatus, type AgentBootstrapStage } from "../domain/agent-bootstrap.js";
import { loadAgentBootstrapSession } from "../infrastructure/agent-bootstrap-store.js";
import {
  loadConfig,
  loadGraph,
  loadReviewQueue,
  loadSnapshot,
} from "../infrastructure/project-store.js";

export interface ProjectStatus {
  projectId: string;
  bootstrapped: boolean;
  aiBootstrapped: boolean;
  aiBootstrapStage: AgentBootstrapStage | null;
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
  const bootstrapSession = await loadAgentBootstrapSession(root);
  const bootstrapStatus = bootstrapSession === null ? null : agentBootstrapStatus(bootstrapSession);
  return {
    projectId: config.projectId,
    bootstrapped: snapshot !== null,
    aiBootstrapped: bootstrapStatus?.stage === "complete",
    aiBootstrapStage: bootstrapStatus?.stage ?? null,
    files: snapshot?.files.length ?? 0,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    pendingReviews: queue.items.length,
  };
}

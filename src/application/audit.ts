import { auditGraph } from "../domain/graph.js";
import type { AuditIssue, GraphAudit } from "../domain/model.js";
import { loadConfig, loadGraph, loadSnapshot } from "../infrastructure/project-store.js";

export interface AuditResult extends GraphAudit {
  projectId: string;
}

export async function auditProject(root: string): Promise<AuditResult> {
  const config = await loadConfig(root);
  const graph = await loadGraph(root);
  const snapshot = await loadSnapshot(root);
  const audit = auditGraph(graph, snapshot);
  const issues: AuditIssue[] = [...audit.issues];

  if (graph.projectId !== config.projectId) {
    issues.unshift({
      severity: "error",
      code: "project-id-mismatch",
      message: `Config project ID ${config.projectId} does not match graph project ID ${graph.projectId}.`,
      subject: config.projectId,
    });
  }

  return {
    projectId: config.projectId,
    issues,
    errors: issues.filter((issue) => issue.severity === "error").length,
    warnings: issues.filter((issue) => issue.severity === "warning").length,
    information: issues.filter((issue) => issue.severity === "info").length,
  };
}

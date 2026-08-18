import {
  SCHEMA_VERSION,
  type AuditIssue,
  type CuratedGraph,
  type GraphAudit,
  type GraphPatch,
  type RepositorySnapshot,
  type SemanticEdge,
  type SemanticNode,
} from "./model.js";

export interface PatchResult {
  graph: CuratedGraph;
  reviewedPaths: string[];
}

export function createEmptyGraph(projectId: string): CuratedGraph {
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId,
    nodes: [],
    edges: [],
  };
}

function normalizedPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !/^[a-zA-Z]:[\\/]/.test(path) &&
    !path.split(/[\\/]/).includes("..")
  );
}

function duplicateIssues<T extends { id: string }>(
  values: T[],
  subjectType: "node" | "edge",
): AuditIssue[] {
  const seen = new Set<string>();
  const issues: AuditIssue[] = [];
  for (const value of values) {
    if (seen.has(value.id)) {
      issues.push({
        severity: "error",
        code: `duplicate-${subjectType}-id`,
        message: `Duplicate ${subjectType} ID: ${value.id}`,
        subject: value.id,
      });
    }
    seen.add(value.id);
  }
  return issues;
}

function auditNode(node: SemanticNode, snapshotPaths: Set<string> | null): AuditIssue[] {
  const issues: AuditIssue[] = [];
  if (!node.id.trim()) {
    issues.push({ severity: "error", code: "empty-node-id", message: "Node ID is empty.", subject: node.name });
  }
  if (!node.name.trim()) {
    issues.push({ severity: "error", code: "empty-node-name", message: "Node name is empty.", subject: node.id });
  }
  if (!node.summary.trim()) {
    issues.push({ severity: "warning", code: "empty-node-summary", message: "Node summary is empty.", subject: node.id });
  }

  const sourcePaths = new Set<string>();
  for (const source of node.sources) {
    if (!normalizedPath(source.path)) {
      issues.push({
        severity: "error",
        code: "invalid-source-path",
        message: `Source path must be repository relative: ${source.path}`,
        subject: node.id,
      });
    }
    if (sourcePaths.has(source.path)) {
      issues.push({
        severity: "warning",
        code: "duplicate-source-path",
        message: `Node cites the same source more than once: ${source.path}`,
        subject: node.id,
      });
    }
    if (snapshotPaths !== null && !snapshotPaths.has(source.path)) {
      issues.push({
        severity: "warning",
        code: "stale-source-path",
        message: `Node cites a source that is not in the current snapshot: ${source.path}`,
        subject: node.id,
      });
    }
    sourcePaths.add(source.path);
  }
  return issues;
}

function auditEdge(edge: SemanticEdge, nodeIds: Set<string>): AuditIssue[] {
  const issues: AuditIssue[] = [];
  if (!edge.id.trim()) {
    issues.push({ severity: "error", code: "empty-edge-id", message: "Edge ID is empty.", subject: `${edge.from}->${edge.to}` });
  }
  if (!nodeIds.has(edge.from)) {
    issues.push({
      severity: "error",
      code: "missing-edge-source",
      message: `Edge source does not exist: ${edge.from}`,
      subject: edge.id,
    });
  }
  if (!nodeIds.has(edge.to)) {
    issues.push({
      severity: "error",
      code: "missing-edge-target",
      message: `Edge target does not exist: ${edge.to}`,
      subject: edge.id,
    });
  }
  if (edge.from === edge.to) {
    issues.push({
      severity: "warning",
      code: "self-edge",
      message: "Edge points from a node to itself.",
      subject: edge.id,
    });
  }
  return issues;
}

export function auditGraph(
  graph: CuratedGraph,
  snapshot: RepositorySnapshot | null = null,
): GraphAudit {
  const snapshotPaths = snapshot === null ? null : new Set(snapshot.files.map((file) => file.path));
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const issues: AuditIssue[] = [
    ...duplicateIssues(graph.nodes, "node"),
    ...duplicateIssues(graph.edges, "edge"),
  ];

  for (const node of graph.nodes) issues.push(...auditNode(node, snapshotPaths));
  for (const edge of graph.edges) issues.push(...auditEdge(edge, nodeIds));

  if (snapshotPaths !== null) {
    const covered = new Set(graph.nodes.flatMap((node) => node.sources.map((source) => source.path)));
    for (const path of [...snapshotPaths].sort()) {
      if (!covered.has(path)) {
        issues.push({
          severity: "info",
          code: "unclassified-source",
          message: `Source is not represented by a curated node: ${path}`,
          subject: path,
        });
      }
    }
  }

  return {
    issues,
    errors: issues.filter((issue) => issue.severity === "error").length,
    warnings: issues.filter((issue) => issue.severity === "warning").length,
    information: issues.filter((issue) => issue.severity === "info").length,
  };
}

export function applyGraphPatch(graph: CuratedGraph, patch: GraphPatch): PatchResult {
  const nodes = new Map(graph.nodes.map((node) => [node.id, structuredClone(node)]));
  const edges = new Map(graph.edges.map((edge) => [edge.id, structuredClone(edge)]));
  const reviewedPaths = new Set<string>();

  for (const operation of patch.operations) {
    switch (operation.op) {
      case "upsert-node": {
        const existing = nodes.get(operation.node.id);
        const changesLockedNode = existing?.locked === true &&
          JSON.stringify(existing) !== JSON.stringify(operation.node);
        if (changesLockedNode && operation.overrideLocked !== true) {
          throw new Error(
            `Graph patch rejected: locked-node-modification: ${operation.node.id} requires overrideLocked=true.`,
          );
        }
        nodes.set(operation.node.id, structuredClone(operation.node));
        break;
      }
      case "remove-node": {
        const existing = nodes.get(operation.nodeId);
        if (existing?.locked === true && operation.overrideLocked !== true) {
          throw new Error(
            `Graph patch rejected: locked-node-removal: ${operation.nodeId} requires overrideLocked=true.`,
          );
        }
        nodes.delete(operation.nodeId);
        break;
      }
      case "upsert-edge":
        edges.set(operation.edge.id, structuredClone(operation.edge));
        break;
      case "remove-edge":
        edges.delete(operation.edgeId);
        break;
      case "mark-reviewed":
        for (const path of operation.paths) reviewedPaths.add(path);
        break;
    }
  }

  const next: CuratedGraph = {
    ...graph,
    nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...edges.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
  const audit = auditGraph(next);
  if (audit.errors > 0) {
    const messages = audit.issues
      .filter((issue) => issue.severity === "error")
      .map((issue) => `${issue.code}: ${issue.message}`)
      .join("; ");
    throw new Error(`Graph patch rejected: ${messages}`);
  }

  return { graph: next, reviewedPaths: [...reviewedPaths].sort() };
}

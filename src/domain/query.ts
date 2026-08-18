import type { CuratedGraph, SemanticEdge, SemanticNode } from "./model.js";

export type GraphDirection = "both" | "incoming" | "outgoing";

export interface GraphNeighborhood {
  projectId: string;
  focusNodeId: string | null;
  depth: number;
  direction: GraphDirection;
  nodes: SemanticNode[];
  edges: SemanticEdge[];
}

export interface GraphSearchHit {
  node: SemanticNode;
  score: number;
  matchedFields: string[];
}

function edgesFor(
  graph: CuratedGraph,
  nodeId: string,
  direction: GraphDirection,
): SemanticEdge[] {
  return graph.edges.filter((edge) => {
    if (direction === "outgoing") return edge.from === nodeId;
    if (direction === "incoming") return edge.to === nodeId;
    return edge.from === nodeId || edge.to === nodeId;
  });
}

function adjacentNode(edge: SemanticEdge, nodeId: string, direction: GraphDirection): string | null {
  if (direction === "outgoing") return edge.from === nodeId ? edge.to : null;
  if (direction === "incoming") return edge.to === nodeId ? edge.from : null;
  if (edge.from === nodeId) return edge.to;
  if (edge.to === nodeId) return edge.from;
  return null;
}

export function graphNeighborhood(
  graph: CuratedGraph,
  focusNodeId: string | null = null,
  depth = 1,
  direction: GraphDirection = "both",
): GraphNeighborhood {
  const safeDepth = Math.max(0, Math.floor(depth));
  if (focusNodeId === null) {
    return {
      projectId: graph.projectId,
      focusNodeId,
      depth: safeDepth,
      direction,
      nodes: [...graph.nodes].sort((left, right) => left.id.localeCompare(right.id)),
      edges: [...graph.edges].sort((left, right) => left.id.localeCompare(right.id)),
    };
  }
  if (!graph.nodes.some((node) => node.id === focusNodeId)) {
    throw new Error(`No curated node has ID ${focusNodeId}.`);
  }

  const selected = new Set<string>([focusNodeId]);
  let frontier = new Set<string>([focusNodeId]);
  for (let level = 0; level < safeDepth; level += 1) {
    const next = new Set<string>();
    for (const nodeId of frontier) {
      for (const edge of edgesFor(graph, nodeId, direction)) {
        const adjacent = adjacentNode(edge, nodeId, direction);
        if (adjacent !== null && !selected.has(adjacent)) {
          selected.add(adjacent);
          next.add(adjacent);
        }
      }
    }
    if (next.size === 0) break;
    frontier = next;
  }

  return {
    projectId: graph.projectId,
    focusNodeId,
    depth: safeDepth,
    direction,
    nodes: graph.nodes
      .filter((node) => selected.has(node.id))
      .sort((left, right) => left.id.localeCompare(right.id)),
    edges: graph.edges
      .filter((edge) => selected.has(edge.from) && selected.has(edge.to))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function includes(text: string, query: string): boolean {
  return text.toLowerCase().includes(query);
}

export function searchGraph(
  graph: CuratedGraph,
  query: string,
  limit = 10,
): GraphSearchHit[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const terms = normalized.split(/\s+/).filter(Boolean);
  const hits: GraphSearchHit[] = [];

  for (const node of graph.nodes) {
    let score = 0;
    const fields = new Set<string>();
    const id = node.id.toLowerCase();
    const name = node.name.toLowerCase();
    if (id === normalized || name === normalized) {
      score += 100;
      fields.add(id === normalized ? "id" : "name");
    } else {
      if (id.includes(normalized)) {
        score += 35;
        fields.add("id");
      }
      if (name.includes(normalized)) {
        score += 45;
        fields.add("name");
      }
    }

    for (const term of terms) {
      if (name.includes(term)) {
        score += 12;
        fields.add("name");
      }
      if (node.tags.some((tag) => includes(tag, term))) {
        score += 9;
        fields.add("tags");
      }
      if (includes(node.summary, term)) {
        score += 4;
        fields.add("summary");
      }
      if (node.sources.some((source) => includes(source.path, term))) {
        score += 6;
        fields.add("sources");
      }
      if (node.kind.includes(term)) {
        score += 3;
        fields.add("kind");
      }
    }

    if (score > 0) hits.push({ node, score, matchedFields: [...fields].sort() });
  }

  return hits
    .sort((left, right) => right.score - left.score || left.node.id.localeCompare(right.node.id))
    .slice(0, Math.max(1, Math.floor(limit)));
}

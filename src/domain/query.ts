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

function normalizedWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean);
}

function normalizedSearchTerm(value: string): string {
  if (
    value.length > 4 &&
    value.endsWith("s") &&
    !value.endsWith("ss") &&
    !value.endsWith("us") &&
    !value.endsWith("is")
  ) {
    return value.slice(0, -1);
  }
  return value;
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
  const terms = [...new Set(normalizedWords(normalized).map(normalizedSearchTerm))];
  const documents = graph.nodes.map((node) => ({
    node,
    id: node.id.toLowerCase(),
    name: node.name.toLowerCase(),
    kind: node.kind.toLowerCase(),
    summary: node.summary.toLowerCase(),
    tags: node.tags.map((tag) => tag.toLowerCase()),
    sources: node.sources.map((source) => source.path.toLowerCase()),
  }));
  const documentFrequency = new Map(
    terms.map((term) => [
      term,
      documents.filter((document) =>
        document.id.includes(term) ||
        document.name.includes(term) ||
        document.kind.includes(term) ||
        document.summary.includes(term) ||
        document.tags.some((tag) => tag.includes(term)) ||
        document.sources.some((source) => source.includes(term)),
      ).length,
    ]),
  );
  const idf = new Map(
    terms.map((term) => [
      term,
      Math.log((documents.length + 1) / ((documentFrequency.get(term) ?? 0) + 1)) + 1,
    ]),
  );
  const searchableTerms = terms.filter((term) => (documentFrequency.get(term) ?? 0) > 0);
  const totalQueryWeight = searchableTerms.reduce(
    (total, term) => total + (idf.get(term) ?? 1),
    0,
  );
  const hits: GraphSearchHit[] = [];

  for (const document of documents) {
    let score = 0;
    const fields = new Set<string>();
    const matchedTerms = new Set<string>();
    if (document.id === normalized || document.name === normalized) {
      score += 100;
      fields.add(document.id === normalized ? "id" : "name");
    } else {
      if (document.id.includes(normalized)) {
        score += 35;
        fields.add("id");
      }
      if (document.name.includes(normalized)) {
        score += 45;
        fields.add("name");
      }
    }

    for (const term of terms) {
      const weight = idf.get(term) ?? 1;
      let matched = false;
      if (document.name.includes(term)) {
        score += 12 * weight;
        fields.add("name");
        matched = true;
      }
      if (document.id.includes(term)) {
        score += 8 * weight;
        fields.add("id");
        matched = true;
      }
      if (document.tags.some((tag) => includes(tag, term))) {
        score += 9 * weight;
        fields.add("tags");
        matched = true;
      }
      if (includes(document.summary, term)) {
        score += 4 * weight;
        fields.add("summary");
        matched = true;
      }
      if (document.sources.some((source) => includes(source, term))) {
        score += 6 * weight;
        fields.add("sources");
        matched = true;
      }
      if (document.kind.includes(term)) {
        score += 3 * weight;
        fields.add("kind");
        matched = true;
      }
      if (matched) matchedTerms.add(term);
    }
    if (matchedTerms.size > 0 && totalQueryWeight > 0) {
      const matchedWeight = [...matchedTerms].reduce(
        (total, term) => total + (idf.get(term) ?? 1),
        0,
      );
      score += (matchedWeight / totalQueryWeight) * 20;
      if (terms.length > 1 && matchedTerms.size === terms.length) score += 12;
    }

    if (score > 0) {
      hits.push({
        node: document.node,
        score: Number(score.toFixed(3)),
        matchedFields: [...fields].sort(),
      });
    }
  }

  return hits
    .sort((left, right) => right.score - left.score || left.node.id.localeCompare(right.node.id))
    .slice(0, Math.max(1, Math.floor(limit)));
}

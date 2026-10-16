import { reviewCandidatePatch } from "../domain/review.js";
import type {
  GraphPatch,
  ReviewItem,
  ReviewStructuralDelta,
  SemanticNodeKind,
} from "../domain/model.js";
import { loadGraph, loadReviewQueue } from "../infrastructure/project-store.js";

export interface ReviewContextNode {
  id: string;
  name: string;
  kind: SemanticNodeKind;
  summary: string;
}

export interface ReviewContextItem {
  id: string;
  path: string;
  changeKind: ReviewItem["changeKind"];
  reason: ReviewItem["reason"];
  beforeHash: string | null;
  afterHash: string | null;
  relatedNodeIds: string[];
  structuralDelta: ReviewStructuralDelta | null;
  affectedNodes: ReviewContextNode[];
}

export interface ReviewContext {
  total: number;
  returned: number;
  items: ReviewContextItem[];
  candidatePatch: GraphPatch | null;
}

function normalizePrefix(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return normalized.length === 0 ? null : normalized;
}

export async function buildReviewContext(
  root: string,
  pathPrefix?: string,
  limit = 100,
): Promise<ReviewContext> {
  const [queue, graph] = await Promise.all([loadReviewQueue(root), loadGraph(root)]);
  const prefix = normalizePrefix(pathPrefix);
  const matching = prefix === null
    ? queue.items
    : queue.items.filter((item) => item.path === prefix || item.path.startsWith(`${prefix}/`));
  const selected = matching.slice(0, Math.max(1, Math.min(500, Math.floor(limit))));
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const items = selected.map((item) => {
    const ids = new Set(item.relatedNodeIds);
    const movedFrom = item.structuralDelta?.movedFrom;
    const movedTo = item.structuralDelta?.movedTo;
    for (const node of graph.nodes) {
      if (node.sources.some((source) =>
        source.path === item.path || source.path === movedFrom || source.path === movedTo,
      )) {
        ids.add(node.id);
      }
    }
    return {
      id: item.id,
      path: item.path,
      changeKind: item.changeKind,
      reason: item.reason,
      beforeHash: item.beforeHash,
      afterHash: item.afterHash,
      relatedNodeIds: item.relatedNodeIds,
      structuralDelta: item.structuralDelta,
      affectedNodes: [...ids]
        .map((id) => nodesById.get(id))
        .filter((node): node is NonNullable<typeof node> => node !== undefined)
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((node) => ({
          id: node.id,
          name: node.name,
          kind: node.kind,
          summary: node.summary,
        })),
    };
  });
  return {
    total: matching.length,
    returned: items.length,
    items,
    candidatePatch: reviewCandidatePatch(matching, graph),
  };
}

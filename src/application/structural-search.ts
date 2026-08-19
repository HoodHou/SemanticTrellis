import type {
  StructuralBuildMetrics,
  StructuralSymbolSearchHit,
} from "../domain/structural.js";
import { loadGraph } from "../infrastructure/project-store.js";
import { searchStructuralSymbols } from "../structural/queries.js";
import { ensureStructuralIndex } from "./structure.js";

export interface StructuralSymbolSearchResult {
  query: string;
  hits: StructuralSymbolSearchHit[];
  build: StructuralBuildMetrics;
}

export async function searchProjectSymbols(
  root: string,
  query: string,
  limit = 20,
  refresh = false,
  repairStale = true,
): Promise<StructuralSymbolSearchResult> {
  const built = await ensureStructuralIndex(root, refresh, repairStale);
  const graph = await loadGraph(root);
  const curatedByPath = new Map<string, string[]>();
  for (const node of graph.nodes) {
    for (const source of node.sources) {
      const values = curatedByPath.get(source.path) ?? [];
      values.push(node.id);
      curatedByPath.set(source.path, values);
    }
  }
  return {
    query,
    hits: searchStructuralSymbols(built.index, query, limit, curatedByPath),
    build: built.metrics,
  };
}

import type {
  StructuralBuildMetrics,
  StructuralSymbolSearchHit,
} from "../domain/structural.js";
import { loadGraph } from "../infrastructure/project-store.js";
import { searchStructuralSymbols } from "../structural/queries.js";
import { ensureStructuralIndex } from "./structure.js";
import {
  getSymbolSourceContexts,
  type StructuralSymbolSource,
} from "./structural-query.js";

export interface StructuralSymbolSearchResult {
  query: string;
  hits: StructuralSymbolSearchHit[];
  build: StructuralBuildMetrics;
}

export interface StructuralAskOptions {
  limit?: number;
  refresh?: boolean;
  repairStale?: boolean;
  pathPrefix?: string | undefined;
  includeBody?: boolean;
  fullBody?: boolean;
  maxSourceCharacters?: number;
}

export interface StructuralAskResult extends StructuralSymbolSearchResult {
  sourceContexts: StructuralSymbolSource[];
}

function curatedSources(graph: Awaited<ReturnType<typeof loadGraph>>): Map<string, string[]> {
  const curatedByPath = new Map<string, string[]>();
  for (const node of graph.nodes) {
    for (const source of node.sources) {
      const values = curatedByPath.get(source.path) ?? [];
      values.push(node.id);
      curatedByPath.set(source.path, values);
    }
  }
  return curatedByPath;
}

export async function searchProjectSymbols(
  root: string,
  query: string,
  limit = 20,
  refresh = false,
  repairStale = true,
  pathPrefix: string | null = null,
): Promise<StructuralSymbolSearchResult> {
  const built = await ensureStructuralIndex(root, refresh, repairStale);
  const graph = await loadGraph(root);
  return {
    query,
    hits: searchStructuralSymbols(
      built.index,
      query,
      limit,
      curatedSources(graph),
      pathPrefix,
    ),
    build: built.metrics,
  };
}

export async function askProject(
  root: string,
  query: string,
  options: StructuralAskOptions = {},
): Promise<StructuralAskResult> {
  const built = await ensureStructuralIndex(
    root,
    options.refresh === true,
    options.repairStale !== false,
  );
  const graph = await loadGraph(root);
  const limit = Math.max(1, Math.floor(options.limit ?? 4));
  const candidates = searchStructuralSymbols(
    built.index,
    query,
    Math.min(200, limit * 3),
    curatedSources(graph),
    options.pathPrefix ?? null,
  );
  const specific = candidates.filter((hit) => hit.symbol.kind !== "file");
  const hits = (specific.length > 0 ? specific : candidates).slice(0, limit);
  const hashes = new Map(
    Object.values(built.index.contributions).map((contribution) => [
      contribution.path,
      contribution.hash,
    ]),
  );
  return {
    query,
    hits,
    sourceContexts: await getSymbolSourceContexts(
      root,
      hits.map((hit) => hit.symbol),
      {
        includeBody: options.includeBody !== false,
        maxSourceCharacters: options.maxSourceCharacters ??
          (options.fullBody === true ? 20_000 : 4_000),
        ...(options.fullBody === true ? {} : { maxLinesPerSymbol: 8 }),
        query,
        repairStale: options.repairStale !== false,
      },
      hashes,
    ),
    build: built.metrics,
  };
}

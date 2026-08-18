import type {
  StructuralBuildMetrics,
  StructuralSymbol,
  StructuralTrace,
  TraceDirection,
} from "../domain/structural.js";
import { symbolsForFile, traceStructuralGraph } from "../structural/queries.js";
import { loadOrBuildStructuralIndex } from "./structure.js";

export interface FileSymbolsResult {
  file: string;
  symbols: StructuralSymbol[];
  build: StructuralBuildMetrics;
}

export interface TraceResult {
  trace: StructuralTrace;
  build: StructuralBuildMetrics;
}

export async function getFileSymbols(
  root: string,
  file: string,
  refresh = true,
): Promise<FileSymbolsResult> {
  const built = await loadOrBuildStructuralIndex(root, refresh);
  return {
    file,
    symbols: symbolsForFile(built.index, file).sort(
      (left, right) => left.span.startLine - right.span.startLine,
    ),
    build: built.metrics,
  };
}

export async function traceProjectStructure(
  root: string,
  query: string,
  direction: TraceDirection = "incoming",
  depth = 1,
  refresh = true,
): Promise<TraceResult> {
  const built = await loadOrBuildStructuralIndex(root, refresh);
  return {
    trace: traceStructuralGraph(built.index, query, direction, depth),
    build: built.metrics,
  };
}

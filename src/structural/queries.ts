import { basename } from "node:path";
import type {
  StructuralEdge,
  StructuralIndex,
  StructuralSymbol,
  StructuralTrace,
  TraceDirection,
} from "../domain/structural.js";
import { symbolsById } from "./resolver.js";

function allSymbols(index: StructuralIndex): StructuralSymbol[] {
  return Object.values(index.contributions).flatMap((contribution) => contribution.symbols);
}

function traceEdges(
  edges: StructuralEdge[],
  frontier: Set<string>,
  direction: TraceDirection,
): StructuralEdge[] {
  return edges.filter((edge) => {
    if (direction === "incoming") return frontier.has(edge.to);
    if (direction === "outgoing") return frontier.has(edge.from);
    return frontier.has(edge.from) || frontier.has(edge.to);
  });
}

function adjacent(edge: StructuralEdge, frontier: Set<string>, direction: TraceDirection): string[] {
  if (direction === "incoming") return frontier.has(edge.to) ? [edge.from] : [];
  if (direction === "outgoing") return frontier.has(edge.from) ? [edge.to] : [];
  const values: string[] = [];
  if (frontier.has(edge.from)) values.push(edge.to);
  if (frontier.has(edge.to)) values.push(edge.from);
  return values;
}

export function resolveSymbolQuery(index: StructuralIndex, query: string): StructuralSymbol[] {
  const symbols = allSymbols(index);
  const byId = symbols.filter((symbol) => symbol.id === query);
  if (byId.length > 0) return byId;
  const byQualifiedName = symbols.filter((symbol) => symbol.qualifiedName === query);
  if (byQualifiedName.length > 0) return byQualifiedName;
  return symbols.filter((symbol) => symbol.name === query);
}

export function traceStructuralGraph(
  index: StructuralIndex,
  query: string,
  direction: TraceDirection = "incoming",
  depth = 1,
): StructuralTrace {
  const focus = resolveSymbolQuery(index, query);
  if (focus.length === 0) throw new Error(`No structural symbol matches ${query}.`);
  const safeDepth = Math.max(0, Math.floor(depth));
  const selected = new Set(focus.map((symbol) => symbol.id));
  const traversedEdgeIds = new Set<string>();
  let frontier = new Set(selected);

  for (let level = 0; level < safeDepth; level += 1) {
    const next = new Set<string>();
    for (const edge of traceEdges(index.edges, frontier, direction)) {
      traversedEdgeIds.add(edge.id);
      for (const symbolId of adjacent(edge, frontier, direction)) {
        if (!selected.has(symbolId)) {
          selected.add(symbolId);
          next.add(symbolId);
        }
      }
    }
    if (next.size === 0) break;
    frontier = next;
  }

  const byId = symbolsById(index);
  return {
    query,
    direction,
    depth: safeDepth,
    focus: [...focus].sort((left, right) => left.id.localeCompare(right.id)),
    symbols: [...selected]
      .map((id) => byId.get(id))
      .filter((symbol): symbol is StructuralSymbol => symbol !== undefined)
      .sort((left, right) => left.id.localeCompare(right.id)),
    edges: index.edges
      .filter((edge) => traversedEdgeIds.has(edge.id))
      .sort((left, right) => left.id.localeCompare(right.id)),
    ambiguous: focus.length > 1,
  };
}

export function symbolsForFile(index: StructuralIndex, fileQuery: string): StructuralSymbol[] {
  const normalized = fileQuery.replace(/\\/g, "/");
  const exact = index.contributions[normalized];
  if (exact !== undefined) return [...exact.symbols];

  const matches = Object.values(index.contributions).filter(
    (contribution) => basename(contribution.path) === basename(normalized),
  );
  if (matches.length === 0) throw new Error(`No indexed file matches ${fileQuery}.`);
  if (matches.length > 1) {
    throw new Error(
      `File name is ambiguous: ${matches.map((match) => match.path).sort().join(", ")}`,
    );
  }
  return [...(matches[0]?.symbols ?? [])];
}

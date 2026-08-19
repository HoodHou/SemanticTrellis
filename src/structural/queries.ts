import { basename } from "node:path";
import type {
  StructuralEdge,
  StructuralIndex,
  StructuralSymbol,
  StructuralSymbolSearchHit,
  StructuralSymbolSuggestion,
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

function normalizedWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean);
}

function suggestionScore(symbol: StructuralSymbol, query: string): number {
  const normalized = query.trim().toLowerCase();
  const name = symbol.name.toLowerCase();
  const qualifiedName = symbol.qualifiedName.toLowerCase();
  if (name === normalized || qualifiedName === normalized) return 100;
  if (name.startsWith(normalized)) return 70;
  if (qualifiedName.startsWith(normalized) || qualifiedName.endsWith(`.${normalized}`)) return 60;
  if (name.includes(normalized)) return 45;
  if (qualifiedName.includes(normalized)) return 35;
  const queryWords = normalizedWords(normalized);
  const symbolWords = new Set(normalizedWords(`${symbol.name} ${symbol.qualifiedName}`));
  return queryWords.reduce((score, word) => score + (symbolWords.has(word) ? 8 : 0), 0);
}

export function suggestStructuralSymbols(
  index: StructuralIndex,
  query: string,
  limit = 5,
): StructuralSymbolSuggestion[] {
  return allSymbols(index)
    .map((symbol) => ({ symbol, score: suggestionScore(symbol, query) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.symbol.id.localeCompare(right.symbol.id))
    .slice(0, Math.max(1, Math.floor(limit)));
}

export function searchStructuralSymbols(
  index: StructuralIndex,
  query: string,
  limit = 20,
  curatedByPath: ReadonlyMap<string, readonly string[]> = new Map(),
): StructuralSymbolSearchHit[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const terms = normalizedWords(normalized);
  const inDegree = new Map<string, number>();
  for (const edge of index.edges) inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  const hits: StructuralSymbolSearchHit[] = [];
  for (const symbol of allSymbols(index)) {
    const matchedFields = new Set<string>();
    const name = symbol.name.toLowerCase();
    const qualifiedName = symbol.qualifiedName.toLowerCase();
    const signature = symbol.signature.toLowerCase();
    const path = symbol.path.toLowerCase();
    let score = suggestionScore(symbol, normalized);
    if (score > 0) matchedFields.add(name.includes(normalized) ? "name" : "qualifiedName");
    for (const term of terms) {
      if (name.includes(term)) {
        score += 14;
        matchedFields.add("name");
      }
      if (qualifiedName.includes(term)) {
        score += 9;
        matchedFields.add("qualifiedName");
      }
      if (signature.includes(term)) {
        score += 5;
        matchedFields.add("signature");
      }
      if (path.includes(term)) {
        score += 3;
        matchedFields.add("path");
      }
    }
    const degree = inDegree.get(symbol.id) ?? 0;
    if (score > 0) score += Math.min(12, Math.log2(degree + 1) * 2);
    const curatedNodeIds = [...new Set(curatedByPath.get(symbol.path) ?? [])].sort();
    if (curatedNodeIds.length > 0 && score > 0) score += 6;
    if (score > 0) {
      hits.push({
        symbol,
        score: Number(score.toFixed(3)),
        matchedFields: [...matchedFields].sort(),
        inDegree: degree,
        curatedNodeIds,
      });
    }
  }
  return hits
    .sort((left, right) => right.score - left.score || left.symbol.id.localeCompare(right.symbol.id))
    .slice(0, Math.max(1, Math.floor(limit)));
}

export function traceStructuralGraph(
  index: StructuralIndex,
  query: string,
  direction: TraceDirection = "incoming",
  depth = 1,
): StructuralTrace {
  const focus = resolveSymbolQuery(index, query);
  const safeDepth = Math.max(0, Math.floor(depth));
  if (focus.length === 0) {
    return {
      query,
      direction,
      depth: safeDepth,
      found: false,
      focus: [],
      symbols: [],
      edges: [],
      ambiguous: false,
      suggestions: suggestStructuralSymbols(index, query),
    };
  }
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
    found: true,
    focus: [...focus].sort((left, right) => left.id.localeCompare(right.id)),
    symbols: [...selected]
      .map((id) => byId.get(id))
      .filter((symbol): symbol is StructuralSymbol => symbol !== undefined)
      .sort((left, right) => left.id.localeCompare(right.id)),
    edges: index.edges
      .filter((edge) => traversedEdgeIds.has(edge.id))
      .sort((left, right) => left.id.localeCompare(right.id)),
    ambiguous: focus.length > 1,
    suggestions: [],
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

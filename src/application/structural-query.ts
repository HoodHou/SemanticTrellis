import type {
  SourceContext,
  StructuralBuildMetrics,
  StructuralSymbol,
  StructuralTrace,
  TraceDirection,
} from "../domain/structural.js";
import { symbolsForFile, traceStructuralGraph } from "../structural/queries.js";
import { readVerifiedSource } from "../infrastructure/source-cache.js";
import { ensureStructuralIndex } from "./structure.js";

export interface StructuralSourceOptions {
  includeBody?: boolean;
  maxSourceCharacters?: number;
  maxLinesPerSymbol?: number | undefined;
  query?: string | undefined;
  repairStale?: boolean;
}

export interface StructuralSymbolSource {
  symbolId: string;
  path: string;
  context: SourceContext;
}

export interface FileSymbolsResult {
  file: string;
  symbols: StructuralSymbol[];
  sourceContexts: StructuralSymbolSource[];
  build: StructuralBuildMetrics;
}

export interface TraceResult {
  trace: StructuralTrace;
  sourceContexts: StructuralSymbolSource[];
  build: StructuralBuildMetrics;
}

function contextForSymbol(
  source: string,
  symbol: StructuralSymbol,
  remainingCharacters: number,
  maxLinesPerSymbol?: number,
  query?: string,
): { value: StructuralSymbolSource | null; used: number } {
  if (remainingCharacters <= 0) return { value: null, used: 0 };
  const lines = source.split(/\r?\n/);
  const symbolStartLine = Math.max(1, symbol.span.startLine);
  const symbolEndLine = Math.min(
    lines.length,
    Math.max(symbolStartLine, symbol.span.endLine),
  );
  let startLine = symbolStartLine;
  let endLine = symbolEndLine;
  const lineLimit = maxLinesPerSymbol === undefined
    ? null
    : Math.max(1, Math.min(200, Math.floor(maxLinesPerSymbol)));
  if (lineLimit !== null && symbolEndLine - symbolStartLine + 1 > lineLimit) {
    const rawQuery = query?.trim() ?? "";
    const normalizedQuery = rawQuery.toLowerCase();
    const terms = [...new Set(
      rawQuery
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^\p{L}\p{N}_]+/u)
        .filter((term) => term.length >= 3),
    )];
    let bestOffset = 0;
    let bestScore = 0;
    for (let offset = 0; offset <= symbolEndLine - symbolStartLine; offset += 1) {
      const text = (lines[symbolStartLine - 1 + offset] ?? "").toLowerCase();
      let score = normalizedQuery.length > 0 && text.includes(normalizedQuery) ? 1_000 : 0;
      for (const term of terms) {
        if (text.includes(term)) score += term.length;
      }
      if (score > bestScore) {
        bestScore = score;
        bestOffset = offset;
      }
    }
    const maximumStartOffset = symbolEndLine - symbolStartLine + 1 - lineLimit;
    const startOffset = Math.max(
      0,
      Math.min(maximumStartOffset, bestOffset - Math.floor(lineLimit / 2)),
    );
    startLine = symbolStartLine + startOffset;
    endLine = startLine + lineLimit - 1;
  }
  const complete = lines.slice(startLine - 1, endLine).join("\n");
  const text = complete.slice(0, remainingCharacters);
  return {
    value: {
      symbolId: symbol.id,
      path: symbol.path,
      context: {
        startLine,
        endLine,
        text,
        truncated:
          startLine !== symbolStartLine ||
          endLine !== symbolEndLine ||
          text.length < complete.length,
      },
    },
    used: text.length,
  };
}

export async function getSymbolSourceContexts(
  root: string,
  symbols: StructuralSymbol[],
  options: StructuralSourceOptions,
  hashes: ReadonlyMap<string, string>,
): Promise<StructuralSymbolSource[]> {
  if (options.includeBody !== true) return [];
  let remaining = Math.max(
    0,
    Math.min(200_000, Math.floor(options.maxSourceCharacters ?? 20_000)),
  );
  const sources = new Map<string, string>();
  const output: StructuralSymbolSource[] = [];
  for (const symbol of symbols) {
    if (remaining <= 0) break;
    let source = sources.get(symbol.path);
    if (source === undefined) {
      const hash = hashes.get(symbol.path);
      if (hash === undefined) continue;
      source = await readVerifiedSource(root, symbol.path, hash);
      sources.set(symbol.path, source);
    }
    const taken = contextForSymbol(
      source,
      symbol,
      remaining,
      options.maxLinesPerSymbol,
      options.query,
    );
    if (taken.value !== null) output.push(taken.value);
    remaining -= taken.used;
  }
  return output;
}

export async function getFileSymbols(
  root: string,
  file: string,
  refresh = false,
  options: StructuralSourceOptions = {},
): Promise<FileSymbolsResult> {
  const built = await ensureStructuralIndex(root, refresh, options.repairStale !== false);
  const symbols = symbolsForFile(built.index, file).sort(
    (left, right) => left.span.startLine - right.span.startLine,
  );
  const hashes = new Map(
    Object.values(built.index.contributions).map((contribution) => [contribution.path, contribution.hash]),
  );
  return {
    file,
    symbols,
    sourceContexts: await getSymbolSourceContexts(root, symbols, options, hashes),
    build: built.metrics,
  };
}

export async function traceProjectStructure(
  root: string,
  query: string,
  direction: TraceDirection = "incoming",
  depth = 1,
  refresh = false,
  options: StructuralSourceOptions = {},
): Promise<TraceResult> {
  const built = await ensureStructuralIndex(root, refresh, options.repairStale !== false);
  const trace = traceStructuralGraph(built.index, query, direction, depth);
  const hashes = new Map(
    Object.values(built.index.contributions).map((contribution) => [contribution.path, contribution.hash]),
  );
  return {
    trace,
    sourceContexts: await getSymbolSourceContexts(root, trace.symbols, options, hashes),
    build: built.metrics,
  };
}

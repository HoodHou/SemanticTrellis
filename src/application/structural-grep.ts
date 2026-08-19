import { performance } from "node:perf_hooks";
import type {
  SourceContext,
  StructuralBuildResult,
  StructuralGrepGroup,
  StructuralGrepResult,
  StructuralSymbol,
} from "../domain/structural.js";
import { loadGraph } from "../infrastructure/project-store.js";
import {
  readVerifiedSource,
  SourceHashMismatchError,
} from "../infrastructure/source-cache.js";
import { buildStructuralIndex, ensureStructuralIndex } from "./structure.js";

export interface StructuralGrepOptions {
  fixed?: boolean;
  ignoreCase?: boolean;
  pathPrefix?: string;
  limit?: number;
  refresh?: boolean;
  repairStale?: boolean;
  contextLines?: number;
  includeBody?: boolean;
  maxSourceCharacters?: number;
  maxHitsPerGroup?: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertSafeRegularExpression(pattern: string): void {
  if (pattern.length > 256) throw new Error("Regular expression exceeds the 256-character safety limit.");
  const nestedQuantifier = /\((?:[^()]|\\.)*[*+](?:[^()]|\\.)*\)\s*(?:[*+]|\{\d*,?\d*\})/;
  if (nestedQuantifier.test(pattern) || /(?:\.\*){2,}|(?:\.\+){2,}/.test(pattern)) {
    throw new Error(
      "Regular expression contains a potentially catastrophic nested quantifier. Use fixed search or simplify the pattern.",
    );
  }
}

function normalizePrefix(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return normalized || null;
}

function underPrefix(path: string, prefix: string | null): boolean {
  return prefix === null || path === prefix || path.startsWith(`${prefix}/`);
}

function containingSymbol(symbols: StructuralSymbol[], line: number): StructuralSymbol {
  const containing = symbols.filter(
    (symbol) => symbol.span.startLine <= line && symbol.span.endLine >= line,
  );
  containing.sort((left, right) => {
    if (left.kind === "file" && right.kind !== "file") return 1;
    if (right.kind === "file" && left.kind !== "file") return -1;
    const leftSize = left.span.endLine - left.span.startLine;
    const rightSize = right.span.endLine - right.span.startLine;
    return leftSize - rightSize || right.span.startLine - left.span.startLine;
  });
  const selected = containing[0] ?? symbols.find((symbol) => symbol.kind === "file");
  if (selected === undefined) throw new Error("Structural contribution has no file symbol.");
  return selected;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  transform: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      const value = values[index];
      if (value !== undefined) output[index] = await transform(value);
    }
  }));
  return output;
}

function takeContext(
  lines: string[],
  requestedStartLine: number,
  requestedEndLine: number,
  remainingCharacters: number,
): { context: SourceContext | undefined; used: number } {
  if (remainingCharacters <= 0) return { context: undefined, used: 0 };
  const startLine = Math.max(1, requestedStartLine);
  const endLine = Math.min(lines.length, Math.max(startLine, requestedEndLine));
  const complete = lines.slice(startLine - 1, endLine).join("\n");
  const text = complete.slice(0, remainingCharacters);
  return {
    context: {
      startLine,
      endLine,
      text,
      truncated: text.length < complete.length,
    },
    used: text.length,
  };
}

async function grepBuiltIndex(
  root: string,
  pattern: string,
  built: StructuralBuildResult,
  options: StructuralGrepOptions,
): Promise<StructuralGrepResult> {
  const queryStarted = performance.now();
  const fixed = options.fixed ?? true;
  const ignoreCase = options.ignoreCase ?? false;
  const prefix = normalizePrefix(options.pathPrefix);
  const limit = Math.max(1, Math.floor(options.limit ?? 2_000));
  const maxHitsPerGroup = Math.max(1, Math.min(limit, Math.floor(options.maxHitsPerGroup ?? 50)));
  const contextLines = Math.max(0, Math.min(20, Math.floor(options.contextLines ?? 0)));
  let expression: RegExp;
  try {
    if (!fixed) assertSafeRegularExpression(pattern);
    expression = new RegExp(fixed ? escapeRegExp(pattern) : pattern, ignoreCase ? "gi" : "g");
  } catch (error) {
    throw new Error(`Invalid or unsafe regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }

  const graph = await loadGraph(root);
  const curatedByPath = new Map<string, string[]>();
  for (const node of graph.nodes) {
    for (const source of node.sources) {
      const values = curatedByPath.get(source.path) ?? [];
      values.push(node.id);
      curatedByPath.set(source.path, values);
    }
  }
  const inDegree = new Map<string, number>();
  for (const edge of built.index.edges) {
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  const contributions = Object.values(built.index.contributions)
    .filter((contribution) => underPrefix(contribution.path, prefix))
    .sort((left, right) => left.path.localeCompare(right.path));
  const loaded = await mapWithConcurrency(contributions, 16, async (contribution) => ({
    contribution,
    source: await readVerifiedSource(root, contribution.path, contribution.hash),
  }));
  const linesByPath = new Map<string, string[]>();
  const groups = new Map<string, StructuralGrepGroup>();
  let totalHits = 0;
  let symbolAttributed = 0;
  let curatedAttributed = 0;

  for (const { contribution, source } of loaded) {
    const lines = source.split(/\r?\n/);
    linesByPath.set(contribution.path, lines);
    const curatedNodeIds = [...new Set(curatedByPath.get(contribution.path) ?? [])].sort();
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const text = lines[lineIndex] ?? "";
      expression.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = expression.exec(text)) !== null) {
        totalHits += 1;
        const symbol = containingSymbol(contribution.symbols, lineIndex + 1);
        if (symbol.kind !== "file") symbolAttributed += 1;
        if (curatedNodeIds.length > 0) curatedAttributed += 1;
        const existing = groups.get(symbol.id) ?? {
          path: contribution.path,
          symbolId: symbol.id,
          symbolName: symbol.name,
          symbolKind: symbol.kind,
          inDegree: inDegree.get(symbol.id) ?? 0,
          curatedNodeIds,
          totalHits: 0,
          truncatedHits: 0,
          hits: [],
        };
        existing.totalHits += 1;
        if (existing.hits.length < maxHitsPerGroup) {
          existing.hits.push({
            line: lineIndex + 1,
            column: match.index + 1,
            matchLength: match[0].length,
            text: text.trim(),
          });
        }
        groups.set(symbol.id, existing);
        if (match[0] === "") expression.lastIndex += 1;
      }
    }
  }

  const ranked = [...groups.values()].sort(
    (left, right) =>
      right.inDegree - left.inDegree ||
      right.totalHits - left.totalHits ||
      left.path.localeCompare(right.path),
  );
  const selectedGroups: StructuralGrepGroup[] = [];
  let remainingHits = limit;
  let remainingSourceCharacters = Math.max(
    0,
    Math.min(200_000, Math.floor(options.maxSourceCharacters ?? 20_000)),
  );
  for (const group of ranked) {
    if (remainingHits <= 0) break;
    const hits = group.hits.slice(0, remainingHits);
    remainingHits -= hits.length;
    const lines = linesByPath.get(group.path) ?? [];
    const output: StructuralGrepGroup = {
      ...group,
      hits,
      truncatedHits: group.totalHits - hits.length,
    };
    if (options.includeBody === true) {
      const symbol = built.index.contributions[group.path]?.symbols.find(
        (candidate) => candidate.id === group.symbolId,
      );
      if (symbol !== undefined) {
        const taken = takeContext(
          lines,
          symbol.span.startLine,
          symbol.span.endLine,
          remainingSourceCharacters,
        );
        output.sourceContext = taken.context;
        remainingSourceCharacters -= taken.used;
      }
    }
    if (contextLines > 0) {
      for (const hit of hits) {
        const taken = takeContext(
          lines,
          hit.line - contextLines,
          hit.line + contextLines,
          remainingSourceCharacters,
        );
        hit.context = taken.context;
        remainingSourceCharacters -= taken.used;
      }
    }
    selectedGroups.push(output);
  }
  const storedHits = selectedGroups.reduce((total, group) => total + group.hits.length, 0);
  return {
    pattern,
    filesSearched: contributions.length,
    totalHits,
    groups: selectedGroups,
    truncatedHits: Math.max(0, totalHits - storedHits),
    symbolAttributionRate: totalHits === 0 ? 0 : symbolAttributed / totalHits,
    curatedAttributionRate: totalHits === 0 ? 0 : curatedAttributed / totalHits,
    queryDurationMs: Number((performance.now() - queryStarted).toFixed(3)),
  };
}

function repairable(error: unknown): boolean {
  return error instanceof SourceHashMismatchError ||
    (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT");
}

export async function grepStructure(
  root: string,
  pattern: string,
  options: StructuralGrepOptions = {},
): Promise<StructuralGrepResult> {
  if (!pattern) throw new Error("Search pattern must not be empty.");
  let built = await ensureStructuralIndex(
    root,
    options.refresh === true,
    options.repairStale !== false,
  );
  try {
    return await grepBuiltIndex(root, pattern, built, options);
  } catch (error) {
    if (options.repairStale === false || !repairable(error)) throw error;
    built = await buildStructuralIndex(root);
    return grepBuiltIndex(root, pattern, built, { ...options, refresh: false, repairStale: false });
  }
}

import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  StructuralGrepGroup,
  StructuralGrepHit,
  StructuralGrepResult,
  StructuralSymbol,
} from "../domain/structural.js";
import { digestBytes } from "../infrastructure/digest.js";
import { loadGraph } from "../infrastructure/project-store.js";
import { loadOrBuildStructuralIndex } from "./structure.js";

export interface StructuralGrepOptions {
  fixed?: boolean;
  ignoreCase?: boolean;
  pathPrefix?: string;
  limit?: number;
  refresh?: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

export async function grepStructure(
  root: string,
  pattern: string,
  options: StructuralGrepOptions = {},
): Promise<StructuralGrepResult> {
  if (!pattern) throw new Error("Search pattern must not be empty.");
  const built = await loadOrBuildStructuralIndex(root, options.refresh !== false);
  const queryStarted = performance.now();
  const fixed = options.fixed ?? false;
  const ignoreCase = options.ignoreCase ?? false;
  const prefix = normalizePrefix(options.pathPrefix);
  const limit = Math.max(1, Math.floor(options.limit ?? 2_000));
  let expression: RegExp;
  try {
    expression = new RegExp(fixed ? escapeRegExp(pattern) : pattern, ignoreCase ? "gi" : "g");
  } catch (error) {
    throw new Error(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
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

  const groups = new Map<string, StructuralGrepGroup>();
  let filesSearched = 0;
  let totalHits = 0;
  let storedHits = 0;
  let symbolAttributed = 0;
  let curatedAttributed = 0;
  const contributions = Object.values(built.index.contributions)
    .filter((contribution) => underPrefix(contribution.path, prefix))
    .sort((left, right) => left.path.localeCompare(right.path));

  for (const contribution of contributions) {
    filesSearched += 1;
    const sourceBytes = await readFile(resolve(root, contribution.path));
    if (digestBytes(sourceBytes) !== contribution.hash) {
      throw new Error(
        `Structural index is stale for ${contribution.path}. Run \`strellis structure\` before querying.`,
      );
    }
    const source = sourceBytes.toString("utf8");
    const lines = source.split(/\r?\n/);
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
        if (storedHits < limit) {
          const hit: StructuralGrepHit = {
            line: lineIndex + 1,
            text: text.trim(),
          };
          const existing = groups.get(symbol.id) ?? {
            path: contribution.path,
            symbolId: symbol.id,
            symbolName: symbol.name,
            symbolKind: symbol.kind,
            inDegree: inDegree.get(symbol.id) ?? 0,
            curatedNodeIds,
            hits: [],
          };
          existing.hits.push(hit);
          groups.set(symbol.id, existing);
          storedHits += 1;
        }
        if (match[0] === "") expression.lastIndex += 1;
      }
    }
  }

  return {
    pattern,
    filesSearched,
    totalHits,
    groups: [...groups.values()].sort(
      (left, right) => right.inDegree - left.inDegree || left.path.localeCompare(right.path),
    ),
    truncatedHits: Math.max(0, totalHits - storedHits),
    symbolAttributionRate: totalHits === 0 ? 0 : symbolAttributed / totalHits,
    curatedAttributionRate: totalHits === 0 ? 0 : curatedAttributed / totalHits,
    queryDurationMs: Number((performance.now() - queryStarted).toFixed(3)),
  };
}

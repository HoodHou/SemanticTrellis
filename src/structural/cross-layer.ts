import { posix } from "node:path";
import type {
  FileContribution,
  StructuralReference,
  StructuralSymbol,
} from "../domain/structural.js";

const DOCUMENT_LANGUAGES = new Set(["markdown", "strellis-json"]);
const CATALOG_KINDS = new Set<StructuralSymbol["kind"]>([
  "heading",
  "sheet",
  "table",
  "module",
  "field",
  "variable",
]);
const STOP_NAMES = new Set([
  "content",
  "data",
  "field",
  "id",
  "item",
  "key",
  "name",
  "record",
  "records",
  "row",
  "rows",
  "schema",
  "sheet",
  "table",
  "type",
  "value",
]);

function addUnique(names: Map<string, Set<string>>, key: string, canonical: string): void {
  const values = names.get(key) ?? new Set<string>();
  values.add(canonical);
  names.set(key, values);
}

export function crossLayerFingerprint(
  contributions: Record<string, FileContribution>,
): string {
  const parts: string[] = [];
  for (const contribution of Object.values(contributions)) {
    if (!DOCUMENT_LANGUAGES.has(contribution.language)) continue;
    for (const symbol of contribution.symbols) {
      parts.push(`${symbol.kind}:${symbol.path}:${symbol.qualifiedName}`);
    }
  }
  parts.sort();
  return parts.join("\n");
}

function buildCatalog(contributions: Record<string, FileContribution>): Map<string, string> {
  const names = new Map<string, Set<string>>();
  for (const contribution of Object.values(contributions)) {
    if (!DOCUMENT_LANGUAGES.has(contribution.language)) continue;
    addUnique(names, contribution.path, contribution.path);
    for (const symbol of contribution.symbols) {
      if (!CATALOG_KINDS.has(symbol.kind)) continue;
      if (symbol.name.length < 3 || STOP_NAMES.has(symbol.name.toLowerCase())) continue;
      if (symbol.kind === "field" && symbol.name.length < 4) continue;
      addUnique(names, symbol.name, symbol.qualifiedName);
      if (symbol.qualifiedName !== symbol.name) {
        addUnique(names, symbol.qualifiedName, symbol.qualifiedName);
      }
    }
  }
  const catalog = new Map<string, string>();
  for (const [key, values] of names) {
    if (values.size === 1) {
      const canonical = [...values][0];
      if (canonical !== undefined) catalog.set(key, canonical);
    }
  }
  return catalog;
}

function catalogKey(raw: string, fromPath: string, catalog: Map<string, string>): string | null {
  const normalized = raw.replace(/\\/g, "/").trim();
  if (normalized.length < 3 || normalized.length > 240 || normalized.includes("${")) return null;
  const candidates = [normalized];
  if (normalized.startsWith("./") || normalized.startsWith("../")) {
    const hashIndex = normalized.indexOf("#");
    const pathPart = hashIndex >= 0 ? normalized.slice(0, hashIndex) : normalized;
    const anchor = hashIndex >= 0 ? normalized.slice(hashIndex) : "";
    const joined = posix.normalize(posix.join(posix.dirname(fromPath), pathPart));
    if (!joined.startsWith("../")) candidates.push(`${joined}${anchor}`);
  }
  for (const candidate of candidates) {
    const canonical = catalog.get(candidate);
    if (canonical !== undefined) return canonical;
  }
  return null;
}

function ownerAt(contribution: FileContribution, line: number): string {
  const containing = contribution.symbols.filter((symbol) =>
    symbol.kind !== "file" &&
    symbol.span.startLine <= line &&
    symbol.span.endLine >= line,
  );
  containing.sort((left, right) =>
    (left.span.endLine - left.span.startLine) - (right.span.endLine - right.span.startLine) ||
    left.id.localeCompare(right.id),
  );
  return containing[0]?.id ?? `${contribution.path}#file`;
}

function sameReferences(left: StructuralReference[], right: StructuralReference[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const before = left[index];
    const after = right[index];
    if (
      before === undefined ||
      after === undefined ||
      before.id !== after.id ||
      before.kind !== after.kind ||
      before.targetName !== after.targetName ||
      before.ownerSymbolId !== after.ownerSymbolId ||
      before.line !== after.line
    ) {
      return false;
    }
  }
  return true;
}

function appendLiterals(
  contribution: FileContribution,
  source: string,
  catalog: Map<string, string>,
): FileContribution {
  const kept = contribution.references.filter((reference) => reference.kind !== "references");
  const additions: StructuralReference[] = [];
  const seen = new Set<string>();
  const literal = /(["'`])((?:\\.|(?!\1).){1,240})\1/g;
  const lines = source.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    for (const match of line.matchAll(literal)) {
      const raw = (match[2] ?? "").replace(/\\(["'`\\])/g, "$1");
      const target = catalogKey(raw, contribution.path, catalog);
      if (target === null) continue;
      const owner = ownerAt(contribution, lineIndex + 1);
      const identity = `${owner}|${target}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      additions.push({
        id: `${owner}#ref:references:${target}:${additions.length}`,
        path: contribution.path,
        ownerSymbolId: owner,
        kind: "references",
        targetName: target,
        targetQualifier: null,
        argumentCount: null,
        line: lineIndex + 1,
        column: (match.index ?? 0) + 1,
      });
    }
  }
  return { ...contribution, references: [...kept, ...additions] };
}

export function attachCrossLayerReferences(
  contributions: Record<string, FileContribution>,
  sources: ReadonlyMap<string, string>,
): { contributions: Record<string, FileContribution>; changedPaths: string[] } {
  const catalog = buildCatalog(contributions);
  const next: Record<string, FileContribution> = { ...contributions };
  const changedPaths: string[] = [];
  for (const [path, source] of sources) {
    const contribution = contributions[path];
    if (contribution === undefined || DOCUMENT_LANGUAGES.has(contribution.language)) continue;
    const updated = appendLiterals(contribution, source, catalog);
    if (sameReferences(contribution.references, updated.references)) continue;
    next[path] = updated;
    changedPaths.push(path);
  }
  changedPaths.sort();
  return { contributions: next, changedPaths };
}

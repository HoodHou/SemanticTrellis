import { dirname, posix } from "node:path";
import type {
  FileContribution,
  StructuralEdge,
  StructuralIndex,
  StructuralReference,
  StructuralSymbol,
} from "../domain/structural.js";

const CALL_TARGET_KINDS = new Set<StructuralSymbol["kind"]>([
  "method",
  "function",
  "operator",
  "delegate",
]);
const CONSTRUCT_TARGET_KINDS = new Set<StructuralSymbol["kind"]>([
  "class",
  "struct",
  "record",
  "delegate",
]);
const TYPE_TARGET_KINDS = new Set<StructuralSymbol["kind"]>([
  "class",
  "interface",
  "struct",
  "record",
  "type",
]);
const IMPORT_TARGET_KINDS = new Set<StructuralSymbol["kind"]>([
  "file",
  "module",
  "class",
  "interface",
  "struct",
  "record",
  "enum",
  "delegate",
]);

function add(map: Map<string, StructuralSymbol[]>, key: string, symbol: StructuralSymbol): void {
  const values = map.get(key) ?? [];
  values.push(symbol);
  map.set(key, values);
}

function validTarget(reference: StructuralReference, symbol: StructuralSymbol): boolean {
  switch (reference.kind) {
    case "call":
      return CALL_TARGET_KINDS.has(symbol.kind);
    case "construct":
      return CONSTRUCT_TARGET_KINDS.has(symbol.kind);
    case "extends":
    case "implements":
      return TYPE_TARGET_KINDS.has(symbol.kind);
    case "import":
      return IMPORT_TARGET_KINDS.has(symbol.kind);
  }
}

function unique(reference: StructuralReference, values: StructuralSymbol[]): StructuralSymbol | null {
  const allowed = values.filter((symbol) => validTarget(reference, symbol));
  return allowed.length === 1 ? allowed[0] ?? null : null;
}

function qualifierSuffixes(qualifiedName: string): string[] {
  const parts = qualifiedName.split(".");
  const values: string[] = [];
  for (let index = 0; index < parts.length - 1; index += 1) {
    values.push(parts.slice(index).join("."));
  }
  return values;
}

function scopedTarget(
  reference: StructuralReference,
  byId: Map<string, StructuralSymbol>,
  byQualifiedName: Map<string, StructuralSymbol[]>,
): StructuralSymbol | null {
  let scope = byId.get(reference.ownerSymbolId);
  while (scope !== undefined) {
    const target = unique(
      reference,
      byQualifiedName.get(`${scope.qualifiedName}.${reference.targetName}`) ?? [],
    );
    if (target !== null) return target;
    scope = scope.parentId === null ? undefined : byId.get(scope.parentId);
  }
  return null;
}

function moduleCandidates(sourcePath: string, target: string): string[] {
  if (!target.startsWith(".")) return [];
  const base = posix.normalize(posix.join(dirname(sourcePath).replace(/\\/g, "/"), target));
  const withoutRuntimeExtension = base.replace(/\.(?:js|mjs|cjs)$/, "");
  return [
    base,
    withoutRuntimeExtension,
    `${withoutRuntimeExtension}.ts`,
    `${withoutRuntimeExtension}.tsx`,
    `${withoutRuntimeExtension}.js`,
    `${withoutRuntimeExtension}.jsx`,
    `${withoutRuntimeExtension}/index.ts`,
    `${withoutRuntimeExtension}/index.tsx`,
  ];
}

function resolveImport(
  reference: StructuralReference,
  contributions: Record<string, FileContribution>,
): StructuralSymbol | null {
  for (const candidate of moduleCandidates(reference.path, reference.targetName)) {
    const contribution = contributions[candidate];
    const file = contribution?.symbols.find((symbol) => symbol.kind === "file");
    if (file !== undefined) return file;
  }
  return null;
}

export function resolveStructuralEdges(
  contributions: Record<string, FileContribution>,
): StructuralEdge[] {
  const byName = new Map<string, StructuralSymbol[]>();
  const byQualifiedName = new Map<string, StructuralSymbol[]>();
  const byQualifiedSuffix = new Map<string, StructuralSymbol[]>();
  const byId = new Map<string, StructuralSymbol>();
  for (const contribution of Object.values(contributions)) {
    for (const symbol of contribution.symbols) {
      byId.set(symbol.id, symbol);
      if (symbol.kind === "file") continue;
      add(byName, symbol.name, symbol);
      add(byQualifiedName, symbol.qualifiedName, symbol);
      for (const suffix of qualifierSuffixes(symbol.qualifiedName)) {
        add(byQualifiedSuffix, suffix, symbol);
      }
    }
  }

  const edges = new Map<string, StructuralEdge>();
  for (const contribution of Object.values(contributions)) {
    for (const reference of contribution.references) {
      let target: StructuralSymbol | null = null;
      if (reference.kind === "import") {
        target = resolveImport(reference, contributions);
      }
      if (target === null && reference.targetQualifier !== null) {
        target = unique(reference, byQualifiedName.get(reference.targetQualifier) ?? []) ??
          unique(reference, byQualifiedSuffix.get(reference.targetQualifier) ?? []);
      }
      const qualifier = reference.targetQualifier;
      const explicitlyScoped = qualifier?.startsWith("this.") === true ||
        qualifier?.startsWith("base.") === true;
      const hasUnknownReceiver = qualifier !== null &&
        qualifier !== reference.targetName &&
        qualifier.includes(".") &&
        !explicitlyScoped;
      if (target === null && !hasUnknownReceiver) {
        target = scopedTarget(reference, byId, byQualifiedName);
      }
      if (target === null && !hasUnknownReceiver) {
        target = unique(reference, byName.get(reference.targetName) ?? []);
      }
      if (target === null) continue;
      const id = `${reference.ownerSymbolId}|${reference.kind}|${target.id}|${reference.id}`;
      edges.set(id, {
        id,
        from: reference.ownerSymbolId,
        to: target.id,
        kind: reference.kind,
        referenceId: reference.id,
      });
    }
  }
  return [...edges.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function symbolsById(index: StructuralIndex): Map<string, StructuralSymbol> {
  return new Map(
    Object.values(index.contributions)
      .flatMap((contribution) => contribution.symbols)
      .map((symbol) => [symbol.id, symbol]),
  );
}

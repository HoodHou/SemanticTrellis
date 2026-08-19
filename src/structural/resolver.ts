import { dirname, posix } from "node:path";
import type {
  FileContribution,
  StructuralEdge,
  StructuralIndex,
  StructuralReference,
  StructuralResolutionMetrics,
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

function acceptsArguments(reference: StructuralReference, symbol: StructuralSymbol): boolean {
  if (reference.argumentCount === null || symbol.callArity === null) return true;
  return reference.argumentCount >= symbol.callArity.min &&
    (symbol.callArity.max === null || reference.argumentCount <= symbol.callArity.max);
}

interface Selection {
  target: StructuralSymbol | null;
  ambiguous: boolean;
}

function selectUnique(reference: StructuralReference, values: StructuralSymbol[]): Selection {
  const allowed = values.filter(
    (symbol) => validTarget(reference, symbol) && acceptsArguments(reference, symbol),
  );
  if (allowed.length > 1 && allowed.every((symbol) => symbol.partial)) {
    const identities = new Set(
      allowed.map((symbol) => `${symbol.kind}:${symbol.qualifiedName}`),
    );
    if (identities.size === 1) {
      return {
        target: [...allowed].sort((left, right) => left.id.localeCompare(right.id))[0] ?? null,
        ambiguous: false,
      };
    }
  }
  return {
    target: allowed.length === 1 ? allowed[0] ?? null : null,
    ambiguous: allowed.length > 1,
  };
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
): Selection {
  let scope = byId.get(reference.ownerSymbolId);
  let ambiguous = false;
  while (scope !== undefined) {
    const selected = selectUnique(
      reference,
      byQualifiedName.get(`${scope.qualifiedName}.${reference.targetName}`) ?? [],
    );
    if (selected.target !== null) return { target: selected.target, ambiguous: false };
    ambiguous ||= selected.ambiguous;
    scope = scope.parentId === null ? undefined : byId.get(scope.parentId);
  }
  return { target: null, ambiguous };
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

export interface StructuralResolutionResult {
  edges: StructuralEdge[];
  metrics: StructuralResolutionMetrics;
  metricsByFile: Record<string, StructuralResolutionMetrics>;
}

export function resolveStructuralGraph(
  contributions: Record<string, FileContribution>,
  paths?: ReadonlySet<string>,
): StructuralResolutionResult {
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
  const metricsByFile: Record<string, StructuralResolutionMetrics> = {};
  for (const contribution of Object.values(contributions)) {
    if (paths !== undefined && !paths.has(contribution.path)) continue;
    const fileMetrics: StructuralResolutionMetrics = {
      resolvedReferences: 0,
      unresolvedReferences: 0,
      ambiguousReferences: 0,
      unknownReceiverReferences: 0,
    };
    for (const reference of contribution.references) {
      let target: StructuralSymbol | null = null;
      let ambiguous = false;
      if (reference.kind === "import") {
        target = resolveImport(reference, contributions);
      }
      if (target === null && reference.targetQualifier !== null) {
        const exact = selectUnique(
          reference,
          byQualifiedName.get(reference.targetQualifier) ?? [],
        );
        const suffix = exact.target === null
          ? selectUnique(reference, byQualifiedSuffix.get(reference.targetQualifier) ?? [])
          : { target: null, ambiguous: false };
        target = exact.target ?? suffix.target;
        ambiguous ||= exact.ambiguous || suffix.ambiguous;
      }
      const qualifier = reference.targetQualifier;
      const explicitlyScoped = qualifier?.startsWith("this.") === true ||
        qualifier?.startsWith("base.") === true;
      const hasUnknownReceiver = qualifier !== null &&
        qualifier !== reference.targetName &&
        qualifier.includes(".") &&
        !explicitlyScoped;
      if (target === null && !hasUnknownReceiver) {
        const scoped = scopedTarget(reference, byId, byQualifiedName);
        target = scoped.target;
        ambiguous ||= scoped.ambiguous;
      }
      if (target === null && !hasUnknownReceiver) {
        const named = selectUnique(reference, byName.get(reference.targetName) ?? []);
        target = named.target;
        ambiguous ||= named.ambiguous;
      }
      if (target === null) {
        if (ambiguous) fileMetrics.ambiguousReferences += 1;
        else fileMetrics.unresolvedReferences += 1;
        if (hasUnknownReceiver) fileMetrics.unknownReceiverReferences += 1;
        continue;
      }
      fileMetrics.resolvedReferences += 1;
      const id = `${reference.ownerSymbolId}|${reference.kind}|${target.id}|${reference.id}`;
      edges.set(id, {
        id,
        from: reference.ownerSymbolId,
        to: target.id,
        kind: reference.kind,
        referenceId: reference.id,
      });
    }
    metricsByFile[contribution.path] = fileMetrics;
  }
  const metrics = Object.values(metricsByFile).reduce<StructuralResolutionMetrics>(
    (total, value) => ({
      resolvedReferences: total.resolvedReferences + value.resolvedReferences,
      unresolvedReferences: total.unresolvedReferences + value.unresolvedReferences,
      ambiguousReferences: total.ambiguousReferences + value.ambiguousReferences,
      unknownReceiverReferences:
        total.unknownReceiverReferences + value.unknownReceiverReferences,
    }),
    {
      resolvedReferences: 0,
      unresolvedReferences: 0,
      ambiguousReferences: 0,
      unknownReceiverReferences: 0,
    },
  );
  return {
    edges: [...edges.values()].sort((left, right) => left.id.localeCompare(right.id)),
    metrics,
    metricsByFile,
  };
}

export function resolveStructuralEdges(
  contributions: Record<string, FileContribution>,
): StructuralEdge[] {
  return resolveStructuralGraph(contributions).edges;
}

export function symbolsById(index: StructuralIndex): Map<string, StructuralSymbol> {
  return new Map(
    Object.values(index.contributions)
      .flatMap((contribution) => contribution.symbols)
      .map((symbol) => [symbol.id, symbol]),
  );
}

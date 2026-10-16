import {
  SCHEMA_VERSION,
  type CuratedGraph,
  type FileChange,
  type GraphPatch,
  type GraphPatchOperation,
  type RepositorySnapshot,
  type ReviewItem,
  type ReviewQueue,
  type ReviewReason,
  type ReviewReferenceChange,
  type ReviewStructuralDelta,
  type ReviewSymbolChange,
  type SemanticNode,
  type StructuralReviewNature,
} from "./model.js";
import type {
  FileContribution,
  StructuralEdge,
  StructuralIndex,
  StructuralSymbol,
} from "./structural.js";

const DELTA_LIMIT = 40;
const IGNORED_SYMBOL_KINDS = new Set<StructuralSymbol["kind"]>(["file", "callback"]);

function relatedNodes(graph: CuratedGraph, path: string): string[] {
  return graph.nodes
    .filter((node) => node.sources.some((source) => source.path === path))
    .map((node) => node.id)
    .sort();
}

function reviewId(change: FileChange): string {
  const identity = change.after?.hash ?? change.before?.hash ?? "missing";
  return `${change.kind}:${change.path}:${identity}`;
}

function reasonFor(change: FileChange): ReviewReason {
  switch (change.kind) {
    case "added":
      return "source-added";
    case "changed":
      return "source-changed";
    case "removed":
      return "source-removed";
  }
}

function emptyDelta(
  nature: StructuralReviewNature,
  movedFrom: string | null = null,
  movedTo: string | null = null,
): ReviewStructuralDelta {
  return {
    nature,
    movedFrom,
    movedTo,
    symbolChanges: [],
    referenceChanges: [],
  };
}

function symbolsById(index: StructuralIndex | null): Map<string, StructuralSymbol> {
  const byId = new Map<string, StructuralSymbol>();
  for (const contribution of Object.values(index?.contributions ?? {})) {
    for (const symbol of contribution.symbols) byId.set(symbol.id, symbol);
  }
  return byId;
}

function comparableSymbols(contribution: FileContribution | undefined): StructuralSymbol[] {
  return (contribution?.symbols ?? []).filter((symbol) => !IGNORED_SYMBOL_KINDS.has(symbol.kind));
}

function signatureIdentity(symbol: StructuralSymbol): string {
  const arity = symbol.callArity === null
    ? ""
    : `${symbol.callArity.min}:${symbol.callArity.max ?? "*"}`;
  return `${symbol.signature}\u0000${arity}`;
}

function symbolKey(symbol: StructuralSymbol): string {
  return `${symbol.kind}:${symbol.qualifiedName}`;
}

function symbolChangesBetween(
  before: FileContribution | undefined,
  after: FileContribution | undefined,
): ReviewSymbolChange[] {
  const beforeGroups = new Map<string, StructuralSymbol[]>();
  const afterGroups = new Map<string, StructuralSymbol[]>();
  for (const symbol of comparableSymbols(before)) {
    const values = beforeGroups.get(symbolKey(symbol)) ?? [];
    values.push(symbol);
    beforeGroups.set(symbolKey(symbol), values);
  }
  for (const symbol of comparableSymbols(after)) {
    const values = afterGroups.get(symbolKey(symbol)) ?? [];
    values.push(symbol);
    afterGroups.set(symbolKey(symbol), values);
  }
  const changes: ReviewSymbolChange[] = [];
  const keys = [...new Set([...beforeGroups.keys(), ...afterGroups.keys()])].sort();
  for (const key of keys) {
    const left = [...(beforeGroups.get(key) ?? [])].sort((a, b) =>
      signatureIdentity(a).localeCompare(signatureIdentity(b)),
    );
    const right = [...(afterGroups.get(key) ?? [])].sort((a, b) =>
      signatureIdentity(a).localeCompare(signatureIdentity(b)),
    );
    const count = Math.max(left.length, right.length);
    for (let index = 0; index < count; index += 1) {
      const previousSymbol = left[index];
      const nextSymbol = right[index];
      if (previousSymbol !== undefined && nextSymbol !== undefined) {
        if (signatureIdentity(previousSymbol) === signatureIdentity(nextSymbol)) continue;
        changes.push({
          change: "signature-changed",
          name: nextSymbol.name,
          qualifiedName: nextSymbol.qualifiedName,
          kind: nextSymbol.kind,
          beforeSignature: previousSymbol.signature,
          afterSignature: nextSymbol.signature,
        });
      } else if (nextSymbol !== undefined) {
        changes.push({
          change: "added",
          name: nextSymbol.name,
          qualifiedName: nextSymbol.qualifiedName,
          kind: nextSymbol.kind,
          beforeSignature: null,
          afterSignature: nextSymbol.signature,
        });
      } else if (previousSymbol !== undefined) {
        changes.push({
          change: "removed",
          name: previousSymbol.name,
          qualifiedName: previousSymbol.qualifiedName,
          kind: previousSymbol.kind,
          beforeSignature: previousSymbol.signature,
          afterSignature: null,
        });
      }
    }
  }
  return changes.slice(0, DELTA_LIMIT);
}

interface CrossReferenceRecord {
  kind: string;
  ownerQualifiedName: string;
  targetName: string;
  targetPath: string | null;
}

function crossReferenceRecords(
  index: StructuralIndex | null,
  path: string,
): Map<string, CrossReferenceRecord> {
  const records = new Map<string, CrossReferenceRecord>();
  if (index === null) return records;
  const byId = symbolsById(index);
  for (const edge of index.edges) {
    const described = crossReferenceRecord(edge, byId, path);
    if (described === null) continue;
    const record = described.value;
    const key = `${described.kind}|${record.kind}|${record.ownerQualifiedName}|${record.targetName}|${record.targetPath ?? ""}`;
    records.set(key, record);
  }
  return records;
}

function crossReferenceRecord(
  edge: StructuralEdge,
  byId: Map<string, StructuralSymbol>,
  path: string,
): { kind: string; value: CrossReferenceRecord } | null {
  const from = byId.get(edge.from);
  const to = byId.get(edge.to);
  if (from === undefined || to === undefined || from.path === to.path) return null;
  if (from.path !== path && to.path !== path) return null;
  if (from.path === path) {
    return {
      kind: "out",
      value: {
        kind: `out:${edge.kind}`,
        ownerQualifiedName: from.qualifiedName,
        targetName: to.qualifiedName,
        targetPath: to.path,
      },
    };
  }
  return {
    kind: "in",
    value: {
      kind: `in:${edge.kind}`,
      ownerQualifiedName: from.qualifiedName,
      targetName: to.qualifiedName,
      targetPath: from.path,
    },
  };
}

function referenceChangesBetween(
  previous: StructuralIndex | null,
  next: StructuralIndex | null,
  path: string,
): ReviewReferenceChange[] {
  const before = crossReferenceRecords(previous, path);
  const after = crossReferenceRecords(next, path);
  const changes: ReviewReferenceChange[] = [];
  for (const [key, record] of after) {
    if (before.has(key)) continue;
    changes.push({ change: "added", ...record });
  }
  for (const [key, record] of before) {
    if (after.has(key)) continue;
    changes.push({ change: "removed", ...record });
  }
  return changes
    .sort((left, right) =>
      left.change.localeCompare(right.change) ||
      left.ownerQualifiedName.localeCompare(right.ownerQualifiedName) ||
      left.targetName.localeCompare(right.targetName) ||
      (left.targetPath ?? "").localeCompare(right.targetPath ?? ""),
    )
    .slice(0, DELTA_LIMIT);
}

function movePairs(changes: FileChange[]): Map<string, { from: string; to: string }> {
  const removedByHash = new Map<string, string[]>();
  const addedByHash = new Map<string, string[]>();
  for (const change of changes) {
    if (change.kind === "removed" && change.before !== null) {
      const paths = removedByHash.get(change.before.hash) ?? [];
      paths.push(change.path);
      removedByHash.set(change.before.hash, paths);
    }
    if (change.kind === "added" && change.after !== null) {
      const paths = addedByHash.get(change.after.hash) ?? [];
      paths.push(change.path);
      addedByHash.set(change.after.hash, paths);
    }
  }
  const pairs = new Map<string, { from: string; to: string }>();
  for (const [hash, removed] of removedByHash) {
    const added = addedByHash.get(hash) ?? [];
    if (removed.length !== 1 || added.length !== 1) continue;
    const from = removed[0];
    const to = added[0];
    if (from === undefined || to === undefined || from === to) continue;
    const pair = { from, to };
    pairs.set(from, pair);
    pairs.set(to, pair);
  }
  return pairs;
}

function classifyChange(
  change: FileChange,
  previous: StructuralIndex | null,
  next: StructuralIndex | null,
  move: { from: string; to: string } | undefined,
): ReviewStructuralDelta {
  if (move !== undefined) return emptyDelta("file-moved", move.from, move.to);
  if (change.kind === "added") {
    return {
      ...emptyDelta("source-added"),
      symbolChanges: symbolChangesBetween(undefined, next?.contributions[change.path]),
    };
  }
  if (change.kind === "removed") {
    return {
      ...emptyDelta("source-removed"),
      symbolChanges: symbolChangesBetween(previous?.contributions[change.path], undefined),
    };
  }
  const before = previous?.contributions[change.path];
  const after = next?.contributions[change.path];
  if (before === undefined || after === undefined) return emptyDelta("symbol-signature-changed");
  const symbolChanges = symbolChangesBetween(before, after);
  const referenceChanges = referenceChangesBetween(previous, next, change.path);
  let nature: StructuralReviewNature = "implementation-only";
  if (symbolChanges.length > 0) nature = "symbol-signature-changed";
  else if (referenceChanges.length > 0) nature = "cross-node-reference-changed";
  return { nature, movedFrom: null, movedTo: null, symbolChanges, referenceChanges };
}

export function createInitialReviewQueue(
  snapshot: RepositorySnapshot,
  graph: CuratedGraph,
): ReviewQueue {
  const items: ReviewItem[] = snapshot.files.map((file) => ({
    id: `bootstrap:${file.path}:${file.hash}`,
    path: file.path,
    changeKind: "added",
    reason: "initial-classification",
    beforeHash: null,
    afterHash: file.hash,
    relatedNodeIds: relatedNodes(graph, file.path),
    structuralDelta: null,
  }));

  return { schemaVersion: SCHEMA_VERSION, items };
}

export function createReviewItems(
  changes: FileChange[],
  graph: CuratedGraph,
  previous: StructuralIndex | null = null,
  next: StructuralIndex | null = null,
): ReviewItem[] {
  const pairs = movePairs(changes);
  return changes.map((change) => ({
    id: reviewId(change),
    path: change.path,
    changeKind: change.kind,
    reason: reasonFor(change),
    beforeHash: change.before?.hash ?? null,
    afterHash: change.after?.hash ?? null,
    relatedNodeIds: relatedNodes(graph, change.path),
    structuralDelta: classifyChange(change, previous, next, pairs.get(change.path)),
  }));
}

export function mergeReviewQueue(
  current: ReviewQueue,
  incoming: ReviewItem[],
): ReviewQueue {
  const changedPaths = new Set(incoming.map((item) => item.path));
  const retained = current.items.filter((item) => !changedPaths.has(item.path));
  return {
    schemaVersion: SCHEMA_VERSION,
    items: [...retained, ...incoming].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  };
}

export function markReviewed(queue: ReviewQueue, paths: string[]): ReviewQueue {
  const reviewed = new Set(paths);
  return {
    schemaVersion: SCHEMA_VERSION,
    items: queue.items.filter((item) => !reviewed.has(item.path)),
  };
}

function withMovedSource(node: SemanticNode, from: string, to: string): SemanticNode {
  return {
    ...node,
    sources: node.sources.map((source) =>
      source.path === from ? { ...source, path: to } : source,
    ),
  };
}

export function reviewCandidatePatch(
  items: ReviewItem[],
  graph: CuratedGraph,
): GraphPatch | null {
  const operations: GraphPatchOperation[] = [];
  const rewritten = new Map<string, SemanticNode>();
  const reviewed = new Set<string>();

  for (const item of items) {
    const delta = item.structuralDelta;
    if (delta?.nature !== "file-moved" || delta.movedFrom === null || delta.movedTo === null) continue;
    for (const node of graph.nodes) {
      const current = rewritten.get(node.id) ?? node;
      if (!current.sources.some((source) => source.path === delta.movedFrom)) continue;
      rewritten.set(node.id, withMovedSource(current, delta.movedFrom, delta.movedTo));
    }
    reviewed.add(delta.movedFrom);
    reviewed.add(delta.movedTo);
  }

  for (const node of [...rewritten.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    operations.push({
      op: "upsert-node",
      node,
      ...(node.locked ? { overrideLocked: true } : {}),
    });
  }

  for (const item of items) {
    if (item.structuralDelta?.nature === "implementation-only") reviewed.add(item.path);
  }
  if (reviewed.size > 0) {
    operations.push({ op: "mark-reviewed", paths: [...reviewed].sort() });
  }
  if (operations.length === 0) return null;
  return { schemaVersion: SCHEMA_VERSION, operations };
}

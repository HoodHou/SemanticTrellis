import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  AGENT_BOOTSTRAP_SCHEMA_VERSION,
  agentBootstrapStatus,
  applyChunkSummarySubmissions,
  applyFileSummarySubmissions,
  completeAgentBootstrap,
  type AgentBootstrapSession,
  type AgentBootstrapStatus,
  type BootstrapUnit,
  type ChunkSummarySubmission,
  type FileSemanticSummary,
} from "../domain/agent-bootstrap.js";
import { auditGraph } from "../domain/graph.js";
import { digestBytes, digestJson } from "../infrastructure/digest.js";
import { loadAgentBootstrapSession, saveAgentBootstrapSession } from "../infrastructure/agent-bootstrap-store.js";
import { loadConfig, loadGraph, loadSnapshot } from "../infrastructure/project-store.js";
import { scanRepositoryDetailed } from "../infrastructure/repository-scanner.js";
import { loadStructuralIndex } from "../infrastructure/structural-store.js";
import { buildStructuralIndex } from "./structure.js";
import { bootstrapProject } from "./bootstrap.js";
import { syncProject } from "./sync.js";

export interface AgentBootstrapStartOptions {
  sourceDisclosureApproved: boolean;
  maxChunkCharacters?: number;
}

export interface AgentBootstrapStartResult {
  status: AgentBootstrapStatus;
  structural: {
    parsedFiles: number;
    reusedFiles: number;
    resolvedFiles: number;
    symbols: number;
    references: number;
    diagnostics: number;
    diagnosticFiles: number;
    edges: number;
    resolvedReferences: number;
    unresolvedReferences: number;
    ambiguousReferences: number;
    unknownReceiverReferences: number;
  };
}

export interface AgentBootstrapPreview {
  discoveryMode: "git" | "filesystem";
  totalFiles: number;
  totalBytes: number;
  extensions: Record<string, number>;
  suspiciousPaths: string[];
  largestFiles: Array<{ path: string; size: number }>;
}

export interface BootstrapSourceUnit {
  id: string;
  path: string;
  hash: string;
  chunkIndex: number;
  chunkCount: number;
  startLine: number;
  endLine: number;
  content: string;
}

export interface BootstrapSourceBatch {
  sessionId: string;
  stage: AgentBootstrapStatus["stage"];
  pendingChunks: number;
  returnedCharacters: number;
  units: BootstrapSourceUnit[];
}

export interface BootstrapFileRollup {
  path: string;
  hash: string;
  chunks: Array<{
    startLine: number;
    endLine: number;
    summary: string;
    keyFacts: string[];
    risks: string[];
    confidence: number;
  }>;
  structural: {
    symbols: Array<{
      kind: string;
      qualifiedName: string;
      signature: string;
      startLine: number;
      endLine: number;
    }>;
    references: Array<{
      kind: string;
      targetName: string;
      line: number;
      ownerSymbolId: string;
    }>;
    diagnostics: Array<{
      code: string;
      message: string;
      line: number;
      column: number;
    }>;
  };
}

export interface BootstrapRollupBatch {
  sessionId: string;
  pendingFiles: number;
  files: BootstrapFileRollup[];
}

export interface BootstrapCurationContext {
  sessionId: string;
  total: number;
  offset: number;
  nextOffset: number | null;
  summaries: FileSemanticSummary[];
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.max(1, low);
}

function chunkSource(
  path: string,
  hash: string,
  source: string,
  maxChunkCharacters: number,
): BootstrapUnit[] {
  const ranges: Array<{ start: number; end: number }> = [];
  if (source.length === 0) ranges.push({ start: 0, end: 0 });
  for (let start = 0; start < source.length;) {
    const idealEnd = Math.min(source.length, start + maxChunkCharacters);
    let end = idealEnd;
    if (idealEnd < source.length) {
      const newline = source.lastIndexOf("\n", idealEnd);
      if (newline > start + Math.floor(maxChunkCharacters / 2)) end = newline + 1;
    }
    if (end <= start) end = idealEnd;
    ranges.push({ start, end });
    start = end;
  }
  const starts = lineStarts(source);
  return ranges.map((range, index) => ({
    id: digestJson({ path, hash, startOffset: range.start, endOffset: range.end }),
    path,
    hash,
    chunkIndex: index,
    chunkCount: ranges.length,
    startOffset: range.start,
    endOffset: range.end,
    startLine: lineAt(starts, range.start),
    endLine: lineAt(starts, Math.max(range.start, range.end - 1)),
    charCount: range.end - range.start,
    summary: null,
  }));
}

async function readFrozenSource(root: string, path: string, expectedHash: string): Promise<string> {
  const bytes = await readFile(resolve(root, path));
  const actualHash = digestBytes(bytes);
  if (actualHash !== expectedHash) {
    throw new Error(
      `Source changed after the bootstrap snapshot: ${path}. Start or resume bootstrap again.`,
    );
  }
  return bytes.toString("utf8");
}

async function requireSession(root: string): Promise<AgentBootstrapSession> {
  const session = await loadAgentBootstrapSession(root);
  if (session === null) throw new Error("No Agent bootstrap session exists. Start bootstrap first.");
  return session;
}

export async function previewAgentBootstrap(root: string): Promise<AgentBootstrapPreview> {
  const config = await loadConfig(root);
  const scan = await scanRepositoryDetailed(root, config.source);
  const extensions: Record<string, number> = {};
  for (const file of scan.files) {
    const match = file.path.toLowerCase().match(/\.[^./]+$/);
    const extension = match?.[0] ?? "(none)";
    extensions[extension] = (extensions[extension] ?? 0) + 1;
  }
  const suspicious = /(?:^|[\/_.-])(secret|credential|token|password|private|keystore|auth)(?:[\/_.-]|$)/i;
  return {
    discoveryMode: scan.discoveryMode,
    totalFiles: scan.files.length,
    totalBytes: scan.files.reduce((total, file) => total + file.size, 0),
    extensions: Object.fromEntries(Object.entries(extensions).sort(([left], [right]) => left.localeCompare(right))),
    suspiciousPaths: scan.files.map((file) => file.path).filter((path) => suspicious.test(path)).sort(),
    largestFiles: [...scan.files]
      .sort((left, right) => right.size - left.size || left.path.localeCompare(right.path))
      .slice(0, 20)
      .map((file) => ({ path: file.path, size: file.size })),
  };
}

export async function startAgentBootstrap(
  root: string,
  options: AgentBootstrapStartOptions,
): Promise<AgentBootstrapStartResult> {
  let snapshot = await loadSnapshot(root);
  if (snapshot === null) {
    await bootstrapProject(root);
  } else {
    await syncProject(root);
  }
  snapshot = await loadSnapshot(root);
  if (snapshot === null) throw new Error("Bootstrap could not create a repository snapshot.");

  const maxChunkCharacters = Math.max(2_000, Math.min(50_000, Math.floor(options.maxChunkCharacters ?? 12_000)));
  const structural = await buildStructuralIndex(root);
  const snapshotDigest = digestJson(snapshot);
  const sessionId = digestJson({ snapshotDigest, maxChunkCharacters });
  const prior = await loadAgentBootstrapSession(root);
  const now = new Date().toISOString();

  if (prior?.id === sessionId) {
    const resumed = {
      ...prior,
      sourceDisclosureApproved: prior.sourceDisclosureApproved || options.sourceDisclosureApproved,
      updatedAt: now,
    };
    await saveAgentBootstrapSession(root, resumed);
    return {
      status: agentBootstrapStatus(resumed),
      structural: {
        parsedFiles: structural.metrics.parsedFiles,
        reusedFiles: structural.metrics.reusedFiles,
        resolvedFiles: structural.metrics.resolvedFiles,
        symbols: structural.metrics.symbols,
        references: structural.metrics.references,
        diagnostics: structural.metrics.diagnostics,
        diagnosticFiles: structural.metrics.diagnosticFiles,
        edges: structural.metrics.edges,
        resolvedReferences: structural.metrics.resolvedReferences,
        unresolvedReferences: structural.metrics.unresolvedReferences,
        ambiguousReferences: structural.metrics.ambiguousReferences,
        unknownReceiverReferences: structural.metrics.unknownReceiverReferences,
      },
    };
  }

  const priorUnits = new Map((prior?.units ?? []).map((unit) => [unit.id, unit]));
  const units: BootstrapUnit[] = [];
  let reusedChunkSummaries = 0;
  for (const file of snapshot.files) {
    const source = await readFrozenSource(root, file.path, file.hash);
    for (const unit of chunkSource(file.path, file.hash, source, maxChunkCharacters)) {
      const cached = priorUnits.get(unit.id)?.summary ?? null;
      if (cached !== null) reusedChunkSummaries += 1;
      units.push({ ...unit, summary: cached === null ? null : structuredClone(cached) });
    }
  }
  units.sort((left, right) => left.path.localeCompare(right.path) || left.chunkIndex - right.chunkIndex);

  const fileSummaries: Record<string, FileSemanticSummary> = {};
  let reusedFileSummaries = 0;
  for (const file of snapshot.files) {
    const cached = prior?.fileSummaries[file.path];
    if (cached?.hash === file.hash) {
      fileSummaries[file.path] = structuredClone(cached);
      reusedFileSummaries += 1;
    }
  }
  const session: AgentBootstrapSession = {
    schemaVersion: AGENT_BOOTSTRAP_SCHEMA_VERSION,
    id: sessionId,
    snapshotDigest,
    createdAt: now,
    updatedAt: now,
    sourceDisclosureApproved: options.sourceDisclosureApproved,
    maxChunkCharacters,
    units,
    fileSummaries,
    reusedChunkSummaries,
    reusedFileSummaries,
    completedGraphDigest: null,
  };
  await saveAgentBootstrapSession(root, session);
  return {
    status: agentBootstrapStatus(session),
    structural: {
      parsedFiles: structural.metrics.parsedFiles,
      reusedFiles: structural.metrics.reusedFiles,
      resolvedFiles: structural.metrics.resolvedFiles,
      symbols: structural.metrics.symbols,
      references: structural.metrics.references,
      diagnostics: structural.metrics.diagnostics,
      diagnosticFiles: structural.metrics.diagnosticFiles,
      edges: structural.metrics.edges,
      resolvedReferences: structural.metrics.resolvedReferences,
      unresolvedReferences: structural.metrics.unresolvedReferences,
      ambiguousReferences: structural.metrics.ambiguousReferences,
      unknownReceiverReferences: structural.metrics.unknownReceiverReferences,
    },
  };
}

export async function getAgentBootstrapStatus(root: string): Promise<AgentBootstrapStatus> {
  return agentBootstrapStatus(await requireSession(root));
}

export async function getNextBootstrapSourceBatch(
  root: string,
  maxCharacters = 48_000,
  maxUnits = 12,
): Promise<BootstrapSourceBatch> {
  const session = await requireSession(root);
  if (!session.sourceDisclosureApproved) {
    throw new Error("Source disclosure is not approved for this bootstrap session.");
  }
  const budget = Math.max(1_000, Math.min(200_000, Math.floor(maxCharacters)));
  const unitLimit = Math.max(1, Math.min(50, Math.floor(maxUnits)));
  const pending = session.units.filter((unit) => unit.summary === null);
  const selected: BootstrapUnit[] = [];
  let returnedCharacters = 0;
  for (const unit of pending) {
    if (selected.length >= unitLimit) break;
    if (selected.length > 0 && returnedCharacters + unit.charCount > budget) break;
    selected.push(unit);
    returnedCharacters += unit.charCount;
  }

  const sources = new Map<string, string>();
  const units: BootstrapSourceUnit[] = [];
  for (const unit of selected) {
    let source = sources.get(unit.path);
    if (source === undefined) {
      source = await readFrozenSource(root, unit.path, unit.hash);
      sources.set(unit.path, source);
    }
    units.push({
      id: unit.id,
      path: unit.path,
      hash: unit.hash,
      chunkIndex: unit.chunkIndex,
      chunkCount: unit.chunkCount,
      startLine: unit.startLine,
      endLine: unit.endLine,
      content: source.slice(unit.startOffset, unit.endOffset),
    });
  }
  return {
    sessionId: session.id,
    stage: agentBootstrapStatus(session).stage,
    pendingChunks: pending.length,
    returnedCharacters,
    units,
  };
}

export async function submitBootstrapChunkSummaries(
  root: string,
  sessionId: string,
  submissions: ChunkSummarySubmission[],
): Promise<AgentBootstrapStatus> {
  const session = await requireSession(root);
  if (session.id !== sessionId) throw new Error("Bootstrap session ID is stale.");
  const next = applyChunkSummarySubmissions(session, submissions, new Date().toISOString());
  await saveAgentBootstrapSession(root, next);
  return agentBootstrapStatus(next);
}

export async function getNextBootstrapRollups(
  root: string,
  limit = 5,
): Promise<BootstrapRollupBatch> {
  const session = await requireSession(root);
  const structural = await loadStructuralIndex(root);
  const unitsByPath = new Map<string, BootstrapUnit[]>();
  for (const unit of session.units) {
    const values = unitsByPath.get(unit.path) ?? [];
    values.push(unit);
    unitsByPath.set(unit.path, values);
  }
  const pendingPaths = [...unitsByPath.entries()]
    .filter(([path, units]) => units.every((unit) => unit.summary !== null) && session.fileSummaries[path] === undefined)
    .map(([path]) => path)
    .sort();
  const files: BootstrapFileRollup[] = pendingPaths.slice(0, Math.max(1, Math.min(25, Math.floor(limit)))).map((path) => {
    const units = unitsByPath.get(path) ?? [];
    const contribution = structural?.contributions[path];
    return {
      path,
      hash: units[0]?.hash ?? "",
      chunks: units.map((unit) => ({
        startLine: unit.startLine,
        endLine: unit.endLine,
        summary: unit.summary?.summary ?? "",
        keyFacts: unit.summary?.keyFacts ?? [],
        risks: unit.summary?.risks ?? [],
        confidence: unit.summary?.confidence ?? 0,
      })),
      structural: {
        symbols: (contribution?.symbols ?? []).map((symbol) => ({
          kind: symbol.kind,
          qualifiedName: symbol.qualifiedName,
          signature: symbol.signature,
          startLine: symbol.span.startLine,
          endLine: symbol.span.endLine,
        })),
        references: (contribution?.references ?? []).map((reference) => ({
          kind: reference.kind,
          targetName: reference.targetName,
          line: reference.line,
          ownerSymbolId: reference.ownerSymbolId,
        })),
        diagnostics: (contribution?.diagnostics ?? []).map((diagnostic) => ({
          code: diagnostic.code,
          message: diagnostic.message,
          line: diagnostic.line,
          column: diagnostic.column,
        })),
      },
    };
  });
  return { sessionId: session.id, pendingFiles: pendingPaths.length, files };
}

export async function submitBootstrapFileSummaries(
  root: string,
  sessionId: string,
  submissions: FileSemanticSummary[],
): Promise<AgentBootstrapStatus> {
  const session = await requireSession(root);
  if (session.id !== sessionId) throw new Error("Bootstrap session ID is stale.");
  const next = applyFileSummarySubmissions(session, submissions, new Date().toISOString());
  await saveAgentBootstrapSession(root, next);
  return agentBootstrapStatus(next);
}

export async function getBootstrapCurationContext(
  root: string,
  offset = 0,
  limit = 20,
): Promise<BootstrapCurationContext> {
  const session = await requireSession(root);
  const summaries = Object.values(session.fileSummaries).sort((left, right) => left.path.localeCompare(right.path));
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const page = summaries.slice(safeOffset, safeOffset + safeLimit);
  const nextOffset = safeOffset + page.length < summaries.length ? safeOffset + page.length : null;
  return {
    sessionId: session.id,
    total: summaries.length,
    offset: safeOffset,
    nextOffset,
    summaries: page,
  };
}

export async function finishAgentBootstrap(
  root: string,
  sessionId: string,
  graphDigest: string,
): Promise<AgentBootstrapStatus> {
  const session = await requireSession(root);
  if (session.id !== sessionId) throw new Error("Bootstrap session ID is stale.");
  const graph = await loadGraph(root);
  const snapshot = await loadSnapshot(root);
  const actualGraphDigest = digestJson(graph);
  if (actualGraphDigest !== graphDigest) throw new Error("Curated graph digest changed before bootstrap completion.");
  if (session.completedGraphDigest === graphDigest) return agentBootstrapStatus(session);
  const audit = auditGraph(graph, snapshot);
  if (audit.errors > 0 || audit.warnings > 0 || audit.information > 0) {
    throw new Error(
      `Bootstrap graph audit is not clean: ${audit.errors} errors, ${audit.warnings} warnings, ${audit.information} informational issues.`,
    );
  }
  const next = completeAgentBootstrap(session, graphDigest, new Date().toISOString());
  await saveAgentBootstrapSession(root, next);
  return agentBootstrapStatus(next);
}

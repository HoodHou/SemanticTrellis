export const AGENT_BOOTSTRAP_SCHEMA_VERSION = 1 as const;

export type AgentBootstrapStage =
  | "summarize-chunks"
  | "summarize-files"
  | "ready-for-curation"
  | "complete";

export interface ChunkSemanticSummary {
  summary: string;
  keyFacts: string[];
  risks: string[];
  confidence: number;
  producer: string;
  model: string | null;
}

export interface BootstrapUnit {
  id: string;
  path: string;
  hash: string;
  chunkIndex: number;
  chunkCount: number;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
  charCount: number;
  summary: ChunkSemanticSummary | null;
}

export interface SummaryEvidence {
  startLine: number;
  endLine: number;
  description: string;
}

export interface FileSemanticSummary {
  path: string;
  hash: string;
  summary: string;
  responsibilities: string[];
  keySymbols: string[];
  dependencies: string[];
  inputs: string[];
  outputs: string[];
  sideEffects: string[];
  risks: string[];
  concepts: string[];
  evidence: SummaryEvidence[];
  confidence: number;
  producer: string;
  model: string | null;
}

export interface AgentBootstrapSession {
  schemaVersion: typeof AGENT_BOOTSTRAP_SCHEMA_VERSION;
  id: string;
  snapshotDigest: string;
  createdAt: string;
  updatedAt: string;
  sourceDisclosureApproved: boolean;
  maxChunkCharacters: number;
  units: BootstrapUnit[];
  fileSummaries: Record<string, FileSemanticSummary>;
  reusedChunkSummaries: number;
  reusedFileSummaries: number;
  completedGraphDigest: string | null;
}

export interface ChunkSummarySubmission extends ChunkSemanticSummary {
  unitId: string;
}

export interface AgentBootstrapStatus {
  sessionId: string;
  snapshotDigest: string;
  stage: AgentBootstrapStage;
  sourceDisclosureApproved: boolean;
  totalFiles: number;
  totalChunks: number;
  summarizedChunks: number;
  summarizedFiles: number;
  totalCharacters: number;
  summarizedCharacters: number;
  chunkCoverage: number;
  fileCoverage: number;
  reusedChunkSummaries: number;
  reusedFileSummaries: number;
  completedGraphDigest: string | null;
}

function validConfidence(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function assertChunkSummary(summary: ChunkSemanticSummary): void {
  if (!summary.summary.trim()) throw new Error("Chunk summary must not be empty.");
  if (!summary.producer.trim()) throw new Error("Chunk summary producer must not be empty.");
  if (!validConfidence(summary.confidence)) throw new Error("Chunk summary confidence must be between 0 and 1.");
}

function assertFileSummary(summary: FileSemanticSummary): void {
  if (!summary.path.trim() || !summary.hash.trim()) throw new Error("File summary path and hash are required.");
  if (!summary.summary.trim()) throw new Error(`File summary for ${summary.path} must not be empty.`);
  if (!summary.producer.trim()) throw new Error(`File summary producer for ${summary.path} must not be empty.`);
  if (!validConfidence(summary.confidence)) {
    throw new Error(`File summary confidence for ${summary.path} must be between 0 and 1.`);
  }
}

export function agentBootstrapStatus(session: AgentBootstrapSession): AgentBootstrapStatus {
  const filePaths = new Set(session.units.map((unit) => unit.path));
  const summarizedChunks = session.units.filter((unit) => unit.summary !== null).length;
  const summarizedFiles = Object.keys(session.fileSummaries).length;
  const totalCharacters = session.units.reduce((total, unit) => total + unit.charCount, 0);
  const summarizedCharacters = session.units.reduce(
    (total, unit) => total + (unit.summary === null ? 0 : unit.charCount),
    0,
  );
  let stage: AgentBootstrapStage;
  if (session.completedGraphDigest !== null) stage = "complete";
  else if (summarizedChunks < session.units.length) stage = "summarize-chunks";
  else if (summarizedFiles < filePaths.size) stage = "summarize-files";
  else stage = "ready-for-curation";

  return {
    sessionId: session.id,
    snapshotDigest: session.snapshotDigest,
    stage,
    sourceDisclosureApproved: session.sourceDisclosureApproved,
    totalFiles: filePaths.size,
    totalChunks: session.units.length,
    summarizedChunks,
    summarizedFiles,
    totalCharacters,
    summarizedCharacters,
    chunkCoverage: session.units.length === 0 ? 1 : summarizedChunks / session.units.length,
    fileCoverage: filePaths.size === 0 ? 1 : summarizedFiles / filePaths.size,
    reusedChunkSummaries: session.reusedChunkSummaries,
    reusedFileSummaries: session.reusedFileSummaries,
    completedGraphDigest: session.completedGraphDigest,
  };
}

export function applyChunkSummarySubmissions(
  session: AgentBootstrapSession,
  submissions: ChunkSummarySubmission[],
  updatedAt: string,
): AgentBootstrapSession {
  const next = structuredClone(session);
  const byId = new Map(next.units.map((unit) => [unit.id, unit]));
  const seen = new Set<string>();
  for (const submission of submissions) {
    if (seen.has(submission.unitId)) throw new Error(`Duplicate chunk summary: ${submission.unitId}`);
    seen.add(submission.unitId);
    const unit = byId.get(submission.unitId);
    if (unit === undefined) throw new Error(`Unknown bootstrap unit: ${submission.unitId}`);
    const summary: ChunkSemanticSummary = {
      summary: submission.summary,
      keyFacts: [...submission.keyFacts],
      risks: [...submission.risks],
      confidence: submission.confidence,
      producer: submission.producer,
      model: submission.model,
    };
    assertChunkSummary(summary);
    unit.summary = summary;
  }
  next.updatedAt = updatedAt;
  next.completedGraphDigest = null;
  return next;
}

export function applyFileSummarySubmissions(
  session: AgentBootstrapSession,
  submissions: FileSemanticSummary[],
  updatedAt: string,
): AgentBootstrapSession {
  const next = structuredClone(session);
  const unitsByPath = new Map<string, BootstrapUnit[]>();
  for (const unit of next.units) {
    const values = unitsByPath.get(unit.path) ?? [];
    values.push(unit);
    unitsByPath.set(unit.path, values);
  }
  for (const submission of submissions) {
    assertFileSummary(submission);
    const units = unitsByPath.get(submission.path);
    if (units === undefined) throw new Error(`Unknown bootstrap file: ${submission.path}`);
    if (units.some((unit) => unit.summary === null)) {
      throw new Error(`All chunks for ${submission.path} must be summarized before file rollup.`);
    }
    if (units.some((unit) => unit.hash !== submission.hash)) {
      throw new Error(`File summary hash does not match the frozen snapshot: ${submission.path}`);
    }
    next.fileSummaries[submission.path] = structuredClone(submission);
  }
  next.updatedAt = updatedAt;
  next.completedGraphDigest = null;
  return next;
}

export function completeAgentBootstrap(
  session: AgentBootstrapSession,
  graphDigest: string,
  updatedAt: string,
): AgentBootstrapSession {
  const status = agentBootstrapStatus(session);
  if (status.stage !== "ready-for-curation") {
    throw new Error(`Bootstrap cannot complete while stage is ${status.stage}.`);
  }
  const next = structuredClone(session);
  next.completedGraphDigest = graphDigest;
  next.updatedAt = updatedAt;
  return next;
}

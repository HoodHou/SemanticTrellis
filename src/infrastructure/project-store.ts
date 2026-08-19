import { access, readFile, stat, writeFile } from "node:fs/promises";
import {
  SCHEMA_VERSION,
  type ApprovalStatus,
  type CuratedGraph,
  type GraphPatch,
  type GraphPatchOperation,
  type ProjectConfig,
  type RepositorySnapshot,
  type ReviewQueue,
  type SemanticEdge,
  type SemanticNode,
  type SemanticNodeKind,
  type SemanticRelation,
  type SourceReference,
} from "../domain/model.js";
import { readJsonFile, readJsonFileOrNull, writeJsonFile } from "./json-store.js";
import { projectLayout } from "./layout.js";

const NODE_KINDS = new Set<SemanticNodeKind>([
  "system",
  "subsystem",
  "component",
  "concept",
  "invariant",
  "file",
  "external",
]);

const APPROVAL_STATUSES = new Set<ApprovalStatus>([
  "proposed",
  "approved",
  "deprecated",
]);

const RELATIONS = new Set<SemanticRelation>([
  "contains",
  "depends-on",
  "calls",
  "produces",
  "consumes",
  "implements",
  "extends",
  "configures",
  "validates",
  "documents",
  "related-to",
]);

interface CachedGraph {
  size: number;
  mtimeMs: number;
  graph: CuratedGraph;
}

const graphCache = new Map<string, CachedGraph>();

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, context: string): string {
  if (typeof value !== "string") throw new Error(`${context} must be a string.`);
  return value;
}

function boolean(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${context} must be a boolean.`);
  return value;
}

function number(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${context} must be a finite number.`);
  }
  return value;
}

function array(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array.`);
  return value;
}

function stringArray(value: unknown, context: string): string[] {
  return array(value, context).map((item, index) => string(item, `${context}[${index}]`));
}

function schema(value: unknown, context: string): void {
  if (value !== SCHEMA_VERSION) {
    throw new Error(`${context} uses unsupported schema version ${String(value)}.`);
  }
}

function parseSource(value: unknown, context: string): SourceReference {
  const input = record(value, context);
  const role = string(input.role, `${context}.role`);
  if (role !== "primary" && role !== "supporting") {
    throw new Error(`${context}.role is invalid.`);
  }
  return { path: string(input.path, `${context}.path`), role };
}

function parseNode(value: unknown, context: string): SemanticNode {
  const input = record(value, context);
  const kind = string(input.kind, `${context}.kind`) as SemanticNodeKind;
  const status = string(input.status, `${context}.status`) as ApprovalStatus;
  if (!NODE_KINDS.has(kind)) throw new Error(`${context}.kind is invalid.`);
  if (!APPROVAL_STATUSES.has(status)) throw new Error(`${context}.status is invalid.`);
  return {
    id: string(input.id, `${context}.id`),
    name: string(input.name, `${context}.name`),
    kind,
    summary: string(input.summary, `${context}.summary`),
    sources: array(input.sources, `${context}.sources`).map((source, index) =>
      parseSource(source, `${context}.sources[${index}]`),
    ),
    tags: stringArray(input.tags, `${context}.tags`),
    status,
    locked: boolean(input.locked, `${context}.locked`),
  };
}

function parseEdge(value: unknown, context: string): SemanticEdge {
  const input = record(value, context);
  const relation = string(input.relation, `${context}.relation`) as SemanticRelation;
  const status = string(input.status, `${context}.status`) as ApprovalStatus;
  if (!RELATIONS.has(relation)) throw new Error(`${context}.relation is invalid.`);
  if (!APPROVAL_STATUSES.has(status)) throw new Error(`${context}.status is invalid.`);
  return {
    id: string(input.id, `${context}.id`),
    from: string(input.from, `${context}.from`),
    to: string(input.to, `${context}.to`),
    relation,
    description: string(input.description, `${context}.description`),
    status,
  };
}

export function parseConfig(value: unknown): ProjectConfig {
  const input = record(value, "Project config");
  schema(input.schemaVersion, "Project config");
  const source = record(input.source, "Project config.source");
  const maintenance = record(input.maintenance, "Project config.maintenance");
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: string(input.projectId, "Project config.projectId"),
    source: {
      extensions: stringArray(source.extensions, "Project config.source.extensions"),
      excludeDirectories: stringArray(
        source.excludeDirectories,
        "Project config.source.excludeDirectories",
      ),
      maxFileBytes: number(source.maxFileBytes, "Project config.source.maxFileBytes"),
    },
    maintenance: {
      impactDepth: number(maintenance.impactDepth, "Project config.maintenance.impactDepth"),
      fullAuditChangeRatio: number(
        maintenance.fullAuditChangeRatio,
        "Project config.maintenance.fullAuditChangeRatio",
      ),
    },
  };
}

export function parseGraph(value: unknown): CuratedGraph {
  const input = record(value, "Curated graph");
  schema(input.schemaVersion, "Curated graph");
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: string(input.projectId, "Curated graph.projectId"),
    nodes: array(input.nodes, "Curated graph.nodes").map((node, index) =>
      parseNode(node, `Curated graph.nodes[${index}]`),
    ),
    edges: array(input.edges, "Curated graph.edges").map((edge, index) =>
      parseEdge(edge, `Curated graph.edges[${index}]`),
    ),
  };
}

function parseOperation(value: unknown, context: string): GraphPatchOperation {
  const input = record(value, context);
  const op = string(input.op, `${context}.op`);
  switch (op) {
    case "upsert-node":
      return {
        op,
        node: parseNode(input.node, `${context}.node`),
        ...(input.overrideLocked === undefined
          ? {}
          : { overrideLocked: boolean(input.overrideLocked, `${context}.overrideLocked`) }),
      };
    case "remove-node":
      return {
        op,
        nodeId: string(input.nodeId, `${context}.nodeId`),
        ...(input.overrideLocked === undefined
          ? {}
          : { overrideLocked: boolean(input.overrideLocked, `${context}.overrideLocked`) }),
      };
    case "upsert-edge":
      return { op, edge: parseEdge(input.edge, `${context}.edge`) };
    case "remove-edge":
      return { op, edgeId: string(input.edgeId, `${context}.edgeId`) };
    case "mark-reviewed":
      return { op, paths: stringArray(input.paths, `${context}.paths`) };
    default:
      throw new Error(`${context}.op is invalid: ${op}`);
  }
}

export function parsePatch(value: unknown): GraphPatch {
  const input = record(value, "Graph patch");
  schema(input.schemaVersion, "Graph patch");
  return {
    schemaVersion: SCHEMA_VERSION,
    operations: array(input.operations, "Graph patch.operations").map((operation, index) =>
      parseOperation(operation, `Graph patch.operations[${index}]`),
    ),
  };
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function loadConfig(root: string): Promise<ProjectConfig> {
  return parseConfig(await readJsonFile(projectLayout(root).configFile));
}

export async function loadGraph(root: string): Promise<CuratedGraph> {
  const path = projectLayout(root).graphFile;
  const fileStat = await stat(path);
  const cached = graphCache.get(path);
  if (cached?.size === fileStat.size && cached.mtimeMs === fileStat.mtimeMs) {
    return cached.graph;
  }
  const graph = parseGraph(await readJsonFile(path));
  graphCache.set(path, { size: fileStat.size, mtimeMs: fileStat.mtimeMs, graph });
  return graph;
}

export async function loadSnapshot(root: string): Promise<RepositorySnapshot | null> {
  const value = await readJsonFileOrNull(projectLayout(root).snapshotFile);
  if (value === null) return null;
  const input = record(value, "Repository snapshot");
  schema(input.schemaVersion, "Repository snapshot");
  return value as RepositorySnapshot;
}

export async function loadReviewQueue(root: string): Promise<ReviewQueue> {
  const value = await readJsonFileOrNull(projectLayout(root).reviewQueueFile);
  if (value === null) return { schemaVersion: SCHEMA_VERSION, items: [] };
  const input = record(value, "Review queue");
  schema(input.schemaVersion, "Review queue");
  return value as ReviewQueue;
}

export async function loadPatch(path: string): Promise<GraphPatch> {
  return parsePatch(await readJsonFile(path));
}

export async function saveConfig(root: string, config: ProjectConfig): Promise<void> {
  await writeJsonFile(projectLayout(root).configFile, config);
}

export async function saveGraph(root: string, graph: CuratedGraph): Promise<void> {
  const path = projectLayout(root).graphFile;
  await writeJsonFile(path, graph);
  const fileStat = await stat(path);
  graphCache.set(path, { size: fileStat.size, mtimeMs: fileStat.mtimeMs, graph });
}

export async function saveSnapshot(root: string, snapshot: RepositorySnapshot): Promise<void> {
  await writeJsonFile(projectLayout(root).snapshotFile, snapshot);
}

export async function saveReviewQueue(root: string, queue: ReviewQueue): Promise<void> {
  await writeJsonFile(projectLayout(root).reviewQueueFile, queue);
}

export async function ensureLocalStateIgnored(root: string): Promise<void> {
  const path = `${projectLayout(root).root}/.gitignore`;
  const entry = "/.semantic-trellis/local/";
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) {
      throw error;
    }
  }
  if (current.split(/\r?\n/).some((line) => line.trim() === entry)) return;
  const separator = current.length === 0 ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  await writeFile(
    path,
    `${current}${separator}# SemanticTrellis local state is disposable.\n${entry}\n`,
    "utf8",
  );
}

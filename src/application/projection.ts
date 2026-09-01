import { performance } from "node:perf_hooks";
import { resolve, sep } from "node:path";
import {
  PROJECTION_INDEX_SCHEMA_VERSION,
  PROJECTION_SCHEMA_VERSION,
  isProjectionPath,
  parseProjectionDocument,
  projectionFormat,
  projectionSourcePath,
  type CachedProjectionRecord,
  type ProjectionFormat,
  type ProjectionHealth,
  type ProjectionIndex,
  type ProjectionMetadata,
  type UnsupportedArtifactRecord,
  type UnsupportedArtifactReason,
} from "../domain/projection.js";
import { digestBytes, digestFile, digestJson } from "../infrastructure/digest.js";
import {
  existingFileDigest,
  readProjectionText,
  writeProjectionText,
} from "../infrastructure/projection-files.js";
import { loadProjectionIndex, saveProjectionIndex } from "../infrastructure/projection-store.js";
import { loadConfig } from "../infrastructure/project-store.js";
import {
  scanRepositoryInventory,
  type RepositoryInventory,
  type RepositoryInventoryArtifact,
} from "../infrastructure/repository-scanner.js";
import {
  readGitRepositoryState,
  readGitRevisionChanges,
} from "../infrastructure/repository-state.js";

export interface ProjectionRefreshMetrics {
  artifactsDiscovered: number;
  unsupportedArtifacts: number;
  projectionFiles: number;
  hashedSources: number;
  reusedSourceHashes: number;
  parsedProjections: number;
  reusedProjections: number;
  durationMs: number;
}

export interface ProjectionFileStatus {
  path: string;
  format: ProjectionFormat;
  health: ProjectionHealth;
  sourcePath: string | null;
  sourceSha256: string | null;
  mediaType: string | null;
  tool: string | null;
  toolVersion: string | null;
  omissions: string[];
  warnings: string[];
  error: string | null;
}

export interface UnsupportedArtifactStatus {
  path: string;
  sha256: string;
  size: number;
  extension: string;
  reasons: UnsupportedArtifactReason[];
  state: "unprojected" | "current" | "stale" | "invalid";
  projections: ProjectionFileStatus[];
}

export interface UnsupportedArtifactList {
  discoveryMode: "git" | "filesystem";
  total: number;
  totalBytes: number;
  offset: number;
  returned: number;
  nextOffset: number | null;
  extensions: Record<string, number>;
  items: UnsupportedArtifactStatus[];
  refresh: ProjectionRefreshMetrics;
}

export interface ProjectionStatusResult extends UnsupportedArtifactList {
  counts: {
    unprojected: number;
    current: number;
    stale: number;
    invalid: number;
    orphaned: number;
  };
  orphaned: ProjectionFileStatus[];
}

export interface ProjectionValidation {
  validationToken: string;
  projectionPath: string;
  format: ProjectionFormat;
  sourcePath: string;
  sourceSha256: string;
  mediaType: string;
  tool: string;
  toolVersion: string;
  omissions: string[];
  warnings: string[];
  projectionSha256: string;
  existingProjectionSha256: string | null;
  bytes: number;
}

export interface ProjectionRegistration {
  projectionPath: string;
  sourcePath: string;
  sourceSha256: string;
  projectionSha256: string;
  bytes: number;
  health: "current";
}

interface RefreshedProjectionState {
  inventory: RepositoryInventory;
  index: ProjectionIndex;
  refresh: ProjectionRefreshMetrics;
}

function absolutePath(root: string, path: string): string {
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, path);
  const prefix = absoluteRoot.endsWith(sep) ? absoluteRoot : `${absoluteRoot}${sep}`;
  if (target === absoluteRoot || !target.startsWith(prefix)) {
    throw new Error("Projection paths must remain inside the fixed repository root.");
  }
  return target;
}

function normalizePrefix(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalized || normalized.split("/").some((segment) => segment === "..")) {
    throw new Error("Path prefix must be a normalized repository-relative path.");
  }
  return normalized;
}

function underPrefix(path: string, prefix: string | null): boolean {
  return prefix === null || path === prefix || path.startsWith(`${prefix}/`);
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

function reusable(
  previous: { size: number; mtimeMs: number } | undefined,
  current: RepositoryInventoryArtifact,
  forcedPaths: ReadonlySet<string>,
): boolean {
  return previous !== undefined &&
    !forcedPaths.has(current.path) &&
    previous.size === current.size &&
    previous.mtimeMs === current.mtimeMs;
}

async function refreshProjectionState(
  root: string,
  additionallyForced: ReadonlySet<string> = new Set<string>(),
): Promise<RefreshedProjectionState> {
  const started = performance.now();
  const [config, previous, gitState] = await Promise.all([
    loadConfig(root),
    loadProjectionIndex(root),
    readGitRepositoryState(root),
  ]);
  const inventory = await scanRepositoryInventory(root, config.source);
  const untracked = new Set(gitState?.untrackedPaths ?? []);
  const forcedPaths = new Set(
    (gitState?.changedPaths ?? []).filter((path) => !untracked.has(path)),
  );
  const currentRevision = gitState?.revision ?? null;
  if (
    previous !== null &&
    previous.repositoryRevision !== null &&
    currentRevision !== null &&
    previous.repositoryRevision !== currentRevision
  ) {
    const revisionChanges = await readGitRevisionChanges(
      root,
      previous.repositoryRevision,
      currentRevision,
    );
    if (revisionChanges === null) {
      for (const artifact of inventory.artifacts) forcedPaths.add(artifact.path);
    } else {
      for (const path of revisionChanges) forcedPaths.add(path);
    }
  }
  for (const path of additionallyForced) forcedPaths.add(path);
  const previousSources = new Map((previous?.sources ?? []).map((source) => [source.path, source]));
  const previousProjections = new Map(
    (previous?.projections ?? []).map((projection) => [projection.path, projection]),
  );
  const sourceCandidates = inventory.artifacts.filter(
    (artifact) => !artifact.eligible && !isProjectionPath(artifact.path),
  );
  const projectionCandidates = inventory.artifacts.filter((artifact) => isProjectionPath(artifact.path));
  let hashedSources = 0;
  let reusedSourceHashes = 0;
  let parsedProjections = 0;
  let reusedProjections = 0;

  const sources = await mapWithConcurrency(sourceCandidates, 8, async (artifact) => {
    const prior = previousSources.get(artifact.path);
    let hash: string;
    if (prior !== undefined && reusable(prior, artifact, forcedPaths)) {
      hash = prior.hash;
      reusedSourceHashes += 1;
    } else {
      hash = await digestFile(absolutePath(root, artifact.path));
      hashedSources += 1;
    }
    return {
      path: artifact.path,
      hash,
      size: artifact.size,
      mtimeMs: artifact.mtimeMs,
      extension: artifact.extension,
      reasons: [...artifact.reasons],
    } satisfies UnsupportedArtifactRecord;
  });

  const projections = await mapWithConcurrency(projectionCandidates, 8, async (artifact) => {
    const format = projectionFormat(artifact.path);
    if (format === null) throw new Error(`Projection format disappeared: ${artifact.path}`);
    const prior = previousProjections.get(artifact.path);
    if (prior !== undefined && reusable(prior, artifact, forcedPaths)) {
      reusedProjections += 1;
      return prior;
    }
    parsedProjections += 1;
    const path = absolutePath(root, artifact.path);
    const hash = await digestFile(path);
    let metadata: ProjectionMetadata | null = null;
    let error: string | null = null;
    try {
      if (artifact.size > config.source.maxFileBytes) {
        throw new Error(`Projection exceeds the ${config.source.maxFileBytes}-byte source limit.`);
      }
      const text = await readProjectionText(path);
      const parsed = parseProjectionDocument(artifact.path, text);
      metadata = parsed.metadata;
      if (text !== parsed.normalizedContent) {
        throw new Error("Projection is valid but not deterministically normalized; validate and register it again.");
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    return {
      path: artifact.path,
      hash,
      size: artifact.size,
      mtimeMs: artifact.mtimeMs,
      format,
      metadata,
      error,
    } satisfies CachedProjectionRecord;
  });

  const index: ProjectionIndex = {
    schemaVersion: PROJECTION_INDEX_SCHEMA_VERSION,
    discoveryMode: inventory.discoveryMode,
    repositoryRevision: currentRevision,
    sources: sources.sort((left, right) => left.path.localeCompare(right.path)),
    projections: projections.sort((left, right) => left.path.localeCompare(right.path)),
  };
  if (previous === null || digestJson(previous) !== digestJson(index)) {
    await saveProjectionIndex(root, index);
  }
  return {
    inventory,
    index,
    refresh: {
      artifactsDiscovered: inventory.artifacts.length,
      unsupportedArtifacts: index.sources.length,
      projectionFiles: index.projections.length,
      hashedSources,
      reusedSourceHashes,
      parsedProjections,
      reusedProjections,
      durationMs: Number((performance.now() - started).toFixed(3)),
    },
  };
}

function projectionHealth(
  projection: CachedProjectionRecord,
  unsupported: Map<string, UnsupportedArtifactRecord>,
  inventory: Map<string, RepositoryInventoryArtifact>,
): ProjectionHealth {
  if (projection.error !== null || projection.metadata === null) return "invalid";
  const source = inventory.get(projection.metadata.source.path);
  if (source === undefined) return "missing-source";
  if (source.eligible) return "source-supported";
  const unsupportedSource = unsupported.get(source.path);
  if (unsupportedSource === undefined) return "invalid";
  return unsupportedSource.hash === projection.metadata.source.sha256 ? "current" : "stale";
}

function projectionView(
  projection: CachedProjectionRecord,
  health: ProjectionHealth,
): ProjectionFileStatus {
  const metadata = projection.metadata;
  return {
    path: projection.path,
    format: projection.format,
    health,
    sourcePath: metadata?.source.path ?? projectionSourcePath(projection.path),
    sourceSha256: metadata?.source.sha256 ?? null,
    mediaType: metadata?.source.mediaType ?? null,
    tool: metadata?.producer.tool ?? null,
    toolVersion: metadata?.producer.version ?? null,
    omissions: metadata?.omissions ?? [],
    warnings: metadata?.warnings ?? [],
    error: projection.error,
  };
}

function statusItems(state: RefreshedProjectionState): {
  items: UnsupportedArtifactStatus[];
  orphaned: ProjectionFileStatus[];
} {
  const unsupported = new Map(state.index.sources.map((source) => [source.path, source]));
  const inventory = new Map(state.inventory.artifacts.map((artifact) => [artifact.path, artifact]));
  const projectionsBySource = new Map<string, ProjectionFileStatus[]>();
  const orphaned: ProjectionFileStatus[] = [];
  for (const projection of state.index.projections) {
    const health = projectionHealth(projection, unsupported, inventory);
    const view = projectionView(projection, health);
    const sourcePath = view.sourcePath;
    if (sourcePath === null || !unsupported.has(sourcePath)) {
      orphaned.push(view);
      continue;
    }
    const values = projectionsBySource.get(sourcePath) ?? [];
    values.push(view);
    projectionsBySource.set(sourcePath, values);
  }
  const items = state.index.sources.map((source) => {
    const projections = (projectionsBySource.get(source.path) ?? [])
      .sort((left, right) => left.path.localeCompare(right.path));
    let artifactState: UnsupportedArtifactStatus["state"] = "unprojected";
    if (projections.length > 1) artifactState = "invalid";
    else if (projections.some((projection) =>
      projection.health === "invalid" ||
      projection.health === "missing-source" ||
      projection.health === "source-supported"
    )) artifactState = "invalid";
    else if (projections.some((projection) => projection.health === "stale")) artifactState = "stale";
    else if (projections.length > 0) artifactState = "current";
    return {
      path: source.path,
      sha256: source.hash,
      size: source.size,
      extension: source.extension,
      reasons: source.reasons,
      state: artifactState,
      projections,
    } satisfies UnsupportedArtifactStatus;
  });
  return {
    items: items.sort((left, right) => left.path.localeCompare(right.path)),
    orphaned: orphaned.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function paginate(
  values: UnsupportedArtifactStatus[],
  offset: number,
  limit: number,
): { values: UnsupportedArtifactStatus[]; offset: number; nextOffset: number | null } {
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const page = values.slice(safeOffset, safeOffset + safeLimit);
  return {
    values: page,
    offset: safeOffset,
    nextOffset: safeOffset + page.length < values.length ? safeOffset + page.length : null,
  };
}

function extensionCounts(values: UnsupportedArtifactStatus[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value.extension] = (counts[value.extension] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

export async function listUnsupportedArtifacts(
  root: string,
  offset = 0,
  limit = 100,
  pathPrefix?: string,
): Promise<UnsupportedArtifactList> {
  const state = await refreshProjectionState(root);
  const prefix = normalizePrefix(pathPrefix);
  const items = statusItems(state).items.filter((item) => underPrefix(item.path, prefix));
  const page = paginate(items, offset, limit);
  return {
    discoveryMode: state.index.discoveryMode,
    total: items.length,
    totalBytes: items.reduce((total, item) => total + item.size, 0),
    offset: page.offset,
    returned: page.values.length,
    nextOffset: page.nextOffset,
    extensions: extensionCounts(items),
    items: page.values,
    refresh: state.refresh,
  };
}

export async function getProjectionStatus(
  root: string,
  offset = 0,
  limit = 100,
  pathPrefix?: string,
): Promise<ProjectionStatusResult> {
  const state = await refreshProjectionState(root);
  const prefix = normalizePrefix(pathPrefix);
  const all = statusItems(state);
  const items = all.items.filter((item) => underPrefix(item.path, prefix));
  const orphaned = all.orphaned.filter((projection) =>
    underPrefix(projection.sourcePath ?? projection.path, prefix),
  );
  const page = paginate(items, offset, limit);
  return {
    discoveryMode: state.index.discoveryMode,
    total: items.length,
    totalBytes: items.reduce((total, item) => total + item.size, 0),
    offset: page.offset,
    returned: page.values.length,
    nextOffset: page.nextOffset,
    extensions: extensionCounts(items),
    items: page.values,
    counts: {
      unprojected: items.filter((item) => item.state === "unprojected").length,
      current: items.filter((item) => item.state === "current").length,
      stale: items.filter((item) => item.state === "stale").length,
      invalid: items.filter((item) => item.state === "invalid").length,
      orphaned: orphaned.length,
    },
    orphaned,
    refresh: state.refresh,
  };
}

function token(
  projectionPath: string,
  sourcePath: string,
  sourceSha256: string,
  projectionSha256: string,
  existingProjectionSha256: string | null,
): string {
  return digestJson({
    operation: "semantic-trellis-projection-registration",
    schemaVersion: 1,
    projectionSchemaVersion: PROJECTION_SCHEMA_VERSION,
    projectionPath,
    sourcePath,
    sourceSha256,
    projectionSha256,
    existingProjectionSha256,
  });
}

export async function validateArtifactProjection(
  root: string,
  projectionPath: string,
  content: string,
): Promise<ProjectionValidation> {
  const parsed = parseProjectionDocument(projectionPath, content);
  const state = await refreshProjectionState(root);
  const source = state.index.sources.find((item) => item.path === parsed.metadata.source.path);
  if (source === undefined) {
    throw new Error(
      `Projection source is not a Git-visible unsupported artifact: ${parsed.metadata.source.path}.`,
    );
  }
  const conflictingProjection = state.index.projections.find((projection) =>
    projection.path !== projectionPath &&
    (projection.metadata?.source.path ?? projectionSourcePath(projection.path)) === source.path,
  );
  if (conflictingProjection !== undefined) {
    throw new Error(
      `Projection source already has a different sidecar: ${conflictingProjection.path}.`,
    );
  }
  const actualSourceSha256 = await digestFile(absolutePath(root, source.path));
  if (actualSourceSha256 !== parsed.metadata.source.sha256) {
    throw new Error(
      `Projection source hash is stale for ${source.path}: expected ${actualSourceSha256}.`,
    );
  }
  const config = await loadConfig(root);
  const bytes = Buffer.byteLength(parsed.normalizedContent, "utf8");
  if (bytes > config.source.maxFileBytes) {
    throw new Error(`Projection exceeds the ${config.source.maxFileBytes}-byte source limit.`);
  }
  const projectionSha256 = digestBytes(parsed.normalizedContent);
  const existingProjectionSha256 = await existingFileDigest(absolutePath(root, projectionPath));
  return {
    validationToken: token(
      projectionPath,
      source.path,
      actualSourceSha256,
      projectionSha256,
      existingProjectionSha256,
    ),
    projectionPath,
    format: parsed.format,
    sourcePath: source.path,
    sourceSha256: actualSourceSha256,
    mediaType: parsed.metadata.source.mediaType,
    tool: parsed.metadata.producer.tool,
    toolVersion: parsed.metadata.producer.version,
    omissions: parsed.metadata.omissions,
    warnings: parsed.metadata.warnings,
    projectionSha256,
    existingProjectionSha256,
    bytes,
  };
}

export async function registerArtifactProjection(
  root: string,
  projectionPath: string,
  content: string,
  expectedValidationToken: string,
): Promise<ProjectionRegistration> {
  const parsed = parseProjectionDocument(projectionPath, content);
  const validation = await validateArtifactProjection(root, projectionPath, content);
  if (validation.validationToken !== expectedValidationToken) {
    throw new Error(
      "Projection validation token is invalid or stale. The source, projection content, or target file changed; validate again before registering it.",
    );
  }
  await writeProjectionText(absolutePath(root, projectionPath), parsed.normalizedContent);
  const refreshed = await refreshProjectionState(root, new Set([projectionPath]));
  const registered = statusItems(refreshed).items
    .filter((item) => item.path === validation.sourcePath)
    .flatMap((item) => item.projections)
    .find((projection) => projection.path === projectionPath);
  if (registered?.health !== "current") {
    throw new Error("Registered projection did not become current after persistence.");
  }
  return {
    projectionPath,
    sourcePath: validation.sourcePath,
    sourceSha256: validation.sourceSha256,
    projectionSha256: validation.projectionSha256,
    bytes: validation.bytes,
    health: "current",
  };
}

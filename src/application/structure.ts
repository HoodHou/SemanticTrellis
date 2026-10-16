import { performance } from "node:perf_hooks";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  STRUCTURAL_SCHEMA_VERSION,
  type FileContribution,
  type StructuralBuildResult,
  type StructuralIndex,
} from "../domain/structural.js";
import { loadConfig, loadSnapshot } from "../infrastructure/project-store.js";
import { readGitRepositoryState } from "../infrastructure/repository-state.js";
import { scanRepositoryDetailed } from "../infrastructure/repository-scanner.js";
import { rememberVerifiedSource } from "../infrastructure/source-cache.js";
import { loadStructuralIndex, saveStructuralIndex } from "../infrastructure/structural-store.js";
import { decodeSourceText } from "../infrastructure/text-decoder.js";
import { digestBytes } from "../infrastructure/digest.js";
import {
  attachCrossLayerReferences,
  crossLayerFingerprint,
} from "../structural/cross-layer.js";
import { EXTRACTOR_FINGERPRINT, pathMayHaveStructure } from "../structural/freshness.js";
import { resolveStructuralGraph } from "../structural/resolver.js";

function contributionReferenceNames(contribution: FileContribution): string[] {
  const names = new Set<string>();
  for (const reference of contribution.references) {
    names.add(reference.targetName);
    if (reference.kind === "import") names.add("__imports__");
  }
  return [...names].sort();
}

function resolutionDefinitionsByName(
  contribution: FileContribution | undefined,
): Map<string, string[]> {
  const values = new Map<string, string[]>();
  for (const symbol of contribution?.symbols ?? []) {
    if (symbol.kind === "file") continue;
    const definitions = values.get(symbol.name) ?? [];
    definitions.push(`${symbol.kind}:${symbol.id}`);
    values.set(symbol.name, definitions);
  }
  for (const definitions of values.values()) definitions.sort();
  return values;
}

function changedDefinitionNames(
  before: FileContribution | undefined,
  after: FileContribution | undefined,
): string[] {
  const beforeByName = resolutionDefinitionsByName(before);
  const afterByName = resolutionDefinitionsByName(after);
  const names = new Set([...beforeByName.keys(), ...afterByName.keys()]);
  return [...names]
    .filter((name) => {
      const beforeDefinitions = beforeByName.get(name) ?? [];
      const afterDefinitions = afterByName.get(name) ?? [];
      return beforeDefinitions.length !== afterDefinitions.length ||
        beforeDefinitions.some((definition, index) => definition !== afterDefinitions[index]);
    })
    .sort();
}

function recordedStrings(record: Record<string, string[]>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function removeReferenceFile(
  path: string,
  referenceFilesByName: Record<string, string[]>,
  referenceNamesByFile: Record<string, string[]>,
): void {
  const storedNames = referenceNamesByFile[path];
  for (const name of Array.isArray(storedNames) ? storedNames : []) {
    const storedPaths = referenceFilesByName[name];
    const remaining = (Array.isArray(storedPaths) ? storedPaths : [])
      .filter((candidate) => candidate !== path);
    if (remaining.length === 0) delete referenceFilesByName[name];
    else referenceFilesByName[name] = remaining;
  }
  delete referenceNamesByFile[path];
}

function addReferenceFile(
  contribution: FileContribution,
  referenceFilesByName: Record<string, string[]>,
  referenceNamesByFile: Record<string, string[]>,
): void {
  const names = contributionReferenceNames(contribution);
  referenceNamesByFile[contribution.path] = names;
  for (const name of names) {
    const storedPaths = referenceFilesByName[name];
    referenceFilesByName[name] = [
      ...new Set([
        ...(Array.isArray(storedPaths) ? storedPaths : []),
        contribution.path,
      ]),
    ].sort();
  }
}

function aggregateResolution(
  values: Record<string, StructuralIndex["resolution"]>,
): StructuralIndex["resolution"] {
  return Object.values(values).reduce(
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
}

function directoryAllowed(path: string, excluded: ReadonlySet<string>): boolean {
  return !path.split("/").some((segment) => excluded.has(segment.toLowerCase()));
}

function cachedStructuralResult(index: StructuralIndex, started: number): StructuralBuildResult {
  const values = Object.values(index.contributions);
  return {
    index,
    metrics: {
      discoveryMode: index.discoveryMode,
      filesDiscovered: values.length,
      filesSupported: values.length,
      parsedFiles: 0,
      reusedFiles: values.length,
      removedFiles: 0,
      resolvedFiles: 0,
      symbols: values.reduce((total, contribution) => total + contribution.symbols.length, 0),
      references: values.reduce((total, contribution) => total + contribution.references.length, 0),
      diagnostics: values.reduce((total, contribution) => total + contribution.diagnostics.length, 0),
      diagnosticFiles: values.filter((contribution) => contribution.diagnostics.length > 0).length,
      edges: index.edges.length,
      ...index.resolution,
      durationMs: Number((performance.now() - started).toFixed(3)),
    },
  };
}

async function hasStaleContribution(root: string, index: StructuralIndex): Promise<boolean> {
  if (index.extractorFingerprint !== EXTRACTOR_FINGERPRINT) return true;
  const gitState = await readGitRepositoryState(root);
  if (index.discoveryMode === "git" && gitState !== null) {
    if (gitState.revision !== index.repositoryRevision) {
      return true;
    }
    const config = await loadConfig(root);
    const excluded = new Set(config.source.excludeDirectories.map((value) => value.toLowerCase()));
    const untracked = new Set(gitState.untrackedPaths);
    const relevantTracked = gitState.changedPaths.filter((path) =>
      !untracked.has(path) &&
      directoryAllowed(path, excluded) &&
      (pathMayHaveStructure(path) || index.contributions[path] !== undefined),
    );
    const structuralUntracked = gitState.untrackedPaths.filter((path) =>
      directoryAllowed(path, excluded) && pathMayHaveStructure(path),
    );
    if (relevantTracked.length === 0 && structuralUntracked.length === 0) {
      return false;
    }
    const { createDefaultLanguageRegistry } = await import("../structural/registry.js");
    const registry = createDefaultLanguageRegistry();
    const allowed = (path: string): boolean =>
      !path.split("/").some((segment) => excluded.has(segment.toLowerCase())) &&
      registry.adapterFor(path) !== null;
    const untrackedPaths: string[] = [];
    for (const path of gitState.untrackedPaths) {
      if (!allowed(path)) continue;
      try {
        if ((await stat(resolve(root, path))).size <= config.source.maxFileBytes) {
          untrackedPaths.push(path);
        }
      } catch {
        // A disappearing untracked file will be handled by the next probe.
      }
    }
    untrackedPaths.sort();
    if (JSON.stringify(untrackedPaths) !== JSON.stringify(index.untrackedPaths)) {
      return true;
    }
    for (const path of gitState.changedPaths) {
      const contribution = index.contributions[path];
      const adapter = registry.adapterFor(path);
      if (!allowed(path)) {
        if (contribution !== undefined) {
          return true;
        }
        continue;
      }
      if (contribution === undefined || adapter?.version !== contribution.extractorVersion) {
        return true;
      }
      try {
        const bytes = await readFile(resolve(root, path));
        if (digestBytes(bytes) !== contribution.hash) {
          return true;
        }
      } catch {
        return true;
      }
    }
    return false;
  }

  const contributions = Object.values(index.contributions);
  let next = 0;
  let stale = false;
  await Promise.all(Array.from({ length: Math.min(32, contributions.length) }, async () => {
    while (!stale && next < contributions.length) {
      const current = contributions[next];
      next += 1;
      if (current === undefined) continue;
      try {
        const fileStat = await stat(resolve(root, current.path));
        if (
          fileStat.size !== current.sourceSize ||
          fileStat.mtimeMs !== current.sourceMtimeMs
        ) {
          stale = true;
        }
      } catch {
        stale = true;
      }
    }
  }));
  return stale;
}

export async function buildStructuralIndex(root: string): Promise<StructuralBuildResult> {
  const started = performance.now();
  const absoluteRoot = resolve(root);
  const previous = await loadStructuralIndex(absoluteRoot);
  if (previous !== null && !await hasStaleContribution(absoluteRoot, previous)) {
    return cachedStructuralResult(previous, started);
  }
  const config = await loadConfig(absoluteRoot);
  const snapshot = await loadSnapshot(absoluteRoot);
  // Compiler-backed adapters are intentionally loaded only for a real refresh.
  // Read-only cached grep/trace processes should not pay the TypeScript Compiler
  // API startup cost.
  const { createDefaultLanguageRegistry } = await import("../structural/registry.js");
  const registry = createDefaultLanguageRegistry();
  const repositoryState = await readGitRepositoryState(absoluteRoot);
  const previousFileMap = new Map(
    (snapshot?.files ?? []).map((file) => [file.path, file]),
  );
  for (const contribution of Object.values(previous?.contributions ?? {})) {
    previousFileMap.set(contribution.path, {
      path: contribution.path,
      hash: contribution.hash,
      size: contribution.sourceSize,
      mtimeMs: contribution.sourceMtimeMs,
    });
  }
  const previousFiles = [...previousFileMap.values()];
  const forceHash = repositoryState === null
    ? false
    : previous?.repositoryRevision !== repositoryState.revision
      ? true
      : new Set(repositoryState.changedPaths);
  const scan = await scanRepositoryDetailed(absoluteRoot, config.source, {
    previousFiles,
    captureSource: (path) => registry.adapterFor(path) !== null,
    forceHash,
  });
  const contributions: Record<string, FileContribution> = {};
  const parsedSources = new Map<string, string>();
  let filesSupported = 0;
  let parsedFiles = 0;
  let reusedFiles = 0;
  let metadataChanged = false;
  const changedPaths = new Set<string>();

  for (const file of scan.files) {
    const adapter = registry.adapterFor(file.path);
    if (adapter === null) continue;
    filesSupported += 1;
    const prior = previous?.contributions[file.path];
    if (
      prior !== undefined &&
      prior.hash === file.hash &&
      prior.extractorVersion === adapter.version
    ) {
      if (prior.sourceSize !== file.size || prior.sourceMtimeMs !== (file.mtimeMs ?? 0)) {
        contributions[file.path] = {
          ...prior,
          sourceSize: file.size,
          sourceMtimeMs: file.mtimeMs ?? 0,
        };
        metadataChanged = true;
      } else {
        contributions[file.path] = prior;
      }
      reusedFiles += 1;
      continue;
    }
    const source = scan.sources[file.path] ?? decodeSourceText(
      await readFile(resolve(absoluteRoot, file.path)),
      file.path,
    );
    const extracted = adapter.extract({
      path: file.path,
      hash: file.hash,
      size: file.size,
      mtimeMs: file.mtimeMs ?? 0,
      source,
    });
    contributions[file.path] = extracted;
    parsedSources.set(file.path, source);
    rememberVerifiedSource(
      absoluteRoot,
      file.path,
      file.hash,
      file.size,
      file.mtimeMs ?? 0,
      source,
    );
    parsedFiles += 1;
    changedPaths.add(file.path);
  }

  const previousPaths = new Set(Object.keys(previous?.contributions ?? {}));
  for (const path of Object.keys(contributions)) previousPaths.delete(path);
  const removedFiles = previousPaths.size;
  for (const path of previousPaths) changedPaths.add(path);
  const crossLayerSources = new Map(parsedSources);
  if (crossLayerFingerprint(previous?.contributions ?? {}) !== crossLayerFingerprint(contributions)) {
    for (const path of Object.keys(contributions)) {
      if (crossLayerSources.has(path)) continue;
      if (contributions[path]?.language === "markdown" || contributions[path]?.language === "strellis-json") {
        continue;
      }
      try {
        const bytes = await readFile(resolve(absoluteRoot, path));
        crossLayerSources.set(path, decodeSourceText(bytes, path));
      } catch {
        // A file that disappeared is already represented as a removed contribution.
      }
    }
  }
  const crossLayer = attachCrossLayerReferences(contributions, crossLayerSources);
  for (const path of crossLayer.changedPaths) {
    const updated = crossLayer.contributions[path];
    if (updated !== undefined) contributions[path] = updated;
    changedPaths.add(path);
  }
  const contributionsChanged = previous === null ||
    parsedFiles > 0 ||
    removedFiles > 0 ||
    crossLayer.changedPaths.length > 0;
  let edges;
  let resolution;
  let resolutionByFile: StructuralIndex["resolutionByFile"];
  let referenceFilesByName: StructuralIndex["referenceFilesByName"];
  let referenceNamesByFile: StructuralIndex["referenceNamesByFile"];
  let resolvedFiles = 0;

  if (previous === null) {
    const resolved = resolveStructuralGraph(contributions);
    edges = resolved.edges;
    resolution = resolved.metrics;
    resolutionByFile = resolved.metricsByFile;
    referenceFilesByName = Object.create(null) as StructuralIndex["referenceFilesByName"];
    referenceNamesByFile = Object.create(null) as StructuralIndex["referenceNamesByFile"];
    resolvedFiles = Object.keys(contributions).length;
    for (const contribution of Object.values(contributions)) {
      addReferenceFile(contribution, referenceFilesByName, referenceNamesByFile);
    }
  } else if (contributionsChanged) {
    referenceFilesByName = { ...previous.referenceFilesByName };
    referenceNamesByFile = { ...previous.referenceNamesByFile };
    const touchedNames = new Set<string>();
    let fileSetChanged = removedFiles > 0;
    for (const path of changedPaths) {
      const before = previous.contributions[path];
      const after = contributions[path];
      if (before === undefined || after === undefined) fileSetChanged = true;
      for (const name of changedDefinitionNames(before, after)) touchedNames.add(name);
    }

    const affectedPaths = new Set(changedPaths);
    for (const name of touchedNames) {
      for (const path of recordedStrings(previous.referenceFilesByName, name)) {
        affectedPaths.add(path);
      }
    }
    if (fileSetChanged) {
      for (const path of previous.referenceFilesByName.__imports__ ?? []) affectedPaths.add(path);
    }

    for (const path of changedPaths) {
      removeReferenceFile(path, referenceFilesByName, referenceNamesByFile);
      const contribution = contributions[path];
      if (contribution !== undefined) {
        addReferenceFile(contribution, referenceFilesByName, referenceNamesByFile);
      }
    }
    for (const name of touchedNames) {
      for (const path of recordedStrings(referenceFilesByName, name)) affectedPaths.add(path);
    }
    if (fileSetChanged) {
      for (const path of referenceFilesByName.__imports__ ?? []) affectedPaths.add(path);
    }

    const oldReferenceIds = new Set<string>();
    for (const path of affectedPaths) {
      for (const reference of previous.contributions[path]?.references ?? []) {
        oldReferenceIds.add(reference.id);
      }
    }
    const currentAffectedPaths = new Set(
      [...affectedPaths].filter((path) => contributions[path] !== undefined),
    );
    const partial = resolveStructuralGraph(contributions, currentAffectedPaths);
    resolvedFiles = currentAffectedPaths.size;
    const edgeMap = new Map(
      previous.edges
        .filter((edge) => !oldReferenceIds.has(edge.referenceId))
        .map((edge) => [edge.id, edge]),
    );
    for (const edge of partial.edges) edgeMap.set(edge.id, edge);
    edges = [...edgeMap.values()].sort((left, right) => left.id.localeCompare(right.id));

    resolutionByFile = { ...previous.resolutionByFile };
    for (const path of affectedPaths) delete resolutionByFile[path];
    Object.assign(resolutionByFile, partial.metricsByFile);
    resolution = aggregateResolution(resolutionByFile);
  } else {
    edges = previous.edges;
    resolution = previous.resolution;
    resolutionByFile = previous.resolutionByFile;
    referenceFilesByName = previous.referenceFilesByName;
    referenceNamesByFile = previous.referenceNamesByFile;
  }
  const index: StructuralIndex = {
    schemaVersion: STRUCTURAL_SCHEMA_VERSION,
    discoveryMode: scan.discoveryMode,
    repositoryRevision: repositoryState?.revision ?? null,
    untrackedPaths: (repositoryState?.untrackedPaths ?? [])
      .filter((path) => contributions[path] !== undefined),
    contributions,
    edges,
    resolution,
    resolutionByFile,
    referenceFilesByName,
    referenceNamesByFile,
    extractorFingerprint: EXTRACTOR_FINGERPRINT,
  };
  const repositoryStateChanged = previous?.repositoryRevision !== index.repositoryRevision ||
    JSON.stringify(previous?.untrackedPaths ?? []) !== JSON.stringify(index.untrackedPaths);
  if (
    contributionsChanged ||
    metadataChanged ||
    repositoryStateChanged ||
    previous?.discoveryMode !== scan.discoveryMode
  ) {
    await saveStructuralIndex(absoluteRoot, index);
  }

  const values = Object.values(contributions);
  return {
    index,
    metrics: {
      discoveryMode: scan.discoveryMode,
      filesDiscovered: scan.files.length,
      filesSupported,
      parsedFiles,
      reusedFiles,
      removedFiles,
      resolvedFiles,
      symbols: values.reduce((total, contribution) => total + contribution.symbols.length, 0),
      references: values.reduce((total, contribution) => total + contribution.references.length, 0),
      diagnostics: values.reduce((total, contribution) => total + contribution.diagnostics.length, 0),
      diagnosticFiles: values.filter((contribution) => contribution.diagnostics.length > 0).length,
      edges: edges.length,
      ...resolution,
      durationMs: Number((performance.now() - started).toFixed(3)),
    },
  };
}

export async function loadOrBuildStructuralIndex(
  root: string,
  refresh = false,
): Promise<StructuralBuildResult> {
  if (refresh) return buildStructuralIndex(root);
  const index = await loadStructuralIndex(root);
  if (index === null) return buildStructuralIndex(root);
  const values = Object.values(index.contributions);
  return {
    index,
    metrics: {
      discoveryMode: index.discoveryMode,
      filesDiscovered: values.length,
      filesSupported: values.length,
      parsedFiles: 0,
      reusedFiles: values.length,
      removedFiles: 0,
      resolvedFiles: 0,
      symbols: values.reduce((total, contribution) => total + contribution.symbols.length, 0),
      references: values.reduce((total, contribution) => total + contribution.references.length, 0),
      diagnostics: values.reduce((total, contribution) => total + contribution.diagnostics.length, 0),
      diagnosticFiles: values.filter((contribution) => contribution.diagnostics.length > 0).length,
      edges: index.edges.length,
      ...index.resolution,
      durationMs: 0,
    },
  };
}

export async function ensureStructuralIndex(
  root: string,
  refresh = false,
  repairStale = true,
): Promise<StructuralBuildResult> {
  const built = await loadOrBuildStructuralIndex(root, refresh);
  if (!refresh && repairStale && built.index.discoveryMode === "filesystem") {
    return buildStructuralIndex(root);
  }
  if (!refresh && repairStale && await hasStaleContribution(root, built.index)) {
    return buildStructuralIndex(root);
  }
  return built;
}

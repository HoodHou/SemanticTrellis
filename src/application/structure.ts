import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  STRUCTURAL_SCHEMA_VERSION,
  type FileContribution,
  type StructuralBuildResult,
  type StructuralIndex,
} from "../domain/structural.js";
import { loadConfig } from "../infrastructure/project-store.js";
import { scanRepositoryDetailed } from "../infrastructure/repository-scanner.js";
import { loadStructuralIndex, saveStructuralIndex } from "../infrastructure/structural-store.js";
import { resolveStructuralEdges } from "../structural/resolver.js";

export async function buildStructuralIndex(root: string): Promise<StructuralBuildResult> {
  const started = performance.now();
  const absoluteRoot = resolve(root);
  const config = await loadConfig(absoluteRoot);
  const scan = await scanRepositoryDetailed(absoluteRoot, config.source);
  const previous = await loadStructuralIndex(absoluteRoot);
  // Compiler-backed adapters are intentionally loaded only for a real refresh.
  // Read-only cached grep/trace processes should not pay the TypeScript Compiler
  // API startup cost.
  const { createDefaultLanguageRegistry } = await import("../structural/registry.js");
  const registry = createDefaultLanguageRegistry();
  const contributions: Record<string, FileContribution> = {};
  let filesSupported = 0;
  let parsedFiles = 0;
  let reusedFiles = 0;

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
      contributions[file.path] = prior;
      reusedFiles += 1;
      continue;
    }
    const source = await readFile(resolve(absoluteRoot, file.path), "utf8");
    contributions[file.path] = adapter.extract({
      path: file.path,
      hash: file.hash,
      source,
    });
    parsedFiles += 1;
  }

  const edges = resolveStructuralEdges(contributions);
  const index: StructuralIndex = {
    schemaVersion: STRUCTURAL_SCHEMA_VERSION,
    discoveryMode: scan.discoveryMode,
    contributions,
    edges,
  };
  await saveStructuralIndex(absoluteRoot, index);

  const previousPaths = new Set(Object.keys(previous?.contributions ?? {}));
  for (const path of Object.keys(contributions)) previousPaths.delete(path);
  const values = Object.values(contributions);
  return {
    index,
    metrics: {
      discoveryMode: scan.discoveryMode,
      filesDiscovered: scan.files.length,
      filesSupported,
      parsedFiles,
      reusedFiles,
      removedFiles: previousPaths.size,
      symbols: values.reduce((total, contribution) => total + contribution.symbols.length, 0),
      references: values.reduce((total, contribution) => total + contribution.references.length, 0),
      diagnostics: values.reduce((total, contribution) => total + contribution.diagnostics.length, 0),
      diagnosticFiles: values.filter((contribution) => contribution.diagnostics.length > 0).length,
      edges: edges.length,
      durationMs: Number((performance.now() - started).toFixed(3)),
    },
  };
}

export async function loadOrBuildStructuralIndex(
  root: string,
  refresh = true,
): Promise<StructuralBuildResult> {
  if (refresh) return buildStructuralIndex(root);
  const index = await loadStructuralIndex(root);
  if (index === null) throw new Error("No structural index exists. Run `strellis structure` first.");
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
      symbols: values.reduce((total, contribution) => total + contribution.symbols.length, 0),
      references: values.reduce((total, contribution) => total + contribution.references.length, 0),
      diagnostics: values.reduce((total, contribution) => total + contribution.diagnostics.length, 0),
      diagnosticFiles: values.filter((contribution) => contribution.diagnostics.length > 0).length,
      edges: index.edges.length,
      durationMs: 0,
    },
  };
}

import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createDefaultConfig } from "../domain/config.js";
import { createEmptyGraph } from "../domain/graph.js";
import type { ProjectConfig } from "../domain/model.js";
import {
  ensureLocalStateIgnored,
  fileExists,
  loadConfig,
  loadGraph,
  saveConfig,
  saveGraph,
} from "../infrastructure/project-store.js";
import { projectLayout } from "../infrastructure/layout.js";

export interface InitializeResult {
  root: string;
  projectId: string;
  createdConfig: boolean;
  createdGraph: boolean;
}

export async function initializeProject(root: string): Promise<InitializeResult> {
  const absoluteRoot = resolve(root);
  const rootStat = await stat(absoluteRoot);
  if (!rootStat.isDirectory()) throw new Error(`Project root is not a directory: ${absoluteRoot}`);

  const layout = projectLayout(absoluteRoot);
  const hasConfig = await fileExists(layout.configFile);
  const hasGraph = await fileExists(layout.graphFile);
  let config: ProjectConfig;

  if (hasConfig) {
    config = await loadConfig(absoluteRoot);
  } else {
    config = createDefaultConfig(basename(absoluteRoot));
    await saveConfig(absoluteRoot, config);
  }

  if (hasGraph) {
    const graph = await loadGraph(absoluteRoot);
    if (graph.projectId !== config.projectId) {
      throw new Error(
        `Project identity mismatch: config=${config.projectId}, graph=${graph.projectId}`,
      );
    }
  } else {
    await saveGraph(absoluteRoot, createEmptyGraph(config.projectId));
  }

  await ensureLocalStateIgnored(absoluteRoot);
  return {
    root: absoluteRoot,
    projectId: config.projectId,
    createdConfig: !hasConfig,
    createdGraph: !hasGraph,
  };
}

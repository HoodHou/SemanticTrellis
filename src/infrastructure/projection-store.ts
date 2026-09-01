import {
  PROJECTION_INDEX_SCHEMA_VERSION,
  type ProjectionIndex,
} from "../domain/projection.js";
import { readJsonFileOrNull, writeJsonFile } from "./json-store.js";
import { projectLayout } from "./layout.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function loadProjectionIndex(root: string): Promise<ProjectionIndex | null> {
  const value = await readJsonFileOrNull(projectLayout(root).projectionIndexFile);
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== PROJECTION_INDEX_SCHEMA_VERSION) return null;
  if (value.discoveryMode !== "git" && value.discoveryMode !== "filesystem") return null;
  if (value.repositoryRevision !== null && typeof value.repositoryRevision !== "string") return null;
  if (!Array.isArray(value.sources) || !Array.isArray(value.projections)) return null;
  return value as unknown as ProjectionIndex;
}

export async function saveProjectionIndex(root: string, index: ProjectionIndex): Promise<void> {
  await writeJsonFile(projectLayout(root).projectionIndexFile, index);
}

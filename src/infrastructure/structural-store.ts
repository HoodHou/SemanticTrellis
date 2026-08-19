import {
  STRUCTURAL_SCHEMA_VERSION,
  type StructuralIndex,
} from "../domain/structural.js";
import { stat } from "node:fs/promises";
import { readJsonFileOrNull, writeJsonFile } from "./json-store.js";
import { projectLayout } from "./layout.js";

interface CachedIndex {
  size: number;
  mtimeMs: number;
  index: StructuralIndex;
}

const indexCache = new Map<string, CachedIndex>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function loadStructuralIndex(root: string): Promise<StructuralIndex | null> {
  const path = projectLayout(root).structuralIndexFile;
  let fileStat;
  try {
    fileStat = await stat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      indexCache.delete(path);
      return null;
    }
    throw error;
  }
  const cached = indexCache.get(path);
  if (cached?.size === fileStat.size && cached.mtimeMs === fileStat.mtimeMs) {
    return cached.index;
  }
  const value = await readJsonFileOrNull(path);
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== STRUCTURAL_SCHEMA_VERSION) return null;
  if (value.discoveryMode !== "git" && value.discoveryMode !== "filesystem") return null;
  if (!isRecord(value.contributions) || !Array.isArray(value.edges)) return null;
  const index = value as unknown as StructuralIndex;
  indexCache.set(path, { size: fileStat.size, mtimeMs: fileStat.mtimeMs, index });
  return index;
}

export async function saveStructuralIndex(root: string, index: StructuralIndex): Promise<void> {
  const path = projectLayout(root).structuralIndexFile;
  await writeJsonFile(path, index);
  const fileStat = await stat(path);
  indexCache.set(path, { size: fileStat.size, mtimeMs: fileStat.mtimeMs, index });
}

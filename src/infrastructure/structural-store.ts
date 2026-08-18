import {
  STRUCTURAL_SCHEMA_VERSION,
  type StructuralIndex,
} from "../domain/structural.js";
import { readJsonFileOrNull, writeJsonFile } from "./json-store.js";
import { projectLayout } from "./layout.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function loadStructuralIndex(root: string): Promise<StructuralIndex | null> {
  const value = await readJsonFileOrNull(projectLayout(root).structuralIndexFile);
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== STRUCTURAL_SCHEMA_VERSION) return null;
  if (value.discoveryMode !== "git" && value.discoveryMode !== "filesystem") return null;
  if (!isRecord(value.contributions) || !Array.isArray(value.edges)) return null;
  return value as unknown as StructuralIndex;
}

export async function saveStructuralIndex(root: string, index: StructuralIndex): Promise<void> {
  await writeJsonFile(projectLayout(root).structuralIndexFile, index);
}

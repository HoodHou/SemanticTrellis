import {
  SCHEMA_VERSION,
  type FileChange,
  type FileRecord,
  type RepositorySnapshot,
} from "./model.js";

export function createSnapshot(files: FileRecord[]): RepositorySnapshot {
  return {
    schemaVersion: SCHEMA_VERSION,
    files: [...files].sort((left, right) => left.path.localeCompare(right.path)),
  };
}

export function diffSnapshots(
  previous: RepositorySnapshot,
  current: RepositorySnapshot,
): FileChange[] {
  const beforeByPath = new Map(previous.files.map((file) => [file.path, file]));
  const afterByPath = new Map(current.files.map((file) => [file.path, file]));
  const paths = new Set([...beforeByPath.keys(), ...afterByPath.keys()]);
  const changes: FileChange[] = [];

  for (const path of [...paths].sort()) {
    const before = beforeByPath.get(path) ?? null;
    const after = afterByPath.get(path) ?? null;

    if (before === null && after !== null) {
      changes.push({ kind: "added", path, before, after });
      continue;
    }
    if (before !== null && after === null) {
      changes.push({ kind: "removed", path, before, after });
      continue;
    }
    if (before !== null && after !== null && before.hash !== after.hash) {
      changes.push({ kind: "changed", path, before, after });
    }
  }

  return changes;
}

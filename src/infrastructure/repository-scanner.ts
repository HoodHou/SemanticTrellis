import { createHash } from "node:crypto";
import { opendir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import type { FileRecord, SourcePolicy } from "../domain/model.js";

interface Candidate {
  absolutePath: string;
  relativePath: string;
  size: number;
}

function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

async function collectCandidates(
  root: string,
  directory: string,
  policy: SourcePolicy,
  candidates: Candidate[],
): Promise<void> {
  const excluded = new Set(policy.excludeDirectories.map((name) => name.toLowerCase()));
  const extensions = new Set(policy.extensions.map((extension) => extension.toLowerCase()));
  const entries = await opendir(directory);

  for await (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (excluded.has(entry.name.toLowerCase())) continue;
      await collectCandidates(root, absolutePath, policy, candidates);
      continue;
    }
    if (!entry.isFile() || !extensions.has(extname(entry.name).toLowerCase())) continue;

    const fileStat = await stat(absolutePath);
    if (fileStat.size > policy.maxFileBytes) continue;
    candidates.push({
      absolutePath,
      relativePath: toPosixPath(relative(root, absolutePath)),
      size: fileStat.size,
    });
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  transform: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        const value = values[index];
        if (value !== undefined) results[index] = await transform(value);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export async function scanRepository(
  root: string,
  policy: SourcePolicy,
): Promise<FileRecord[]> {
  const absoluteRoot = resolve(root);
  const rootStat = await stat(absoluteRoot);
  if (!rootStat.isDirectory()) throw new Error(`Repository root is not a directory: ${absoluteRoot}`);

  const candidates: Candidate[] = [];
  await collectCandidates(absoluteRoot, absoluteRoot, policy, candidates);
  candidates.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  return mapWithConcurrency(candidates, 16, async (candidate) => {
    const bytes = await readFile(candidate.absolutePath);
    return {
      path: candidate.relativePath,
      hash: createHash("sha256").update(bytes).digest("hex"),
      size: candidate.size,
    };
  });
}

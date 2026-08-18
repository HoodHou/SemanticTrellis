import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, opendir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { FileRecord, SourcePolicy } from "../domain/model.js";

const execFileAsync = promisify(execFile);

interface Candidate {
  absolutePath: string;
  relativePath: string;
  size: number;
}

function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function excludedDirectories(policy: SourcePolicy): Set<string> {
  return new Set(policy.excludeDirectories.map((name) => name.toLowerCase()));
}

function pathAllowed(relativePath: string, policy: SourcePolicy): boolean {
  const segments = toPosixPath(relativePath).split("/");
  const excluded = excludedDirectories(policy);
  if (segments.some((segment) => excluded.has(segment.toLowerCase()))) return false;
  const extensions = new Set(policy.extensions.map((extension) => extension.toLowerCase()));
  return extensions.has(extname(relativePath).toLowerCase());
}

async function gitVisiblePaths(root: string): Promise<string[] | null> {
  try {
    const result = await execFileAsync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--"],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
    );
    return result.stdout.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

async function collectGitCandidates(
  root: string,
  paths: string[],
  policy: SourcePolicy,
): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  for (const gitPath of paths) {
    const relativePath = toPosixPath(gitPath);
    if (!pathAllowed(relativePath, policy)) continue;
    const absolutePath = resolve(root, gitPath);
    if (absolutePath !== root && !absolutePath.startsWith(rootPrefix)) continue;
    try {
      const fileStat = await lstat(absolutePath);
      if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > policy.maxFileBytes) {
        continue;
      }
      candidates.push({ absolutePath, relativePath, size: fileStat.size });
    } catch {
      // A tracked file deleted in the worktree is still returned by --cached.
    }
  }
  return candidates;
}

async function collectCandidates(
  root: string,
  directory: string,
  policy: SourcePolicy,
  candidates: Candidate[],
): Promise<void> {
  const entries = await opendir(directory);

  for await (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (excludedDirectories(policy).has(entry.name.toLowerCase())) continue;
      await collectCandidates(root, absolutePath, policy, candidates);
      continue;
    }
    if (!entry.isFile()) continue;
    const relativePath = toPosixPath(relative(root, absolutePath));
    if (!pathAllowed(relativePath, policy)) continue;

    const fileStat = await stat(absolutePath);
    if (fileStat.size > policy.maxFileBytes) continue;
    candidates.push({
      absolutePath,
      relativePath,
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

export interface RepositoryScan {
  discoveryMode: "git" | "filesystem";
  files: FileRecord[];
}

export async function scanRepositoryDetailed(
  root: string,
  policy: SourcePolicy,
): Promise<RepositoryScan> {
  const absoluteRoot = resolve(root);
  const rootStat = await stat(absoluteRoot);
  if (!rootStat.isDirectory()) throw new Error(`Repository root is not a directory: ${absoluteRoot}`);

  const gitPaths = await gitVisiblePaths(absoluteRoot);
  const candidates = gitPaths === null
    ? []
    : await collectGitCandidates(absoluteRoot, gitPaths, policy);
  if (gitPaths === null) {
    await collectCandidates(absoluteRoot, absoluteRoot, policy, candidates);
  }
  candidates.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  const files = await mapWithConcurrency(candidates, 16, async (candidate) => {
    const bytes = await readFile(candidate.absolutePath);
    return {
      path: candidate.relativePath,
      hash: createHash("sha256").update(bytes).digest("hex"),
      size: candidate.size,
    };
  });
  return { discoveryMode: gitPaths === null ? "filesystem" : "git", files };
}

export async function scanRepository(
  root: string,
  policy: SourcePolicy,
): Promise<FileRecord[]> {
  return (await scanRepositoryDetailed(root, policy)).files;
}

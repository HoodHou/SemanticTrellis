import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, opendir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { FileRecord, SourcePolicy } from "../domain/model.js";
import { decodeSourceText } from "./text-decoder.js";

const execFileAsync = promisify(execFile);

interface Candidate {
  absolutePath: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
}

function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function excludedDirectories(policy: SourcePolicy): Set<string> {
  return new Set(policy.excludeDirectories.map((name) => name.toLowerCase()));
}

function directoryAllowed(relativePath: string, policy: SourcePolicy): boolean {
  const segments = toPosixPath(relativePath).split("/");
  const excluded = excludedDirectories(policy);
  return !segments.some((segment) => excluded.has(segment.toLowerCase()));
}

function extensionAllowed(relativePath: string, policy: SourcePolicy): boolean {
  const extensions = new Set(policy.extensions.map((extension) => extension.toLowerCase()));
  return extensions.has(extname(relativePath).toLowerCase());
}

function sourceAllowed(candidate: Candidate, policy: SourcePolicy): boolean {
  return extensionAllowed(candidate.relativePath, policy) && candidate.size <= policy.maxFileBytes;
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
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  const candidates = await mapWithConcurrency(paths, 32, async (gitPath): Promise<Candidate | null> => {
    const relativePath = toPosixPath(gitPath);
    if (!directoryAllowed(relativePath, policy)) return null;
    const absolutePath = resolve(root, gitPath);
    if (absolutePath !== root && !absolutePath.startsWith(rootPrefix)) return null;
    try {
      const fileStat = await lstat(absolutePath);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
        return null;
      }
      return {
        absolutePath,
        relativePath,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
      };
    } catch {
      // A tracked file deleted in the worktree is still returned by --cached.
      return null;
    }
  });
  return candidates.filter((candidate): candidate is Candidate => candidate !== null);
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
    if (!directoryAllowed(relativePath, policy)) continue;

    const fileStat = await stat(absolutePath);
    candidates.push({
      absolutePath,
      relativePath,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
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
  sources: Record<string, string>;
}

export interface RepositoryInventoryArtifact {
  path: string;
  size: number;
  mtimeMs: number;
  extension: string;
  eligible: boolean;
  reasons: Array<"unsupported-extension" | "file-too-large">;
}

export interface RepositoryInventory {
  discoveryMode: "git" | "filesystem";
  artifacts: RepositoryInventoryArtifact[];
}

export interface RepositoryScanOptions {
  previousFiles?: readonly FileRecord[] | undefined;
  captureSource?: ((path: string) => boolean) | undefined;
  forceHash?: boolean | ReadonlySet<string> | undefined;
}

function mustHash(path: string, option: RepositoryScanOptions["forceHash"]): boolean {
  if (option === true) return true;
  if (option === false || option === undefined) return false;
  return option.has(path);
}

async function discoverCandidates(
  root: string,
  policy: SourcePolicy,
): Promise<{ discoveryMode: "git" | "filesystem"; candidates: Candidate[] }> {
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
  return {
    discoveryMode: gitPaths === null ? "filesystem" : "git",
    candidates,
  };
}

export async function scanRepositoryInventory(
  root: string,
  policy: SourcePolicy,
): Promise<RepositoryInventory> {
  const discovered = await discoverCandidates(root, policy);
  return {
    discoveryMode: discovered.discoveryMode,
    artifacts: discovered.candidates.map((candidate) => {
      const reasons: RepositoryInventoryArtifact["reasons"] = [];
      if (!extensionAllowed(candidate.relativePath, policy)) reasons.push("unsupported-extension");
      if (candidate.size > policy.maxFileBytes) reasons.push("file-too-large");
      const extension = extname(candidate.relativePath).toLowerCase();
      return {
        path: candidate.relativePath,
        size: candidate.size,
        mtimeMs: candidate.mtimeMs,
        extension: extension || "(none)",
        eligible: reasons.length === 0,
        reasons,
      };
    }),
  };
}

export async function scanRepositoryDetailed(
  root: string,
  policy: SourcePolicy,
  options: RepositoryScanOptions = {},
): Promise<RepositoryScan> {
  const absoluteRoot = resolve(root);
  const discovered = await discoverCandidates(absoluteRoot, policy);
  const candidates = discovered.candidates.filter((candidate) => sourceAllowed(candidate, policy));

  const previousByPath = new Map(
    (options.previousFiles ?? []).map((file) => [file.path, file]),
  );
  const sources: Record<string, string> = {};
  const files = await mapWithConcurrency(candidates, 16, async (candidate) => {
    const previous = previousByPath.get(candidate.relativePath);
    if (
      !mustHash(candidate.relativePath, options.forceHash) &&
      previous !== undefined &&
      previous.mtimeMs !== undefined &&
      previous.size === candidate.size &&
      previous.mtimeMs === candidate.mtimeMs
    ) {
      return {
        path: candidate.relativePath,
        hash: previous.hash,
        size: candidate.size,
        mtimeMs: candidate.mtimeMs,
      };
    }
    const bytes = await readFile(candidate.absolutePath);
    if (options.captureSource?.(candidate.relativePath) === true) {
      sources[candidate.relativePath] = decodeSourceText(bytes, candidate.relativePath);
    }
    return {
      path: candidate.relativePath,
      hash: createHash("sha256").update(bytes).digest("hex"),
      size: candidate.size,
      mtimeMs: candidate.mtimeMs,
    };
  });
  return {
    discoveryMode: discovered.discoveryMode,
    files,
    sources,
  };
}

export async function scanRepository(
  root: string,
  policy: SourcePolicy,
  options: RepositoryScanOptions = {},
): Promise<FileRecord[]> {
  return (await scanRepositoryDetailed(root, policy, options)).files;
}

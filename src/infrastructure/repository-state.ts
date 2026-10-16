import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitRepositoryState {
  revision: string;
  changedPaths: string[];
  untrackedPaths: string[];
}

function paths(value: string): string[] {
  return value
    .split("\0")
    .filter(Boolean)
    .map((path) => path.replace(/\\/g, "/"));
}

async function git(root: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", ["--no-optional-locks", ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })).stdout;
}

export function parseGitPorcelain(stdout: string): GitRepositoryState {
  const records = stdout.split("\0").map((record) => record.replace(/\r?\n$/, "")).filter(Boolean);
  let revision = "UNBORN";
  const changed = new Set<string>();
  const untracked = new Set<string>();
  for (const record of records) {
    if (record.startsWith("# branch.oid ")) {
      const oid = record.slice("# branch.oid ".length).trim();
      revision = /^[0-9a-f]{40,64}$/i.test(oid) && !/^0+$/.test(oid) ? oid : "UNBORN";
      continue;
    }
    if (record.startsWith("#")) continue;
    if (record.startsWith("? ")) {
      const path = record.slice(2).replace(/\\/g, "/");
      untracked.add(path);
      changed.add(path);
      continue;
    }
    if (record.startsWith("1 ") || record.startsWith("2 ") || record.startsWith("u ")) {
      changed.add(pathFromPorcelainRecord(record));
      continue;
    }
    changed.add(record.replace(/\\/g, "/"));
  }
  return {
    revision,
    changedPaths: [...changed].sort(),
    untrackedPaths: [...untracked].sort(),
  };
}

function pathFromPorcelainRecord(record: string): string {
  const fieldCount = record.startsWith("2 ") ? 9 : 8;
  let spaces = 0;
  for (let index = 0; index < record.length; index += 1) {
    if (record[index] !== " ") continue;
    spaces += 1;
    if (spaces === fieldCount) return record.slice(index + 1).replace(/\\/g, "/");
  }
  return record.slice(record.lastIndexOf(" ") + 1).replace(/\\/g, "/");
}

export async function readGitRepositoryState(root: string): Promise<GitRepositoryState | null> {
  try {
    return parseGitPorcelain(await git(root, [
      "status",
      "--porcelain=v2",
      "--branch",
      "-z",
      "-uall",
    ]));
  } catch {
    return null;
  }
}

export async function readGitRevisionChanges(
  root: string,
  beforeRevision: string,
  afterRevision: string,
): Promise<string[] | null> {
  if (!/^[a-f0-9]{40,64}$/i.test(beforeRevision) || !/^[a-f0-9]{40,64}$/i.test(afterRevision)) {
    return null;
  }
  try {
    return [...new Set(paths(await git(root, [
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      beforeRevision,
      afterRevision,
      "--",
    ])))].sort();
  } catch {
    return null;
  }
}

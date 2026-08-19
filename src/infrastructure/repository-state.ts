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
  return (await execFileAsync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })).stdout;
}

export async function readGitRepositoryState(root: string): Promise<GitRepositoryState | null> {
  try {
    const [revision, unstaged, staged, deleted, untracked] = await Promise.all([
      git(root, ["rev-parse", "HEAD"]).catch(() => "UNBORN\n"),
      git(root, ["diff", "--no-renames", "--name-only", "-z", "--"]),
      git(root, ["diff", "--cached", "--no-renames", "--name-only", "-z", "--"]),
      git(root, ["ls-files", "--deleted", "-z", "--"]),
      git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--"]),
    ]);
    const untrackedPaths = [...new Set(paths(untracked))].sort();
    return {
      revision: revision.trim(),
      changedPaths: [...new Set([
        ...paths(unstaged),
        ...paths(staged),
        ...paths(deleted),
        ...untrackedPaths,
      ])].sort(),
      untrackedPaths,
    };
  } catch {
    return null;
  }
}

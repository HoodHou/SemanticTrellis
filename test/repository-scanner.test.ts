import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/domain/config.js";
import { scanRepositoryDetailed } from "../src/infrastructure/repository-scanner.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  })));
});

describe("repository scanner", () => {
  it("uses Git visibility while retaining tracked files that later match ignore rules", async () => {
    const root = await mkdtemp(join(tmpdir(), "semantic-trellis-git-scan-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "src"));
    await execFileAsync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });

    await writeFile(join(root, "src", "tracked.ts"), "export const tracked = true;\n", "utf8");
    await execFileAsync("git", ["add", "src/tracked.ts"], { cwd: root, windowsHide: true });
    await writeFile(join(root, "src", "visible.ts"), "export const visible = true;\n", "utf8");
    await writeFile(join(root, "src", "ignored.ts"), "export const ignored = true;\n", "utf8");
    await writeFile(join(root, ".gitignore"), "src/ignored.ts\nsrc/tracked.ts\n", "utf8");

    const result = await scanRepositoryDetailed(root, createDefaultConfig("fixture").source);

    expect(result.discoveryMode).toBe("git");
    expect(result.files.map((file) => file.path)).toEqual([
      "src/tracked.ts",
      "src/visible.ts",
    ]);
  });

  it("reuses stat-stable hashes and rehashes a same-size changed file", async () => {
    const root = await mkdtemp(join(tmpdir(), "semantic-trellis-stat-scan-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "src"));
    await execFileAsync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
    await writeFile(join(root, "src", "value.ts"), "export const value = 1;\n", "utf8");
    const policy = createDefaultConfig("fixture").source;

    const first = await scanRepositoryDetailed(root, policy);
    const warm = await scanRepositoryDetailed(root, policy, { previousFiles: first.files });
    expect(warm.files).toEqual(first.files);

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    await writeFile(join(root, "src", "value.ts"), "export const value = 2;\n", "utf8");
    const changed = await scanRepositoryDetailed(root, policy, { previousFiles: warm.files });
    expect(changed.files[0]?.size).toBe(warm.files[0]?.size);
    expect(changed.files[0]?.hash).not.toBe(warm.files[0]?.hash);

    const currentStat = await stat(join(root, "src", "value.ts"));
    const misleadingHint = [{
      ...first.files[0]!,
      size: currentStat.size,
      mtimeMs: currentStat.mtimeMs,
    }];
    const forced = await scanRepositoryDetailed(root, policy, {
      previousFiles: misleadingHint,
      forceHash: new Set(["src/value.ts"]),
    });
    expect(forced.files[0]?.hash).toBe(changed.files[0]?.hash);
    expect(forced.files[0]?.hash).not.toBe(first.files[0]?.hash);
  });
});

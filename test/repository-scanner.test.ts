import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/domain/config.js";
import { scanRepositoryDetailed } from "../src/infrastructure/repository-scanner.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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
});

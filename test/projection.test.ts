import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  getProjectionStatus,
  initializeProject,
  listUnsupportedArtifacts,
  previewAgentBootstrap,
  registerArtifactProjection,
  startAgentBootstrap,
  validateArtifactProjection,
} from "../src/application/index.js";
import { digestBytes } from "../src/infrastructure/digest.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "semantic-trellis-projection-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "design"));
  await mkdir(join(root, "docs"));
  await mkdir(join(root, "node_modules"));
  await execFileAsync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
  await writeFile(join(root, "docs", "guide.md"), "# Guide\n", "utf8");
  await writeFile(join(root, "design", "battle.xlsx"), Buffer.from("PK-battle-v1"));
  await writeFile(join(root, "design", "items.bin"), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(root, "ignored.dat"), "ignored", "utf8");
  await writeFile(join(root, "node_modules", "dependency.bin"), "dependency", "utf8");
  await writeFile(join(root, ".gitignore"), "ignored.dat\n", "utf8");
  await initializeProject(root);
  return root;
}

function jsonProjection(sourcePath: string, sourceSha256: string, marker: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind: "semantic-trellis-projection",
    source: {
      path: sourcePath,
      sha256: sourceSha256,
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
    producer: { tool: "fixture-workbook-reader", version: "1.0.0" },
    omissions: [],
    warnings: [],
    content: {
      sheets: [{ name: "Battle", rows: [{ id: 1, marker }] }],
    },
  });
}

function markdownProjection(sourcePath: string, sourceSha256: string): string {
  return `<!-- semantic-trellis-projection
${JSON.stringify({
    schemaVersion: 1,
    kind: "semantic-trellis-projection",
    source: {
      path: sourcePath,
      sha256: sourceSha256,
      mediaType: "application/octet-stream",
    },
    producer: { tool: "fixture-binary-reader", version: "1.0.0" },
    omissions: ["embedded preview image"],
    warnings: [],
  }, null, 2)}
-->
# Items

The fixture contains four bytes.
`;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  })));
});

describe("artifact projection pipeline", () => {
  it("discovers every visible unsupported artifact and registers both projection formats", async () => {
    const root = await fixture();
    const unsupported = await listUnsupportedArtifacts(root, 0, 100);
    expect(unsupported.items.map((item) => item.path)).toEqual([
      ".gitignore",
      "design/battle.xlsx",
      "design/items.bin",
    ]);
    expect(unsupported.total).toBe(3);
    expect(unsupported.returned / unsupported.total).toBe(1);
    expect(unsupported.items.every((item) => item.state === "unprojected")).toBe(true);
    expect(unsupported.items.some((item) => item.path === "ignored.dat")).toBe(false);
    expect(unsupported.items.some((item) => item.path.includes("node_modules"))).toBe(false);

    const preview = await previewAgentBootstrap(root);
    expect(preview.unsupported).toMatchObject({
      totalFiles: 3,
      returned: 3,
      truncated: false,
      unprojected: 3,
    });

    const battle = unsupported.items.find((item) => item.path === "design/battle.xlsx")!;
    const battleContent = jsonProjection(battle.path, battle.sha256, "v1");
    const battleValidation = await validateArtifactProjection(
      root,
      "design/battle.xlsx.strellis.json",
      battleContent,
    );
    expect(battleValidation).toMatchObject({
      sourcePath: battle.path,
      sourceSha256: battle.sha256,
      format: "json",
      existingProjectionSha256: null,
    });
    await registerArtifactProjection(
      root,
      battleValidation.projectionPath,
      battleContent,
      battleValidation.validationToken,
    );

    const items = unsupported.items.find((item) => item.path === "design/items.bin")!;
    const itemsContent = markdownProjection(items.path, items.sha256);
    const itemsValidation = await validateArtifactProjection(
      root,
      "design/items.bin.strellis.md",
      itemsContent,
    );
    await registerArtifactProjection(
      root,
      itemsValidation.projectionPath,
      itemsContent,
      itemsValidation.validationToken,
    );

    const storedJson = await readFile(
      join(root, "design", "battle.xlsx.strellis.json"),
      "utf8",
    );
    expect(storedJson.endsWith("\n")).toBe(true);
    expect(JSON.parse(storedJson)).toMatchObject({
      schemaVersion: 1,
      source: { path: battle.path, sha256: battle.sha256 },
    });
    const status = await getProjectionStatus(root, 0, 100);
    expect(status.counts).toMatchObject({
      current: 2,
      stale: 0,
      invalid: 0,
      unprojected: 1,
      orphaned: 0,
    });
  });

  it("rejects stale registrations and invalidates only the changed source projection", async () => {
    const root = await fixture();
    const initial = await listUnsupportedArtifacts(root, 0, 100);
    const battle = initial.items.find((item) => item.path === "design/battle.xlsx")!;
    const items = initial.items.find((item) => item.path === "design/items.bin")!;

    const battleContent = jsonProjection(battle.path, battle.sha256, "v1");
    const battleValidation = await validateArtifactProjection(
      root,
      "design/battle.xlsx.strellis.json",
      battleContent,
    );
    await registerArtifactProjection(
      root,
      battleValidation.projectionPath,
      battleContent,
      battleValidation.validationToken,
    );
    const itemsContent = markdownProjection(items.path, items.sha256);
    const itemsValidation = await validateArtifactProjection(
      root,
      "design/items.bin.strellis.md",
      itemsContent,
    );
    await registerArtifactProjection(
      root,
      itemsValidation.projectionPath,
      itemsContent,
      itemsValidation.validationToken,
    );

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    await writeFile(join(root, "design", "battle.xlsx"), Buffer.from("PK-battle-v2"));
    const status = await getProjectionStatus(root, 0, 100);
    expect(status.counts).toMatchObject({ current: 1, stale: 1, invalid: 0 });
    expect(status.refresh).toMatchObject({
      hashedSources: 1,
      reusedSourceHashes: 2,
      parsedProjections: 0,
      reusedProjections: 2,
    });
    expect(status.items.find((item) => item.path === battle.path)?.state).toBe("stale");
    expect(status.items.find((item) => item.path === items.path)?.state).toBe("current");

    await expect(registerArtifactProjection(
      root,
      battleValidation.projectionPath,
      battleContent,
      battleValidation.validationToken,
    )).rejects.toThrow(/source hash is stale/);
    await expect(startAgentBootstrap(root, {
      sourceDisclosureApproved: true,
      maxChunkCharacters: 2_000,
    })).rejects.toThrow(/blocked by projection integrity/);

    const changedHash = digestBytes(Buffer.from("PK-battle-v2"));
    const changedContent = jsonProjection(battle.path, changedHash, "v2");
    const changedValidation = await validateArtifactProjection(
      root,
      battleValidation.projectionPath,
      changedContent,
    );
    await registerArtifactProjection(
      root,
      changedValidation.projectionPath,
      changedContent,
      changedValidation.validationToken,
    );
    expect((await getProjectionStatus(root, 0, 100)).counts.stale).toBe(0);
  });

  it("rejects malformed metadata, arbitrary targets, and changed target contents", async () => {
    const root = await fixture();
    const unsupported = await listUnsupportedArtifacts(root, 0, 100);
    const battle = unsupported.items.find((item) => item.path === "design/battle.xlsx")!;
    const content = jsonProjection(battle.path, battle.sha256, "v1");

    await expect(validateArtifactProjection(
      root,
      "design/arbitrary.strellis.json",
      content,
    )).rejects.toThrow(/Projection path must be design\/battle.xlsx.strellis.json/);
    await expect(validateArtifactProjection(
      root,
      "design/battle.xlsx.strellis.json",
      content.replace("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "invalid"),
    )).rejects.toThrow(/valid media type/);

    const validation = await validateArtifactProjection(
      root,
      "design/battle.xlsx.strellis.json",
      content,
    );
    await writeFile(
      join(root, "design", "battle.xlsx.strellis.json"),
      `${content}\n`,
      "utf8",
    );
    await expect(registerArtifactProjection(
      root,
      validation.projectionPath,
      content,
      validation.validationToken,
    )).rejects.toThrow(/token is invalid or stale/);
  });
});

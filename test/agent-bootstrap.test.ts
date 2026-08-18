import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyValidatedCurationPatch,
  bootstrapProject,
  finishAgentBootstrap,
  getAgentBootstrapStatus,
  getBootstrapCurationContext,
  getNextBootstrapRollups,
  getNextBootstrapSourceBatch,
  initializeProject,
  startAgentBootstrap,
  submitBootstrapChunkSummaries,
  submitBootstrapFileSummaries,
  validateCurationPatch,
} from "../src/application/index.js";
import { SCHEMA_VERSION, type GraphPatch } from "../src/domain/model.js";
import { digestJson } from "../src/infrastructure/digest.js";
import { loadGraph } from "../src/infrastructure/project-store.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "semantic-trellis-agent-bootstrap-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "src"));
  await execFileAsync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
  await writeFile(
    join(root, "src", "large.ts"),
    `export const large = "${"x".repeat(2_500)}";\n`,
    "utf8",
  );
  await writeFile(join(root, "src", "small.ts"), "export const small = true;\n", "utf8");
  await initializeProject(root);
  await bootstrapProject(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Agent-driven AI bootstrap", () => {
  it("requires explicit source-disclosure approval before returning source chunks", async () => {
    const root = await fixture();
    await startAgentBootstrap(root, {
      sourceDisclosureApproved: false,
      maxChunkCharacters: 2_000,
    });

    await expect(getNextBootstrapSourceBatch(root, 10_000, 10)).rejects.toThrow(
      /Source disclosure is not approved/,
    );
  });

  it("reviews every chunk, rolls up every file, completes curation, and reuses unchanged summaries", async () => {
    const root = await fixture();
    const started = await startAgentBootstrap(root, {
      sourceDisclosureApproved: true,
      maxChunkCharacters: 2_000,
    });
    expect(started.status).toMatchObject({
      stage: "summarize-chunks",
      totalFiles: 2,
      totalChunks: 3,
      summarizedChunks: 0,
    });

    const batch = await getNextBootstrapSourceBatch(root, 10_000, 10);
    expect(batch.units).toHaveLength(3);
    const chunkStatus = await submitBootstrapChunkSummaries(
      root,
      batch.sessionId,
      batch.units.map((unit) => ({
        unitId: unit.id,
        summary: `Summary for ${unit.path} chunk ${unit.chunkIndex}.`,
        keyFacts: [`lines ${unit.startLine}-${unit.endLine}`],
        risks: [],
        confidence: 0.9,
        producer: "test-agent",
        model: "test-model",
      })),
    );
    expect(chunkStatus.stage).toBe("summarize-files");
    expect(chunkStatus.chunkCoverage).toBe(1);

    const rollups = await getNextBootstrapRollups(root, 10);
    expect(rollups.files).toHaveLength(2);
    const fileStatus = await submitBootstrapFileSummaries(
      root,
      rollups.sessionId,
      rollups.files.map((file) => ({
        path: file.path,
        hash: file.hash,
        summary: `File-level summary for ${file.path}.`,
        responsibilities: ["fixture"],
        keySymbols: file.structural.symbols.map((symbol) => symbol.qualifiedName),
        dependencies: [],
        inputs: [],
        outputs: [],
        sideEffects: [],
        risks: [],
        concepts: ["fixture"],
        evidence: file.chunks.map((chunk) => ({
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          description: chunk.summary,
        })),
        confidence: 0.9,
        producer: "test-agent",
        model: "test-model",
      })),
    );
    expect(fileStatus.stage).toBe("ready-for-curation");
    expect(fileStatus.fileCoverage).toBe(1);
    expect((await getBootstrapCurationContext(root, 0, 10)).summaries).toHaveLength(2);

    const patch: GraphPatch = {
      schemaVersion: SCHEMA_VERSION,
      operations: [
        {
          op: "upsert-node",
          node: {
            id: "fixture-system",
            name: "Fixture System",
            kind: "system",
            summary: "Owns every reviewed fixture file.",
            sources: [
              { path: "src/large.ts", role: "primary" },
              { path: "src/small.ts", role: "primary" },
            ],
            tags: ["fixture"],
            status: "approved",
            locked: true,
          },
        },
        { op: "mark-reviewed", paths: ["src/large.ts", "src/small.ts"] },
      ],
    };
    const validation = await validateCurationPatch(root, patch);
    await applyValidatedCurationPatch(root, patch, validation.validationToken);
    const graphDigest = digestJson(await loadGraph(root));
    const completed = await finishAgentBootstrap(root, batch.sessionId, graphDigest);
    expect(completed.stage).toBe("complete");

    const resumed = await startAgentBootstrap(root, {
      sourceDisclosureApproved: true,
      maxChunkCharacters: 2_000,
    });
    expect(resumed.status.stage).toBe("complete");

    await writeFile(join(root, "src", "small.ts"), "export const small = false;\n", "utf8");
    const changed = await startAgentBootstrap(root, {
      sourceDisclosureApproved: true,
      maxChunkCharacters: 2_000,
    });
    expect(changed.status).toMatchObject({
      stage: "summarize-chunks",
      reusedFileSummaries: 1,
      summarizedFiles: 1,
    });
  });

  it("refuses to disclose a chunk after the frozen source changes", async () => {
    const root = await fixture();
    await startAgentBootstrap(root, {
      sourceDisclosureApproved: true,
      maxChunkCharacters: 2_000,
    });
    await writeFile(join(root, "src", "small.ts"), "export const changed = true;\n", "utf8");

    await expect(getNextBootstrapSourceBatch(root, 20_000, 10)).rejects.toThrow(
      /Source changed after the bootstrap snapshot/,
    );
    expect((await getAgentBootstrapStatus(root)).stage).toBe("summarize-chunks");
  });
});

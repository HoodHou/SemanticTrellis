import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyValidatedCurationPatch,
  auditProject,
  bootstrapProject,
  curateProject,
  initializeProject,
  projectStatus,
  syncProject,
  validateCurationPatch,
} from "../src/application/index.js";
import { SCHEMA_VERSION, type GraphPatch, type ReviewItem } from "../src/domain/model.js";
import {
  loadReviewQueue,
  saveReviewQueue,
} from "../src/infrastructure/project-store.js";

const temporaryRoots: string[] = [];

async function temporaryProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "semantic-trellis-flow-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "index.ts"), "export const value = 1;\n", "utf8");
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("project workflow", () => {
  it("runs init, bootstrap, sync, curate, status, and audit as one vertical slice", async () => {
    const root = await temporaryProject();
    const initialized = await initializeProject(root);
    expect(initialized.createdConfig).toBe(true);
    expect(initialized.createdGraph).toBe(true);

    const bootstrapped = await bootstrapProject(root);
    expect(bootstrapped.files).toBe(1);
    expect(bootstrapped.reviewItems).toBe(1);

    await writeFile(join(root, "src", "index.ts"), "export const value = 2;\n", "utf8");
    await writeFile(join(root, "src", "utility.ts"), "export const utility = true;\n", "utf8");
    const synced = await syncProject(root);
    expect(synced.byKind).toEqual({ added: 1, changed: 1, removed: 0 });
    expect(synced.pendingReviews).toBe(2);

    const patch: GraphPatch = {
      schemaVersion: SCHEMA_VERSION,
      operations: [
        {
          op: "upsert-node",
          node: {
            id: "application-entry",
            name: "Application Entry",
            kind: "system",
            summary: "Owns the repository entry point.",
            sources: [{ path: "src/index.ts", role: "primary" }],
            tags: ["entry"],
            status: "approved",
            locked: true,
          },
        },
        {
          op: "upsert-node",
          node: {
            id: "utility-component",
            name: "Utility Component",
            kind: "component",
            summary: "Provides shared utility behavior.",
            sources: [{ path: "src/utility.ts", role: "primary" }],
            tags: ["utility"],
            status: "approved",
            locked: false,
          },
        },
        {
          op: "upsert-edge",
          edge: {
            id: "application-contains-utility",
            from: "application-entry",
            to: "utility-component",
            relation: "contains",
            description: "The application owns the utility component.",
            status: "approved",
          },
        },
        {
          op: "mark-reviewed",
          paths: ["src/index.ts", "src/utility.ts"],
        },
      ],
    };
    const patchFile = join(root, "curation-patch.json");
    await writeFile(patchFile, `${JSON.stringify(patch, null, 2)}\n`, "utf8");
    const curated = await curateProject(root, patchFile);
    expect(curated).toEqual({ nodes: 2, edges: 1, reviewedPaths: 2, pendingReviews: 0 });

    const status = await projectStatus(root);
    expect(status.files).toBe(2);
    expect(status.nodes).toBe(2);
    expect(status.edges).toBe(1);
    expect(status.pendingReviews).toBe(0);
    expect(status.aiBootstrapped).toBe(false);
    expect(status.aiBootstrapStage).toBeNull();

    const audit = await auditProject(root);
    expect(audit.errors).toBe(0);
    expect(audit.warnings).toBe(0);
    expect(audit.information).toBe(0);

    const gitignore = await readFile(join(root, ".gitignore"), "utf8");
    expect(gitignore).toContain("/.semantic-trellis/local/");
  });

  it("invalidates curation tokens only when selected review entries change", async () => {
    const root = await temporaryProject();
    await initializeProject(root);
    await bootstrapProject(root);
    const patch: GraphPatch = {
      schemaVersion: SCHEMA_VERSION,
      operations: [
        {
          op: "upsert-node",
          node: {
            id: "entry",
            name: "Entry",
            kind: "system",
            summary: "Owns the entry source.",
            sources: [{ path: "src/index.ts", role: "primary" }],
            tags: ["entry"],
            status: "approved",
            locked: false,
          },
        },
        { op: "mark-reviewed", paths: ["src/index.ts"] },
      ],
    };
    const validation = await validateCurationPatch(root, patch);
    expect(validation.reviewStateDigest).toHaveLength(64);
    const originalQueue = await loadReviewQueue(root);
    const selected = originalQueue.items[0];
    expect(selected).toBeDefined();
    await saveReviewQueue(root, {
      schemaVersion: SCHEMA_VERSION,
      items: [{
        ...selected!,
        id: `changed:${selected!.path}:${"f".repeat(64)}`,
        changeKind: "changed",
        reason: "source-changed",
        beforeHash: selected!.afterHash,
        afterHash: "f".repeat(64),
      }],
    });

    await expect(
      applyValidatedCurationPatch(root, patch, validation.validationToken),
    ).rejects.toThrow(/reviewed queue entries changed/);

    const unrelated: ReviewItem = {
      id: `added:src/unrelated.ts:${"a".repeat(64)}`,
      path: "src/unrelated.ts",
      changeKind: "added",
      reason: "source-added",
      beforeHash: null,
      afterHash: "a".repeat(64),
      relatedNodeIds: [],
    };
    await saveReviewQueue(root, {
      schemaVersion: SCHEMA_VERSION,
      items: [...originalQueue.items, unrelated],
    });
    await expect(
      applyValidatedCurationPatch(root, patch, validation.validationToken),
    ).resolves.toMatchObject({ reviewedPaths: 1, pendingReviews: 1 });
  });
});

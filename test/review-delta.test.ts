import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyValidatedCurationPatch,
  bootstrapProject,
  buildReviewContext,
  buildStructuralIndex,
  initializeProject,
  syncProject,
  validateCurationPatch,
} from "../src/application/index.js";
import { SCHEMA_VERSION, type GraphPatch } from "../src/domain/model.js";
import { loadGraph, loadReviewQueue } from "../src/infrastructure/project-store.js";

const temporaryRoots: string[] = [];

async function writeRepoFile(root: string, path: string, content: string): Promise<void> {
  const absolute = join(root, ...path.split("/"));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

async function prepared(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "semantic-trellis-review-"));
  temporaryRoots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await writeRepoFile(root, path, content);
  }
  await initializeProject(root);
  await bootstrapProject(root);
  await buildStructuralIndex(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  })));
});

describe("structural review deltas", () => {
  it("marks a body-only edit implementation-only and applies the candidate review", async () => {
    const root = await prepared({
      "src/beta.ts": "export function beta(): number { return 2; }\n",
    });
    await writeRepoFile(root, "src/beta.ts", "export function beta(): number { return 3; }\n");
    await syncProject(root);

    const context = await buildReviewContext(root);
    const item = context.items.find((entry) => entry.path === "src/beta.ts");
    expect(item?.structuralDelta?.nature).toBe("implementation-only");
    expect(item?.structuralDelta?.symbolChanges).toEqual([]);
    expect(context.candidatePatch?.operations).toEqual([
      { op: "mark-reviewed", paths: ["src/beta.ts"] },
    ]);

    const validation = await validateCurationPatch(root, context.candidatePatch!);
    const applied = await applyValidatedCurationPatch(
      root,
      context.candidatePatch!,
      validation.validationToken,
    );
    expect(applied.pendingReviews).toBe(0);
  });

  it("labels a signature edit and does not prefill mark-reviewed", async () => {
    const root = await prepared({
      "src/beta.ts": "export function beta(): number { return 2; }\n",
    });
    await writeRepoFile(
      root,
      "src/beta.ts",
      "export function beta(value: number): number { return value; }\n",
    );
    await syncProject(root);

    const context = await buildReviewContext(root);
    const item = context.items.find((entry) => entry.path === "src/beta.ts");
    expect(item?.structuralDelta?.nature).toBe("symbol-signature-changed");
    expect(item?.structuralDelta?.symbolChanges).toEqual(
      expect.arrayContaining([expect.objectContaining({
        qualifiedName: "beta",
        change: "signature-changed",
      })]),
    );
    expect(context.candidatePatch).toBeNull();
  });

  it("labels a new cross-file call without treating it as implementation-only", async () => {
    const root = await prepared({
      "src/alpha.ts": "export function alpha(): number { return 1; }\n",
      "src/beta.ts": "export function beta(): number { return 2; }\n",
    });
    await writeRepoFile(
      root,
      "src/beta.ts",
      "import { alpha } from \"./alpha.js\";\nexport function beta(): number { return alpha(); }\n",
    );
    await syncProject(root);

    const context = await buildReviewContext(root);
    const item = context.items.find((entry) => entry.path === "src/beta.ts");
    expect(item?.structuralDelta?.nature).toBe("cross-node-reference-changed");
    expect(item?.structuralDelta?.referenceChanges).toEqual(
      expect.arrayContaining([expect.objectContaining({
        change: "added",
        targetName: "alpha",
        targetPath: "src/alpha.ts",
      })]),
    );
    const reviewedBeta = context.candidatePatch?.operations.some((operation) =>
      operation.op === "mark-reviewed" && operation.paths.includes("src/beta.ts"),
    ) ?? false;
    expect(reviewedBeta).toBe(false);
  });

  it("rewrites provenance for a pure file move and clears both review items", async () => {
    const root = await prepared({
      "src/old.ts": "export function moved(): number { return 1; }\n",
    });
    const initial: GraphPatch = {
      schemaVersion: SCHEMA_VERSION,
      operations: [
        {
          op: "upsert-node",
          node: {
            id: "moved-unit",
            name: "Moved unit",
            kind: "component",
            summary: "Owns the moved function.",
            sources: [{ path: "src/old.ts", role: "primary" }],
            tags: ["move"],
            status: "approved",
            locked: true,
          },
        },
        { op: "mark-reviewed", paths: ["src/old.ts"] },
      ],
    };
    const initialValidation = await validateCurationPatch(root, initial);
    await applyValidatedCurationPatch(root, initial, initialValidation.validationToken);

    const source = "export function moved(): number { return 1; }\n";
    await writeRepoFile(root, "src/next.ts", source);
    await rm(join(root, "src", "old.ts"));
    await syncProject(root);

    const context = await buildReviewContext(root);
    expect(context.items.map((item) => item.structuralDelta?.nature).sort()).toEqual([
      "file-moved",
      "file-moved",
    ]);
    expect(context.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "src/old.ts",
        structuralDelta: expect.objectContaining({ movedFrom: "src/old.ts", movedTo: "src/next.ts" }),
      }),
      expect.objectContaining({
        path: "src/next.ts",
        affectedNodes: [expect.objectContaining({ id: "moved-unit", summary: "Owns the moved function." })],
      }),
    ]));
    const upsert = context.candidatePatch?.operations.find((operation) => operation.op === "upsert-node");
    expect(upsert).toMatchObject({
      op: "upsert-node",
      overrideLocked: true,
      node: {
        id: "moved-unit",
        locked: true,
        sources: [{ path: "src/next.ts", role: "primary" }],
      },
    });
    expect(context.candidatePatch?.operations).toEqual(expect.arrayContaining([
      { op: "mark-reviewed", paths: ["src/next.ts", "src/old.ts"] },
    ]));

    const validation = await validateCurationPatch(root, context.candidatePatch!);
    await applyValidatedCurationPatch(root, context.candidatePatch!, validation.validationToken);
    const graph = await loadGraph(root);
    expect(graph.nodes.find((node) => node.id === "moved-unit")?.sources).toEqual([
      { path: "src/next.ts", role: "primary" },
    ]);
    expect((await loadReviewQueue(root)).items).toEqual([]);
  });
});

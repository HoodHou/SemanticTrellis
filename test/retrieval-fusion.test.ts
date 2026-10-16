import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyValidatedCurationPatch,
  askProject,
  bootstrapProject,
  grepStructure,
  initializeProject,
  validateCurationPatch,
} from "../src/application/index.js";
import { SCHEMA_VERSION, type GraphPatch } from "../src/domain/model.js";

const temporaryRoots: string[] = [];

async function writeRepoFile(root: string, path: string, content: string): Promise<void> {
  const absolute = join(root, ...path.split("/"));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  })));
});

describe("retrieval fusion", () => {
  it("adds a one-hop callee crux and the matching curated node to ask", async () => {
    const root = await mkdtemp(join(tmpdir(), "semantic-trellis-ask-"));
    temporaryRoots.push(root);
    await writeRepoFile(
      root,
      "src/rules.ts",
      `export function applyGraphPatch(): string {
  return "referential integrity gate";
}
export function validateCurationPatch(): string {
  return applyGraphPatch();
}
`,
    );
    await initializeProject(root);
    await bootstrapProject(root);
    const patch: GraphPatch = {
      schemaVersion: SCHEMA_VERSION,
      operations: [{
        op: "upsert-node",
        node: {
          id: "patch-rule",
          name: "Curation patch rule",
          kind: "invariant",
          summary: "validateCurationPatch checks a curation patch before it is applied.",
          sources: [{ path: "src/rules.ts", role: "primary" }],
          tags: ["curation"],
          status: "approved",
          locked: false,
        },
      }],
    };
    const validation = await validateCurationPatch(root, patch);
    await applyValidatedCurationPatch(root, patch, validation.validationToken);

    const asked = await askProject(root, "validate curation patch", {
      limit: 1,
      pathPrefix: "src",
      repairStale: false,
    });
    expect(asked.hits[0]?.symbol.name).toBe("validateCurationPatch");
    expect(asked.calleeCruxes.map((crux) => crux.symbolId).join(" ")).toContain("applyGraphPatch");
    const callee = asked.calleeCruxes.find((crux) => crux.symbolId.includes("applyGraphPatch"));
    expect(callee?.context.text).toContain("referential integrity gate");
    expect((callee?.context.endLine ?? 0) - (callee?.context.startLine ?? 0) + 1).toBeLessThanOrEqual(8);
    expect(asked.curatedNodes[0]?.node.id).toBe("patch-rule");
    expect(asked.curatedNodes[0]?.node.summary).toContain("validateCurationPatch");
  });

  it("prefers a cross-file callee over same-file helpers", async () => {
    const root = await mkdtemp(join(tmpdir(), "semantic-trellis-callee-"));
    temporaryRoots.push(root);
    await writeRepoFile(
      root,
      "src/domain/graph.ts",
      `export function applyGraphPatch(): string {
  return "referential integrity gate";
}
`,
    );
    await writeRepoFile(
      root,
      "src/application/curate.ts",
      `import { applyGraphPatch } from "../domain/graph.js";
function reviewedPaths(): string { return "paths"; }
function validationToken(): string { return "token"; }
export function validateCurationPatch(): string {
  reviewedPaths();
  validationToken();
  return applyGraphPatch();
}
`,
    );
    await initializeProject(root);
    await bootstrapProject(root);
    const asked = await askProject(root, "validate curation patch", {
      limit: 1,
      pathPrefix: "src/application",
      repairStale: false,
    });
    expect(asked.hits[0]?.symbol.name).toBe("validateCurationPatch");
    expect(asked.calleeCruxes.map((crux) => crux.symbolId).join(" ")).toContain("applyGraphPatch");
    expect(asked.calleeCruxes.some((crux) => crux.symbolId.includes("reviewedPaths"))).toBe(false);
    expect(asked.calleeCruxes.some((crux) => crux.symbolId.includes("validationToken"))).toBe(false);
  });

  it("deprioritizes test callbacks and can filter grep by symbol kind", async () => {
    const root = await mkdtemp(join(tmpdir(), "semantic-trellis-grep-"));
    temporaryRoots.push(root);
    await writeRepoFile(
      root,
      "src/core.ts",
      `export function applyGraphPatch(): void {
  throw new Error("Graph patch rejected");
}
`,
    );
    await writeRepoFile(
      root,
      "test/core.test.ts",
      `it("Graph patch rejected", () => {
  const detail = "Graph patch rejected";
  return detail;
});
`,
    );
    await initializeProject(root);
    await bootstrapProject(root);

    const ranked = await grepStructure(root, "Graph patch rejected", {
      fixed: true,
      repairStale: false,
    });
    expect(ranked.groups[0]?.symbolName).toBe("applyGraphPatch");
    expect(ranked.groups[0]?.path).toBe("src/core.ts");
    expect(ranked.groups.some((group) => group.symbolKind === "callback")).toBe(false);

    const tests = await grepStructure(root, "Graph patch rejected", {
      fixed: true,
      pathPrefix: "test",
      repairStale: false,
    });
    expect(tests.groups.some((group) => group.symbolKind === "callback")).toBe(true);

    const functions = await grepStructure(root, "Graph patch rejected", {
      fixed: true,
      symbolKinds: ["function"],
      repairStale: false,
    });
    expect(functions.groups.every((group) => group.symbolKind === "function")).toBe(true);
    expect(functions.groups.map((group) => group.symbolName)).toEqual(["applyGraphPatch"]);
    expect(functions.totalHits).toBe(1);
  });
});

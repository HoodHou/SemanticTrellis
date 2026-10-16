import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  askProject,
  bootstrapProject,
  buildStructuralIndex,
  initializeProject,
} from "../src/application/index.js";
import { traceStructuralGraph } from "../src/structural/queries.js";

const temporaryRoots: string[] = [];
const SOURCE_HASH = "a".repeat(64);

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

describe("markdown and projection structure", () => {
  it("extracts headings, tables, sheets, and cross-layer references", async () => {
    const root = await mkdtemp(join(tmpdir(), "semantic-trellis-docs-"));
    temporaryRoots.push(root);
    await writeRepoFile(
      root,
      "docs/adr/0003-delta-maintenance.md",
      `# Delta maintenance

## Decision

Keep contribution hashes.

| Field | Meaning |
| --- | --- |
| hash | content identity |
`,
    );
    await writeRepoFile(
      root,
      "docs/guide.md",
      `# Guide

See the [decision](adr/0003-delta-maintenance.md#Decision).
`,
    );
    await writeRepoFile(
      root,
      "design/items.xlsx.strellis.json",
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "semantic-trellis-projection",
        source: {
          path: "design/items.xlsx",
          sha256: SOURCE_HASH,
          mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
        producer: { tool: "test", version: "1" },
        omissions: [],
        warnings: [],
        content: {
          sheets: [{
            name: "ItemTable",
            fields: ["id", "displayName"],
            rows: [{ id: "sword", displayName: "Sword" }],
          }],
        },
      }, null, 2)}\n`,
    );
    await writeRepoFile(root, "notes.json", "{ \"ignored\": true }\n");
    await writeRepoFile(
      root,
      "src/loader.ts",
      `export function readConfig(): string {
  return "ItemTable";
}
export function citeDecision(): string {
  return "docs/adr/0003-delta-maintenance.md";
}
`,
    );
    await initializeProject(root);
    await bootstrapProject(root);
    const built = await buildStructuralIndex(root);

    expect(built.index.contributions["notes.json"]).toBeUndefined();
    const decision = built.index.contributions["docs/adr/0003-delta-maintenance.md"];
    expect(decision?.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "heading", name: "Decision" }),
      expect.objectContaining({ kind: "table", name: "Decision table" }),
      expect.objectContaining({ kind: "field", name: "Meaning" }),
    ]));
    const projection = built.index.contributions["design/items.xlsx.strellis.json"];
    expect(projection?.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "module", name: "items.xlsx" }),
      expect.objectContaining({ kind: "sheet", qualifiedName: "items.xlsx/ItemTable" }),
      expect.objectContaining({ kind: "field", name: "displayName" }),
      expect.objectContaining({ kind: "variable", name: "sword" }),
    ]));

    const guideTrace = traceStructuralGraph(built.index, "Guide", "outgoing", 1);
    expect(guideTrace.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "references" }),
    ]));
    expect(guideTrace.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "heading", name: "Decision" }),
    ]));

    const configTrace = traceStructuralGraph(built.index, "readConfig", "outgoing", 1);
    expect(configTrace.found).toBe(true);
    expect(configTrace.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "sheet", name: "ItemTable" }),
    ]));
    const decisionTrace = traceStructuralGraph(built.index, "citeDecision", "outgoing", 1);
    expect(decisionTrace.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "file",
        path: "docs/adr/0003-delta-maintenance.md",
      }),
    ]));

    const asked = await askProject(root, "ItemTable sheet", {
      limit: 4,
      repairStale: false,
    });
    expect(asked.hits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        symbol: expect.objectContaining({ kind: "sheet", name: "ItemTable" }),
      }),
    ]));
  });
});

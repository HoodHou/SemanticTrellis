import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyValidatedCurationPatch,
  askProject,
  buildStructuralIndex,
  grepStructure,
  initializeProject,
  validateCurationPatch,
} from "../src/application/index.js";
import { SCHEMA_VERSION, type GraphPatch } from "../src/domain/model.js";
import { traceStructuralGraph } from "../src/structural/queries.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "semantic-trellis-structure-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "src"));
  await execFileAsync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
  await writeFile(
    join(root, "src", "helper.ts"),
    "export function helper(): number { return 1; }\n",
    "utf8",
  );
  await writeFile(
    join(root, "src", "main.ts"),
    'import { helper } from "./helper.js";\nexport function main(): number { return helper(); }\n',
    "utf8",
  );
  await initializeProject(root);
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

describe("structural contributions", () => {
  it("reuses unchanged files and reparses only the changed contribution", async () => {
    const root = await fixture();
    const cold = await buildStructuralIndex(root);
    expect(cold.metrics).toMatchObject({
      discoveryMode: "git",
      filesSupported: 2,
      parsedFiles: 2,
      reusedFiles: 0,
      resolvedFiles: 2,
    });
    expect(cold.metrics.edges).toBeGreaterThanOrEqual(2);

    const warm = await buildStructuralIndex(root);
    expect(warm.metrics).toMatchObject({
      parsedFiles: 0,
      reusedFiles: 2,
      removedFiles: 0,
      resolvedFiles: 0,
    });

    await writeFile(
      join(root, "src", "main.ts"),
      'import { helper } from "./helper.js";\nexport function main(): number { return helper() + 1; }\n',
      "utf8",
    );
    const changed = await buildStructuralIndex(root);
    expect(changed.metrics).toMatchObject({
      parsedFiles: 1,
      reusedFiles: 1,
      removedFiles: 0,
      resolvedFiles: 1,
    });

    await writeFile(
      join(root, "src", "helper.ts"),
      "// implementation-only change\nexport function helper(): number { return 1; }\n",
      "utf8",
    );
    const implementationChanged = await buildStructuralIndex(root);
    expect(implementationChanged.metrics).toMatchObject({
      parsedFiles: 1,
      reusedFiles: 1,
      resolvedFiles: 1,
    });

    await writeFile(
      join(root, "src", "helper.ts"),
      "export function helperRenamed(): number { return 1; }\n",
      "utf8",
    );
    const definitionChanged = await buildStructuralIndex(root);
    expect(definitionChanged.metrics).toMatchObject({
      parsedFiles: 1,
      reusedFiles: 1,
      resolvedFiles: 2,
    });
    expect(
      definitionChanged.index.edges.some((edge) => edge.to.endsWith("#function:helper")),
    ).toBe(false);
  });

  it("groups grep hits by symbol, attributes curated context, and traces callers", async () => {
    const root = await fixture();
    const built = await buildStructuralIndex(root);
    const patch: GraphPatch = {
      schemaVersion: SCHEMA_VERSION,
      operations: [
        {
          op: "upsert-node",
          node: {
            id: "fixture-code",
            name: "Fixture Code",
            kind: "system",
            summary: "Owns both fixture files.",
            sources: [
              { path: "src/helper.ts", role: "primary" },
              { path: "src/main.ts", role: "primary" },
            ],
            tags: ["fixture"],
            status: "approved",
            locked: true,
          },
        },
      ],
    };
    const validation = await validateCurationPatch(root, patch);
    await applyValidatedCurationPatch(root, patch, validation.validationToken);

    const grep = await grepStructure(root, "helper(", {
      fixed: true,
      pathPrefix: "src",
      refresh: false,
    });
    expect(grep.totalHits).toBe(2);
    expect(grep.symbolAttributionRate).toBe(1);
    expect(grep.curatedAttributionRate).toBe(1);
    expect(grep.groups.map((group) => group.symbolName)).toEqual(
      expect.arrayContaining(["helper", "main"]),
    );

    const trace = traceStructuralGraph(built.index, "helper", "incoming", 1);
    expect(trace.focus).toHaveLength(1);
    expect(trace.symbols.some((symbol) => symbol.name === "main")).toBe(true);
  });

  it("returns columns and bounded source while prioritizing coupled groups before truncation", async () => {
    const root = await fixture();
    await writeFile(join(root, "src", "a-low.ts"), "export const needle = true;\n", "utf8");
    await writeFile(
      join(root, "src", "z-high.ts"),
      "export function target(): boolean { const needle = true; return needle; }\n",
      "utf8",
    );
    await writeFile(
      join(root, "src", "target-caller.ts"),
      'import { target } from "./z-high.js";\nexport const result = target();\n',
      "utf8",
    );
    await buildStructuralIndex(root);

    const grep = await grepStructure(root, "needle", {
      fixed: true,
      pathPrefix: "src",
      limit: 1,
      contextLines: 1,
      includeBody: true,
      maxSourceCharacters: 2_000,
    });
    expect(grep.groups).toHaveLength(1);
    expect(grep.groups[0]).toMatchObject({ symbolName: "target", inDegree: 1 });
    expect(grep.groups[0]?.hits[0]).toMatchObject({ column: 43, matchLength: 6 });
    expect(grep.groups[0]?.hits[0]?.context?.text).toContain("needle");
    expect(grep.groups[0]?.sourceContext?.text).toContain("function target");
    expect(grep.truncatedHits).toBe(2);

    await expect(
      grepStructure(root, "(a+)+$", { fixed: false, pathPrefix: "src" }),
    ).rejects.toThrow(/potentially catastrophic/);
  });

  it("rejects stale cache when repair is disabled and repairs it by default", async () => {
    const root = await fixture();
    await buildStructuralIndex(root);
    await writeFile(
      join(root, "src", "main.ts"),
      'import { helper } from "./helper.js";\nexport function changed(): number { return helper(); }\n',
      "utf8",
    );

    await expect(
      grepStructure(root, "helper", {
        fixed: true,
        pathPrefix: "src",
        refresh: false,
        repairStale: false,
      }),
    ).rejects.toThrow(/Structural index is stale/);

    const repaired = await grepStructure(root, "changed", {
      fixed: true,
      pathPrefix: "src",
      refresh: false,
    });
    expect(repaired.groups).toEqual(
      expect.arrayContaining([expect.objectContaining({ symbolName: "changed" })]),
    );
  });

  it("discovers and indexes a newly added Git-visible source during a query", async () => {
    const root = await fixture();
    await buildStructuralIndex(root);
    await writeFile(
      join(root, "src", "new-source.ts"),
      "export function newlyAdded(): boolean { return true; }\n",
      "utf8",
    );

    const result = await grepStructure(root, "newlyAdded", {
      fixed: true,
      pathPrefix: "src",
    });
    expect(result.groups).toEqual(
      expect.arrayContaining([expect.objectContaining({ symbolName: "newlyAdded" })]),
    );
  });

  it("returns query-aware eight-line ask cruxes with an explicit full-body mode", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "src", "crux.ts"),
      `export function graphPatchRejectedMechanism(): void {
  const step01 = 1;
  const step02 = 2;
  const step03 = 3;
  const step04 = 4;
  const step05 = 5;
  const step06 = 6;
  const step07 = 7;
  const step08 = 8;
  const step09 = 9;
  throw new Error("Graph patch rejected: dangling edge");
  const step10 = 10;
  const step11 = 11;
  const step12 = 12;
  void [step01, step02, step03, step04, step05, step06, step07, step08, step09, step10, step11, step12];
}
`,
      "utf8",
    );
    await buildStructuralIndex(root);

    const crux = await askProject(root, "graph patch rejected", {
      pathPrefix: "src",
      repairStale: false,
    });
    const cruxSource = crux.sourceContexts.find((source) =>
      source.symbolId.includes("graphPatchRejectedMechanism"),
    );
    expect(crux.hits.length).toBeLessThanOrEqual(4);
    expect(crux.hits[0]?.symbol.name).toBe("graphPatchRejectedMechanism");
    expect(cruxSource?.context.text).toContain("Graph patch rejected");
    expect(
      (cruxSource?.context.endLine ?? 0) - (cruxSource?.context.startLine ?? 0) + 1,
    ).toBeLessThanOrEqual(8);
    expect(cruxSource?.context.truncated).toBe(true);
    expect(JSON.stringify(crux).length).toBeLessThanOrEqual(7_000);

    const full = await askProject(root, "graph patch rejected", {
      pathPrefix: "src",
      fullBody: true,
      maxSourceCharacters: 10_000,
      repairStale: false,
    });
    const fullSource = full.sourceContexts.find((source) =>
      source.symbolId.includes("graphPatchRejectedMechanism"),
    );
    expect(
      (fullSource?.context.endLine ?? 0) - (fullSource?.context.startLine ?? 0) + 1,
    ).toBeGreaterThan(8);
    expect(fullSource?.context.truncated).toBe(false);
  });

  it("serves Python symbols, invokes, grep attribution, traces, and ask contexts", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "src", "worker.py"),
      `class Worker:
    def process(self, value):
        return value

    def run(self, value):
        return self.process(value)
`,
      "utf8",
    );
    const built = await buildStructuralIndex(root);
    const python = built.index.contributions["src/worker.py"];
    expect(python).toMatchObject({ language: "python" });
    expect(python?.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "class", qualifiedName: "Worker" }),
        expect.objectContaining({ kind: "method", qualifiedName: "Worker.process" }),
        expect.objectContaining({ kind: "method", qualifiedName: "Worker.run" }),
      ]),
    );

    const grep = await grepStructure(root, "process(", {
      fixed: true,
      pathPrefix: "src",
      repairStale: false,
    });
    expect(grep.totalHits).toBe(2);
    expect(grep.symbolAttributionRate).toBe(1);

    const trace = traceStructuralGraph(built.index, "Worker.process", "incoming", 1);
    expect(trace.edges).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "invoke" })]),
    );
    expect(trace.symbols).toEqual(
      expect.arrayContaining([expect.objectContaining({ qualifiedName: "Worker.run" })]),
    );

    const ask = await askProject(root, "Python worker process", {
      pathPrefix: "src",
      repairStale: false,
    });
    expect(ask.hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ symbol: expect.objectContaining({ qualifiedName: "Worker.process" }) }),
      ]),
    );
    expect(ask.sourceContexts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/worker.py" }),
      ]),
    );
  });

  it("serves Lua modules, invokes, grep attribution, traces, and ask contexts", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "src", "service.lua"),
      `local Service = {}
function Service.process(value)
  return value
end
function Service.run(value)
  return Service.process(value)
end
return Service
`,
      "utf8",
    );
    const built = await buildStructuralIndex(root);
    const lua = built.index.contributions["src/service.lua"];
    expect(lua).toMatchObject({ language: "lua" });
    expect(lua?.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "module", qualifiedName: "Service" }),
        expect.objectContaining({ kind: "method", qualifiedName: "Service.process" }),
        expect.objectContaining({ kind: "method", qualifiedName: "Service.run" }),
      ]),
    );

    const grep = await grepStructure(root, "process(", {
      fixed: true,
      pathPrefix: "src",
      repairStale: false,
    });
    expect(grep.totalHits).toBe(2);
    expect(grep.symbolAttributionRate).toBe(1);

    const trace = traceStructuralGraph(built.index, "Service.process", "incoming", 1);
    expect(trace.edges).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "invoke" })]),
    );
    expect(trace.symbols).toEqual(
      expect.arrayContaining([expect.objectContaining({ qualifiedName: "Service.run" })]),
    );

    const ask = await askProject(root, "Lua service process", {
      pathPrefix: "src",
      repairStale: false,
    });
    expect(ask.hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          symbol: expect.objectContaining({ qualifiedName: "Service.process" }),
        }),
      ]),
    );
    expect(ask.sourceContexts).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "src/service.lua" })]),
    );
  });
});

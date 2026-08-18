import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyValidatedCurationPatch,
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
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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
    });
    expect(cold.metrics.edges).toBeGreaterThanOrEqual(2);

    const warm = await buildStructuralIndex(root);
    expect(warm.metrics).toMatchObject({ parsedFiles: 0, reusedFiles: 2, removedFiles: 0 });

    await writeFile(
      join(root, "src", "main.ts"),
      'import { helper } from "./helper.js";\nexport function main(): number { return helper() + 1; }\n',
      "utf8",
    );
    const changed = await buildStructuralIndex(root);
    expect(changed.metrics).toMatchObject({ parsedFiles: 1, reusedFiles: 1, removedFiles: 0 });
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

  it("rejects cached grep when source bytes changed after the structural build", async () => {
    const root = await fixture();
    await buildStructuralIndex(root);
    await writeFile(
      join(root, "src", "main.ts"),
      'import { helper } from "./helper.js";\nexport function changed(): number { return helper(); }\n',
      "utf8",
    );

    await expect(
      grepStructure(root, "helper", { fixed: true, pathPrefix: "src", refresh: false }),
    ).rejects.toThrow(/Structural index is stale/);
  });
});

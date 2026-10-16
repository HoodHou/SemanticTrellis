import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  askProject,
  bootstrapProject,
  buildReviewContext,
  buildStructuralIndex,
  grepStructure,
  initializeProject,
  syncProject,
} from "../src/application/index.js";
import { createSemanticTrellisMcpServer } from "../src/mcp/server.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

async function writeRepoFile(root: string, path: string, content: string): Promise<void> {
  const absolute = join(root, ...path.split("/"));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

async function gitRepository(prefix: string, files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  await execFileAsync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
  for (const [path, content] of Object.entries(files)) {
    await writeRepoFile(root, path, content);
  }
  await initializeProject(root);
  await bootstrapProject(root);
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

describe("multiple repository instances", () => {
  it("keeps concurrent TypeScript, Python, and projection repositories isolated", async () => {
    const [typescriptRoot, pythonRoot, projectionRoot] = await Promise.all([
      gitRepository("semantic-trellis-instance-ts-", {
        "src/alpha.ts": "export function alpha(): string { return \"alpha-only\"; }\n",
      }),
      gitRepository("semantic-trellis-instance-py-", {
        "src/worker.py": "def worker():\n    return \"python-only\"\n",
      }),
      gitRepository("semantic-trellis-instance-doc-", {
        "docs/guide.md": "# Guide\n\nSee the sheet.\n",
        "design/items.xlsx.strellis.json": `${JSON.stringify({
          schemaVersion: 1,
          kind: "semantic-trellis-projection",
          source: {
            path: "design/items.xlsx",
            sha256: "b".repeat(64),
            mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          },
          producer: { tool: "test", version: "1" },
          omissions: [],
          warnings: [],
          content: { sheets: [{ name: "InstanceTable", fields: ["displayName"], rows: [] }] },
        })}\n`,
      }),
    ]);

    const [typescriptIndex, pythonIndex, projectionIndex] = await Promise.all([
      buildStructuralIndex(typescriptRoot),
      buildStructuralIndex(pythonRoot),
      buildStructuralIndex(projectionRoot),
    ]);
    expect(Object.keys(typescriptIndex.index.contributions)).toEqual(["src/alpha.ts"]);
    expect(Object.keys(pythonIndex.index.contributions)).toEqual(["src/worker.py"]);
    expect(Object.keys(projectionIndex.index.contributions).sort()).toEqual([
      "design/items.xlsx.strellis.json",
      "docs/guide.md",
    ]);

    const [typescriptAsk, pythonGrep, projectionAsk] = await Promise.all([
      askProject(typescriptRoot, "alpha-only", { repairStale: true }),
      grepStructure(pythonRoot, "python-only", { fixed: true, repairStale: true }),
      askProject(projectionRoot, "InstanceTable", { repairStale: true }),
    ]);
    expect(typescriptAsk.hits.map((hit) => hit.symbol.path)).toEqual(
      expect.arrayContaining(["src/alpha.ts"]),
    );
    expect(typescriptAsk.hits.some((hit) => hit.symbol.path.endsWith(".py"))).toBe(false);
    expect(pythonGrep.groups.map((group) => group.path)).toEqual(["src/worker.py"]);
    expect(projectionAsk.hits.map((hit) => hit.symbol.name)).toEqual(
      expect.arrayContaining(["InstanceTable"]),
    );
    expect(projectionAsk.hits.some((hit) => hit.symbol.name === "alpha")).toBe(false);

    await Promise.all([
      writeRepoFile(typescriptRoot, "src/alpha.ts", "export function alpha(): string { return \"alpha-edited\"; }\n"),
      writeRepoFile(pythonRoot, "src/worker.py", "def worker():\n    return \"python-edited\"\n"),
    ]);
    const [editedTypescript, unchangedProjection] = await Promise.all([
      grepStructure(typescriptRoot, "alpha-edited", { fixed: true, repairStale: true }),
      grepStructure(projectionRoot, "alpha-edited", { fixed: true, repairStale: true }),
    ]);
    expect(editedTypescript.totalHits).toBe(1);
    expect(unchangedProjection.totalHits).toBe(0);

    const [typescriptSync, pythonSync] = await Promise.all([
      syncProject(typescriptRoot),
      syncProject(pythonRoot),
    ]);
    expect(typescriptSync.byKind.changed).toBe(1);
    expect(pythonSync.byKind.changed).toBe(1);
    const [typescriptReview, pythonReview] = await Promise.all([
      buildReviewContext(typescriptRoot),
      buildReviewContext(pythonRoot),
    ]);
    expect(typescriptReview.items.map((item) => item.path)).toEqual(["src/alpha.ts"]);
    expect(pythonReview.items.map((item) => item.path)).toEqual(["src/worker.py"]);
  });

  it("binds three MCP servers to three roots at the same time", async () => {
    const roots = await Promise.all([
      gitRepository("semantic-trellis-mcp-a-", {
        "src/index.ts": "export const marker = \"instance-a\";\n",
      }),
      gitRepository("semantic-trellis-mcp-b-", {
        "src/index.ts": "export const marker = \"instance-b\";\n",
      }),
      gitRepository("semantic-trellis-mcp-c-", {
        "src/index.ts": "export const marker = \"instance-c\";\n",
      }),
    ]);
    const sessions = await Promise.all(roots.map(async (root, index) => {
      const server = createSemanticTrellisMcpServer(root);
      const client = new Client({ name: `instance-${index}`, version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      return { root, server, client };
    }));

    try {
      const statuses = await Promise.all(sessions.map((session) => session.client.callTool({
        name: "semantic_trellis_status",
        arguments: {},
      })));
      expect(statuses.every((status) => status.isError !== true)).toBe(true);
      const asks = await Promise.all(sessions.map((session, index) => session.client.callTool({
        name: "semantic_trellis_ask",
        arguments: { query: `instance-${["a", "b", "c"][index]}`, includeBody: true, limit: 2 },
      })));
      asks.forEach((result, index) => {
        expect(result.isError).not.toBe(true);
        const text = JSON.stringify(result.structuredContent);
        const marker = `instance-${["a", "b", "c"][index]}`;
        expect(text).toContain(marker);
        for (const other of ["instance-a", "instance-b", "instance-c"]) {
          if (other !== marker) expect(text).not.toContain(other);
        }
      });
    } finally {
      await Promise.all(sessions.map(async (session) => {
        await session.client.close();
        await session.server.close();
      }));
    }
  });
});

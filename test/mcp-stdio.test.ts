import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapProject, initializeProject } from "../src/application/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MCP stdio entry point", () => {
  it("keeps stdout protocol-clean and completes a real client handshake", async () => {
    const root = await mkdtemp(join(tmpdir(), "semantic-trellis-stdio-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "entry.ts"), "export const entry = true;\n", "utf8");
    await initializeProject(root);
    await bootstrapProject(root);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/mcp/stdio.ts", root],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = new Client({ name: "semantic-trellis-stdio-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      const status = await client.callTool({
        name: "semantic_trellis_status",
        arguments: {},
      });
      expect(status.isError).not.toBe(true);
      expect(status.structuredContent).toMatchObject({ files: 1, pendingReviews: 1 });

      const structure = await client.callTool({
        name: "semantic_trellis_structure",
        arguments: {},
      });
      expect(structure.isError).not.toBe(true);
      expect(structure.structuredContent).toMatchObject({ filesSupported: 1, parsedFiles: 1 });
    } finally {
      await client.close();
    }
  });
});

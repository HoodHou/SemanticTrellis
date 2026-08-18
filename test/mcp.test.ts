import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapProject, initializeProject } from "../src/application/index.js";
import { createSemanticTrellisMcpServer } from "../src/mcp/server.js";

const temporaryRoots: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "semantic-trellis-mcp-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "index.ts"), "export const value = 1;\n", "utf8");
  await initializeProject(root);
  await bootstrapProject(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MCP server", () => {
  it("exposes context, resources, and a validated curation workflow", async () => {
    const root = await fixture();
    const server = createSemanticTrellisMcpServer(root);
    const client = new Client({ name: "semantic-trellis-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "semantic_trellis_status",
          "semantic_trellis_graph",
          "semantic_trellis_search",
          "semantic_trellis_review_queue",
          "semantic_trellis_audit",
          "semantic_trellis_sync",
          "semantic_trellis_validate_patch",
          "semantic_trellis_apply_patch",
        ]),
      );
      expect(
        listed.tools.find((tool) => tool.name === "semantic_trellis_status")?.annotations,
      ).toMatchObject({ readOnlyHint: true, idempotentHint: true, openWorldHint: false });
      expect(
        listed.tools.find((tool) => tool.name === "semantic_trellis_apply_patch")?.annotations,
      ).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
      expect(client.getInstructions()).toContain("Never call apply_patch directly");

      const status = await client.callTool({
        name: "semantic_trellis_status",
        arguments: {},
      });
      expect(status.isError).not.toBe(true);
      expect(status.structuredContent).toMatchObject({ files: 1, nodes: 0, pendingReviews: 1 });

      const wrongPrefix = await client.callTool({
        name: "semantic_trellis_review_queue",
        arguments: { pathPrefix: "src-old" },
      });
      expect(wrongPrefix.structuredContent).toMatchObject({ total: 0, returned: 0 });
      const sourcePrefix = await client.callTool({
        name: "semantic_trellis_review_queue",
        arguments: { pathPrefix: "src" },
      });
      expect(sourcePrefix.structuredContent).toMatchObject({ total: 1, returned: 1 });

      const patch = {
        schemaVersion: 1 as const,
        operations: [
          {
            op: "upsert-node" as const,
            node: {
              id: "fixture-entry",
              name: "Fixture Entry",
              kind: "system" as const,
              summary: "Owns the fixture entry point.",
              sources: [{ path: "src/index.ts", role: "primary" as const }],
              tags: ["fixture"],
              status: "approved" as const,
              locked: true,
            },
          },
          { op: "mark-reviewed" as const, paths: ["src/index.ts"] },
        ],
      };
      const validation = await client.callTool({
        name: "semantic_trellis_validate_patch",
        arguments: { patch },
      });
      expect(validation.isError).not.toBe(true);
      const validationToken = String(validation.structuredContent?.validationToken);
      expect(validationToken).toHaveLength(64);

      const changedPatch = structuredClone(patch);
      changedPatch.operations[0] = {
        ...changedPatch.operations[0],
        node: {
          ...changedPatch.operations[0].node,
          summary: "A different unvalidated summary.",
        },
      };
      const rejected = await client.callTool({
        name: "semantic_trellis_apply_patch",
        arguments: { patch: changedPatch, validationToken },
      });
      expect(rejected.isError).toBe(true);

      const applied = await client.callTool({
        name: "semantic_trellis_apply_patch",
        arguments: { patch, validationToken },
      });
      expect(applied.isError).not.toBe(true);
      expect(applied.structuredContent).toMatchObject({ nodes: 1, pendingReviews: 0 });

      const search = await client.callTool({
        name: "semantic_trellis_search",
        arguments: { query: "fixture" },
      });
      expect(search.structuredContent).toMatchObject({
        hits: [{ node: { id: "fixture-entry" } }],
      });

      const resources = await client.listResources();
      expect(resources.resources.map((resource) => resource.uri)).toContain(
        "semantic-trellis://graph",
      );
      const graphResource = await client.readResource({ uri: "semantic-trellis://graph" });
      expect(graphResource.contents[0]).toMatchObject({ mimeType: "application/json" });
      expect("text" in graphResource.contents[0] ? graphResource.contents[0].text : "").toContain(
        "fixture-entry",
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});

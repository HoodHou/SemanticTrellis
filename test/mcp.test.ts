import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  })));
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
          "semantic_trellis_review_context",
          "semantic_trellis_audit",
          "semantic_trellis_sync",
          "semantic_trellis_structure",
          "semantic_trellis_grep",
          "semantic_trellis_file_symbols",
          "semantic_trellis_trace",
          "semantic_trellis_symbol_search",
          "semantic_trellis_ask",
          "semantic_trellis_bootstrap_preview",
          "semantic_trellis_bootstrap_start",
          "semantic_trellis_bootstrap_status",
          "semantic_trellis_bootstrap_next_batch",
          "semantic_trellis_bootstrap_submit_chunk_summaries",
          "semantic_trellis_bootstrap_next_rollups",
          "semantic_trellis_bootstrap_submit_file_summaries",
          "semantic_trellis_bootstrap_context",
          "semantic_trellis_bootstrap_complete",
          "semantic_trellis_unsupported_list",
          "semantic_trellis_projection_status",
          "semantic_trellis_projection_validate",
          "semantic_trellis_projection_register",
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
      expect(client.getInstructions()).toContain("Never apply a patch without validation");
      expect(client.getInstructions()).toContain("Unsupported artifact projection rule");
      expect(client.getInstructions()).toContain("Never ignore a relevant unsupported artifact");
      expect(client.getInstructions()).toContain(".strellis.json or .strellis.md");
      expect(client.getInstructions()).toContain("projection_validate");
      expect(client.getInstructions()).toContain("projection_register");

      const status = await client.callTool({
        name: "semantic_trellis_status",
        arguments: {},
      });
      expect(status.isError).not.toBe(true);
      expect(status.structuredContent).toMatchObject({
        files: 1,
        nodes: 0,
        pendingReviews: 1,
        aiBootstrapped: false,
        aiBootstrapStage: null,
      });

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

      const bootstrapPreview = await client.callTool({
        name: "semantic_trellis_bootstrap_preview",
        arguments: {},
      });
      expect(bootstrapPreview.isError).not.toBe(true);
      expect(bootstrapPreview.structuredContent).toMatchObject({
        totalFiles: 1,
        suspiciousPaths: [],
      });

      const bootstrapStart = await client.callTool({
        name: "semantic_trellis_bootstrap_start",
        arguments: { sourceDisclosureApproved: true, maxChunkCharacters: 2_000 },
      });
      expect(bootstrapStart.isError).not.toBe(true);
      const sessionId = String(
        (bootstrapStart.structuredContent?.status as { sessionId?: unknown } | undefined)?.sessionId,
      );
      expect(sessionId).toHaveLength(64);

      const sourceBatchResult = await client.callTool({
        name: "semantic_trellis_bootstrap_next_batch",
        arguments: { maxCharacters: 10_000, maxUnits: 10 },
      });
      const sourceBatch = JSON.parse(
        sourceBatchResult.content[0]?.type === "text" ? sourceBatchResult.content[0].text : "{}",
      ) as {
        units: Array<{
          id: string;
          path: string;
          hash: string;
          chunkIndex: number;
          startLine: number;
          endLine: number;
        }>;
      };
      expect(sourceBatch.units).toHaveLength(1);
      const chunkSubmitted = await client.callTool({
        name: "semantic_trellis_bootstrap_submit_chunk_summaries",
        arguments: {
          sessionId,
          summaries: sourceBatch.units.map((unit) => ({
            unitId: unit.id,
            summary: `AI summary for ${unit.path}.`,
            keyFacts: ["Exports one value."],
            risks: [],
            confidence: 0.9,
            producer: "test-agent",
            model: "test-model",
          })),
        },
      });
      expect(chunkSubmitted.structuredContent).toMatchObject({ stage: "summarize-files" });

      const rollupResult = await client.callTool({
        name: "semantic_trellis_bootstrap_next_rollups",
        arguments: { limit: 5 },
      });
      const rollups = JSON.parse(
        rollupResult.content[0]?.type === "text" ? rollupResult.content[0].text : "{}",
      ) as {
        files: Array<{
          path: string;
          hash: string;
          chunks: Array<{ startLine: number; endLine: number; summary: string }>;
          structural: { symbols: Array<{ qualifiedName: string }> };
        }>;
      };
      expect(rollups.files).toHaveLength(1);
      const fileSubmitted = await client.callTool({
        name: "semantic_trellis_bootstrap_submit_file_summaries",
        arguments: {
          sessionId,
          summaries: rollups.files.map((file) => ({
            path: file.path,
            hash: file.hash,
            summary: "AI file summary for the fixture entry point.",
            responsibilities: ["Expose the fixture value."],
            keySymbols: file.structural.symbols.map((symbol) => symbol.qualifiedName),
            dependencies: [],
            inputs: [],
            outputs: ["value"],
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
        },
      });
      expect(fileSubmitted.structuredContent).toMatchObject({
        stage: "ready-for-curation",
        fileCoverage: 1,
      });

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

      const completed = await client.callTool({
        name: "semantic_trellis_bootstrap_complete",
        arguments: {
          sessionId,
          graphDigest: validation.structuredContent?.proposedGraphDigest,
        },
      });
      expect(completed.isError).not.toBe(true);
      expect(completed.structuredContent).toMatchObject({ stage: "complete", fileCoverage: 1 });

      const completedStatus = await client.callTool({
        name: "semantic_trellis_status",
        arguments: {},
      });
      expect(completedStatus.structuredContent).toMatchObject({
        aiBootstrapped: true,
        aiBootstrapStage: "complete",
      });

      const lockedUpdate = {
        schemaVersion: 1 as const,
        operations: [
          {
            op: "upsert-node" as const,
            node: {
              ...patch.operations[0].node,
              summary: "Attempted locked-node replacement.",
            },
          },
        ],
      };
      const lockedRejected = await client.callTool({
        name: "semantic_trellis_validate_patch",
        arguments: { patch: lockedUpdate },
      });
      expect(lockedRejected.isError).toBe(true);
      const lockedReviewed = await client.callTool({
        name: "semantic_trellis_validate_patch",
        arguments: {
          patch: {
            ...lockedUpdate,
            operations: [{ ...lockedUpdate.operations[0], overrideLocked: true }],
          },
        },
      });
      expect(lockedReviewed.isError).not.toBe(true);

      const structure = await client.callTool({
        name: "semantic_trellis_structure",
        arguments: {},
      });
      expect(structure.isError).not.toBe(true);
      expect(structure.structuredContent).toMatchObject({
        parsedFiles: 0,
        reusedFiles: 1,
        filesSupported: 1,
      });

      const structuralGrep = await client.callTool({
        name: "semantic_trellis_grep",
        arguments: { pattern: "value", fixed: true, pathPrefix: "src" },
      });
      expect(structuralGrep.isError).not.toBe(true);
      expect(structuralGrep.structuredContent).toMatchObject({
        totalHits: 1,
        curatedAttributionRate: 1,
      });

      const fileSymbols = await client.callTool({
        name: "semantic_trellis_file_symbols",
        arguments: { file: "src/index.ts" },
      });
      expect(fileSymbols.isError).not.toBe(true);
      expect(fileSymbols.structuredContent).toMatchObject({
        symbols: expect.arrayContaining([expect.objectContaining({ name: "value" })]),
      });

      const symbolSearch = await client.callTool({
        name: "semantic_trellis_symbol_search",
        arguments: { query: "fixture value", limit: 5 },
      });
      expect(symbolSearch.isError).not.toBe(true);
      expect(symbolSearch.structuredContent).toMatchObject({
        hits: expect.arrayContaining([
          expect.objectContaining({ symbol: expect.objectContaining({ name: "value" }) }),
        ]),
      });

      const scopedMiss = await client.callTool({
        name: "semantic_trellis_symbol_search",
        arguments: { query: "fixture value", pathPrefix: "other" },
      });
      expect(scopedMiss.structuredContent).toMatchObject({ hits: [] });

      const ask = await client.callTool({
        name: "semantic_trellis_ask",
        arguments: { query: "fixture value", includeBody: true },
      });
      expect(ask.isError).not.toBe(true);
      expect(ask.structuredContent).toMatchObject({
        hits: expect.arrayContaining([
          expect.objectContaining({ symbol: expect.objectContaining({ name: "value" }) }),
        ]),
        sourceContexts: expect.arrayContaining([
          expect.objectContaining({
            context: expect.objectContaining({ text: expect.stringContaining("export const value") }),
          }),
        ]),
      });
      expect(
        (ask.structuredContent?.hits as Array<{ symbol: { kind: string } }>).every(
          (hit) => hit.symbol.kind !== "file",
        ),
      ).toBe(true);

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

  it("discovers, validates, and registers a source-bound projection over MCP", async () => {
    const root = await fixture();
    await mkdir(join(root, "design"));
    const original = Buffer.from("PK-workbook-fixture");
    await writeFile(join(root, "design", "config.xlsx"), original);
    const server = createSemanticTrellisMcpServer(root);
    const client = new Client({ name: "semantic-trellis-projection-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const unsupported = await client.callTool({
        name: "semantic_trellis_unsupported_list",
        arguments: { offset: 0, limit: 100 },
      });
      expect(unsupported.isError).not.toBe(true);
      const artifact = (
        unsupported.structuredContent?.items as Array<{ path: string; sha256: string }>
      ).find((item) => item.path === "design/config.xlsx");
      expect(artifact).toBeDefined();
      const projectionPath = "design/config.xlsx.strellis.json";
      const content = JSON.stringify({
        schemaVersion: 1,
        kind: "semantic-trellis-projection",
        source: {
          path: artifact?.path,
          sha256: artifact?.sha256,
          mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
        producer: { tool: "mcp-test-workbook-reader", version: "1.0.0" },
        omissions: [],
        warnings: [],
        content: { sheets: [{ name: "Config", rows: [{ id: 1 }] }] },
      });
      const validation = await client.callTool({
        name: "semantic_trellis_projection_validate",
        arguments: { projectionPath, content },
      });
      expect(validation.isError).not.toBe(true);
      expect(validation.structuredContent).toMatchObject({
        projectionPath,
        sourcePath: "design/config.xlsx",
        existingProjectionSha256: null,
      });

      const registered = await client.callTool({
        name: "semantic_trellis_projection_register",
        arguments: {
          projectionPath,
          content,
          validationToken: validation.structuredContent?.validationToken,
        },
      });
      expect(registered.isError).not.toBe(true);
      expect(registered.structuredContent).toMatchObject({ health: "current" });
      expect(await readFile(join(root, "design", "config.xlsx"))).toEqual(original);

      const status = await client.callTool({
        name: "semantic_trellis_projection_status",
        arguments: { pathPrefix: "design", offset: 0, limit: 100 },
      });
      expect(status.structuredContent).toMatchObject({
        total: 1,
        counts: { current: 1, stale: 0, invalid: 0 },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

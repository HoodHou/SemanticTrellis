import { McpServer } from "@modelcontextprotocol/server";
import { resolve } from "node:path";
import * as z from "zod/v4";
import {
  applyValidatedCurationPatch,
  auditProject,
  projectStatus,
  syncProject,
  validateCurationPatch,
} from "../application/index.js";
import { graphNeighborhood, searchGraph } from "../domain/query.js";
import { loadGraph, loadReviewQueue } from "../infrastructure/project-store.js";
import { VERSION } from "../version.js";
import {
  applyOutputSchema,
  asGraphPatch,
  auditOutputSchema,
  graphOutputSchema,
  graphPatchSchema,
  reviewQueueOutputSchema,
  searchOutputSchema,
  statusOutputSchema,
  syncOutputSchema,
  validationOutputSchema,
} from "./schemas.js";

const INSTRUCTIONS =
  "SemanticTrellis serves one fixed repository. Start with semantic_trellis_status, then use graph or search for curated context. Run sync before reasoning about recent edits. Never call apply_patch directly: validate the exact patch, present the planned canonical changes to the user, obtain approval, then apply it with the returned validation token. Sync changes only disposable local state; apply_patch changes the versioned curated graph.";

function success<T extends Record<string, unknown>>(value: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: { ...value },
  };
}

function failure(error: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: error instanceof Error ? error.message : String(error),
      },
    ],
    isError: true,
  };
}

async function safe<T extends Record<string, unknown>>(
  action: () => Promise<T>,
) {
  try {
    return success(await action());
  } catch (error) {
    return failure(error);
  }
}

export function createSemanticTrellisMcpServer(repositoryRoot: string): McpServer {
  const root = resolve(repositoryRoot);
  const server = new McpServer(
    {
      name: "semantic-trellis",
      version: VERSION,
      websiteUrl: "https://github.com/HoodHou/SemanticTrellis",
    },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "semantic_trellis_status",
    {
      title: "SemanticTrellis Status",
      description:
        "Return bootstrap state, file count, curated graph size, and pending review count for the fixed repository.",
      inputSchema: z.object({}),
      outputSchema: statusOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => safe(async () => ({ ...(await projectStatus(root)) })),
  );

  server.registerTool(
    "semantic_trellis_graph",
    {
      title: "Read Curated Graph",
      description:
        "Return the complete curated semantic graph or a bounded incoming, outgoing, or bidirectional neighborhood around one stable node ID.",
      inputSchema: z.object({
        nodeId: z.string().min(1).optional().describe("Stable node ID. Omit for the complete curated graph."),
        depth: z.number().int().min(0).max(8).default(1),
        direction: z.enum(["both", "incoming", "outgoing"]).default("both"),
      }),
      outputSchema: graphOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ nodeId, depth, direction }) =>
      safe(async () => ({
        ...graphNeighborhood(await loadGraph(root), nodeId ?? null, depth, direction),
      })),
  );

  server.registerTool(
    "semantic_trellis_search",
    {
      title: "Search Curated Graph",
      description:
        "Search stable nodes by ID, name, kind, summary, tags, and repository-relative source path.",
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).default(10),
      }),
      outputSchema: searchOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, limit }) =>
      safe(async () => ({ query, hits: searchGraph(await loadGraph(root), query, limit) })),
  );

  server.registerTool(
    "semantic_trellis_review_queue",
    {
      title: "Read Review Queue",
      description:
        "Return repository changes waiting for semantic review, including the curated nodes related through source provenance.",
      inputSchema: z.object({
        pathPrefix: z.string().optional(),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      outputSchema: reviewQueueOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ pathPrefix, limit }) =>
      safe(async () => {
        const queue = await loadReviewQueue(root);
        const prefix = pathPrefix
          ?.replace(/\\/g, "/")
          .replace(/^\.\//, "")
          .replace(/\/+$/, "");
        const matching = prefix === undefined || prefix.length === 0
          ? queue.items
          : queue.items.filter(
              (item) => item.path === prefix || item.path.startsWith(`${prefix}/`),
            );
        const items = matching.slice(0, limit);
        return { total: matching.length, returned: items.length, items };
      }),
  );

  server.registerTool(
    "semantic_trellis_audit",
    {
      title: "Audit Curated Graph",
      description:
        "Audit graph integrity, source provenance, stale paths, and unclassified sources without changing repository state.",
      inputSchema: z.object({
        severity: z.enum(["all", "error", "warning", "info"]).default("all"),
        limit: z.number().int().min(1).max(1000).default(200),
      }),
      outputSchema: auditOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ severity, limit }) =>
      safe(async () => {
        const audit = await auditProject(root);
        const issues = audit.issues
          .filter((issue) => severity === "all" || issue.severity === severity)
          .slice(0, limit);
        return {
          projectId: audit.projectId,
          errors: audit.errors,
          warnings: audit.warnings,
          information: audit.information,
          issues,
        };
      }),
  );

  server.registerTool(
    "semantic_trellis_sync",
    {
      title: "Sync Repository Delta",
      description:
        "Scan the fixed repository, update disposable local snapshot state, and queue changed files for review. This never edits the curated graph.",
      inputSchema: z.object({}),
      outputSchema: syncOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => safe(async () => ({ ...(await syncProject(root)) })),
  );

  server.registerTool(
    "semantic_trellis_validate_patch",
    {
      title: "Validate Curation Patch",
      description:
        "Apply a proposed patch in memory, run repository-aware audit, and return a token bound to the exact patch and current graph. Call this before apply_patch.",
      inputSchema: z.object({ patch: graphPatchSchema }),
      outputSchema: validationOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ patch }) =>
      safe(async () => ({ ...(await validateCurationPatch(root, asGraphPatch(patch))) })),
  );

  server.registerTool(
    "semantic_trellis_apply_patch",
    {
      title: "Apply Validated Curation Patch",
      description:
        "Modify the versioned curated graph using the exact patch and validation token returned by validate_patch. Rejects stale or changed input.",
      inputSchema: z.object({
        patch: graphPatchSchema,
        validationToken: z.string().length(64),
      }),
      outputSchema: applyOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ patch, validationToken }) =>
      safe(async () => ({
        ...(await applyValidatedCurationPatch(
          root,
          asGraphPatch(patch),
          validationToken,
        )),
      })),
  );

  server.registerResource(
    "semantic-trellis-status",
    "semantic-trellis://status",
    {
      title: "SemanticTrellis Status",
      description: "Current bootstrap, graph, and review state for the fixed repository.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await projectStatus(root), null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    "semantic-trellis-graph",
    "semantic-trellis://graph",
    {
      title: "Curated Semantic Graph",
      description: "The complete canonical semantic graph for the fixed repository.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await loadGraph(root), null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    "semantic-trellis-review-queue",
    "semantic-trellis://review-queue",
    {
      title: "Semantic Review Queue",
      description: "Up to 200 pending review items for the fixed repository.",
      mimeType: "application/json",
    },
    async (uri) => {
      const queue = await loadReviewQueue(root);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              { total: queue.items.length, items: queue.items.slice(0, 200) },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  return server;
}

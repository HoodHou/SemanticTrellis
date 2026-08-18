import { describe, expect, it } from "vitest";
import { applyGraphPatch, auditGraph, createEmptyGraph } from "../src/domain/graph.js";
import { SCHEMA_VERSION, type CuratedGraph, type GraphPatch } from "../src/domain/model.js";

describe("curated graph", () => {
  it("requires an explicit override to modify an existing locked node", () => {
    const graph = createEmptyGraph("example");
    graph.nodes.push({
      id: "locked",
      name: "Locked Node",
      kind: "system",
      summary: "Original summary.",
      sources: [],
      tags: [],
      status: "approved",
      locked: true,
    });
    const replacement = {
      ...graph.nodes[0]!,
      summary: "Reviewed replacement summary.",
    };

    expect(() =>
      applyGraphPatch(graph, {
        schemaVersion: SCHEMA_VERSION,
        operations: [{ op: "upsert-node", node: replacement }],
      }),
    ).toThrow(/locked-node-modification/);

    const applied = applyGraphPatch(graph, {
      schemaVersion: SCHEMA_VERSION,
      operations: [{ op: "upsert-node", node: replacement, overrideLocked: true }],
    });
    expect(applied.graph.nodes[0]?.summary).toBe("Reviewed replacement summary.");
  });

  it("rejects a patch that leaves a dangling edge", () => {
    const graph = createEmptyGraph("example");
    const patch: GraphPatch = {
      schemaVersion: SCHEMA_VERSION,
      operations: [
        {
          op: "upsert-edge",
          edge: {
            id: "missing-target",
            from: "one",
            to: "two",
            relation: "depends-on",
            description: "Invalid until both nodes exist.",
            status: "proposed",
          },
        },
      ],
    };

    expect(() => applyGraphPatch(graph, patch)).toThrow(/Graph patch rejected/);
  });

  it("audits duplicate identities and stale source provenance", () => {
    const graph: CuratedGraph = {
      schemaVersion: SCHEMA_VERSION,
      projectId: "example",
      nodes: [
        {
          id: "duplicate",
          name: "One",
          kind: "component",
          summary: "First node.",
          sources: [{ path: "src/missing.ts", role: "primary" }],
          tags: [],
          status: "approved",
          locked: false,
        },
        {
          id: "duplicate",
          name: "Two",
          kind: "component",
          summary: "Second node.",
          sources: [],
          tags: [],
          status: "approved",
          locked: false,
        },
      ],
      edges: [],
    };
    const snapshot = {
      schemaVersion: SCHEMA_VERSION,
      files: [{ path: "src/current.ts", hash: "hash", size: 1 }],
    };

    const audit = auditGraph(graph, snapshot);

    expect(audit.issues.some((issue) => issue.code === "duplicate-node-id")).toBe(true);
    expect(audit.issues.some((issue) => issue.code === "stale-source-path")).toBe(true);
    expect(audit.issues.some((issue) => issue.code === "unclassified-source")).toBe(true);
  });
});

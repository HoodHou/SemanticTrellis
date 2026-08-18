import { describe, expect, it } from "vitest";
import { graphNeighborhood, searchGraph } from "../src/domain/query.js";
import { SCHEMA_VERSION, type CuratedGraph } from "../src/domain/model.js";

const graph: CuratedGraph = {
  schemaVersion: SCHEMA_VERSION,
  projectId: "query-fixture",
  nodes: [
    {
      id: "product",
      name: "Product System",
      kind: "system",
      summary: "Owns the complete product.",
      sources: [{ path: "README.md", role: "primary" }],
      tags: ["product"],
      status: "approved",
      locked: true,
    },
    {
      id: "domain",
      name: "Graph Domain",
      kind: "subsystem",
      summary: "Owns graph rules and stable identities.",
      sources: [{ path: "src/domain/graph.ts", role: "primary" }],
      tags: ["graph"],
      status: "approved",
      locked: true,
    },
    {
      id: "cli",
      name: "CLI Adapter",
      kind: "component",
      summary: "Exposes commands.",
      sources: [{ path: "src/cli/index.ts", role: "primary" }],
      tags: ["adapter"],
      status: "approved",
      locked: false,
    },
  ],
  edges: [
    {
      id: "product-domain",
      from: "product",
      to: "domain",
      relation: "contains",
      description: "Product contains domain.",
      status: "approved",
    },
    {
      id: "cli-domain",
      from: "cli",
      to: "domain",
      relation: "depends-on",
      description: "CLI uses domain.",
      status: "approved",
    },
  ],
};

describe("graph query", () => {
  it("returns a directional neighborhood", () => {
    const result = graphNeighborhood(graph, "domain", 1, "incoming");
    expect(result.nodes.map((node) => node.id)).toEqual(["cli", "domain", "product"]);
    expect(result.edges).toHaveLength(2);
  });

  it("ranks exact and source-path matches", () => {
    expect(searchGraph(graph, "Graph Domain")[0]?.node.id).toBe("domain");
    expect(searchGraph(graph, "src/cli")[0]?.node.id).toBe("cli");
  });
});

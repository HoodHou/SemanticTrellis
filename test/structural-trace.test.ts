import { describe, expect, it } from "vitest";
import {
  STRUCTURAL_SCHEMA_VERSION,
  type StructuralIndex,
  type StructuralSymbol,
} from "../src/domain/structural.js";
import { traceStructuralGraph } from "../src/structural/queries.js";

function symbol(id: string): StructuralSymbol {
  return {
    id,
    path: "src/example.ts",
    name: id,
    qualifiedName: id,
    kind: "function",
    span: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
    signature: `function ${id}()`,
    parentId: "src/example.ts#file",
  };
}

describe("structural trace", () => {
  it("returns only edges traversed by the requested direction and depth", () => {
    const symbols = [symbol("target"), symbol("callerA"), symbol("callerB")];
    const index: StructuralIndex = {
      schemaVersion: STRUCTURAL_SCHEMA_VERSION,
      discoveryMode: "git",
      contributions: {
        "src/example.ts": {
          path: "src/example.ts",
          hash: "hash",
          language: "typescript",
          extractorVersion: "test",
          symbols,
          references: [],
          diagnostics: [],
        },
      },
      edges: [
        { id: "a-target", from: "callerA", to: "target", kind: "call", referenceId: "r1" },
        { id: "b-target", from: "callerB", to: "target", kind: "call", referenceId: "r2" },
        { id: "a-b", from: "callerA", to: "callerB", kind: "call", referenceId: "r3" },
      ],
    };

    const trace = traceStructuralGraph(index, "target", "incoming", 1);

    expect(trace.symbols.map((item) => item.id)).toEqual(["callerA", "callerB", "target"]);
    expect(trace.edges.map((edge) => edge.id)).toEqual(["a-target", "b-target"]);
  });
});

import { describe, expect, it } from "vitest";
import { TypeScriptLanguageAdapter } from "../src/adapters/typescript/typescript-adapter.js";

describe("TypeScript language adapter", () => {
  it("extracts stable symbols and owned references", () => {
    const source = `
class Service extends BaseService {
  run(): void {
    helper();
  }
}

function helper(): void {}
`;
    const contribution = new TypeScriptLanguageAdapter().extract({
      path: "src/service.ts",
      hash: "hash",
      source,
    });

    expect(contribution.symbols.map((symbol) => [symbol.kind, symbol.qualifiedName])).toEqual(
      expect.arrayContaining([
        ["file", "src/service.ts"],
        ["class", "Service"],
        ["method", "Service.run"],
        ["function", "helper"],
      ]),
    );
    const run = contribution.symbols.find((symbol) => symbol.qualifiedName === "Service.run");
    expect(contribution.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "call", targetName: "helper", ownerSymbolId: run?.id }),
        expect.objectContaining({ kind: "extends", targetName: "BaseService" }),
      ]),
    );
  });
});

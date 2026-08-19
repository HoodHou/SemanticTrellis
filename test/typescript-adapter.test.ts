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

  it("creates stable scopes for string-labelled test callbacks", () => {
    const contribution = new TypeScriptLanguageAdapter().extract({
      path: "test/example.test.ts",
      hash: "hash",
      source: `describe("example", () => {
        it("works", () => {
          expect(value).toBe(true);
        });
      });`,
    });

    expect(contribution.symbols.map((symbol) => [symbol.kind, symbol.qualifiedName])).toEqual(
      expect.arrayContaining([
        ["callback", "describe \"example\""],
        ["callback", "describe \"example\".it \"works\""],
      ]),
    );
    const inner = contribution.symbols.find(
      (symbol) => symbol.qualifiedName === "describe \"example\".it \"works\"",
    );
    expect(contribution.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "call", targetName: "expect", ownerSymbolId: inner?.id }),
      ]),
    );
  });

  it("keeps reference identity stable when lines move", () => {
    const adapter = new TypeScriptLanguageAdapter();
    const source = "export function run(): void { helper(); }\n";
    const before = adapter.extract({ path: "src/run.ts", hash: "before", source });
    const after = adapter.extract({
      path: "src/run.ts",
      hash: "after",
      source: `// inserted header\n${source}`,
    });

    expect(after.references.map((reference) => reference.id)).toEqual(
      before.references.map((reference) => reference.id),
    );
    expect(after.references[0]?.line).toBe((before.references[0]?.line ?? 0) + 1);
  });
});

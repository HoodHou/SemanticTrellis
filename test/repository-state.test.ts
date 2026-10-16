import { describe, expect, it } from "vitest";
import { parseGitPorcelain } from "../src/infrastructure/repository-state.js";
import { CSharpLanguageAdapter } from "../src/adapters/csharp/csharp-adapter.js";
import { LuaLanguageAdapter } from "../src/adapters/lua/lua-adapter.js";
import { MarkdownLanguageAdapter } from "../src/adapters/markdown/markdown-adapter.js";
import { PythonLanguageAdapter } from "../src/adapters/python/python-adapter.js";
import { StrellisJsonLanguageAdapter } from "../src/adapters/strellis-json/strellis-json-adapter.js";
import { TypeScriptLanguageAdapter } from "../src/adapters/typescript/typescript-adapter.js";
import { EXTRACTOR_FINGERPRINT } from "../src/structural/freshness.js";

describe("git porcelain parsing", () => {
  it("reads one revision, tracked edits, renames, and untracked files", () => {
    const oid = "a".repeat(40);
    const stdout = [
      `# branch.oid ${oid}`,
      "# branch.head main",
      "1 .M N... 100644 100644 100644 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb src/edited file.ts",
      "2 R. N... 100644 100644 100644 cccccccccccccccccccccccccccccccccccccccc cccccccccccccccccccccccccccccccccccccccc R100 src/next.ts",
      "src/old.ts",
      "? docs/new.md",
    ].join("\0") + "\0";
    expect(parseGitPorcelain(stdout)).toEqual({
      revision: oid,
      changedPaths: ["docs/new.md", "src/edited file.ts", "src/next.ts", "src/old.ts"],
      untrackedPaths: ["docs/new.md"],
    });
  });

  it("treats an unborn repository as having no revision", () => {
    expect(parseGitPorcelain(`# branch.oid ${"0".repeat(40)}\0? src/new.ts\0`).revision).toBe("UNBORN");
  });
});

describe("extractor fingerprint", () => {
  it("matches the installed language adapters", () => {
    const actual = [
      new CSharpLanguageAdapter(),
      new LuaLanguageAdapter(),
      new MarkdownLanguageAdapter(),
      new PythonLanguageAdapter(),
      new StrellisJsonLanguageAdapter(),
      new TypeScriptLanguageAdapter(),
    ].map((adapter) => `${adapter.id}:${adapter.version}`).sort().join("\n");
    expect(actual).toBe(EXTRACTOR_FINGERPRINT.split("\n").sort().join("\n"));
  });
});

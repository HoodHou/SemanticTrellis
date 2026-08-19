import { describe, expect, it } from "vitest";
import { LuaLanguageAdapter } from "../src/adapters/lua/lua-adapter.js";
import { createDefaultLanguageRegistry } from "../src/structural/registry.js";
import { resolveStructuralGraph } from "../src/structural/resolver.js";

describe("Lua language adapter", () => {
  it("extracts modules, functions, table methods, callbacks, requires, and invokes", () => {
    const contribution = new LuaLanguageAdapter().extract({
      path: "pkg/service.lua",
      hash: "service",
      source: `local M = {}
local function helper(value, ...)
  return value
end

function M.run(value)
  return helper(value)
end

function M:stop(reason)
  self.reason = reason
end

M.fetch = function(url, timeout)
  return client:get(url, timeout)
end

register("event", function(ctx)
  return M.run(ctx)
end)

local dependency = require("pkg.mod")
return M
`,
    });

    expect(contribution.language).toBe("lua");
    expect(contribution.symbols.map((symbol) => [symbol.kind, symbol.qualifiedName])).toEqual(
      expect.arrayContaining([
        ["file", "pkg/service.lua"],
        ["module", "M"],
        ["function", "helper"],
        ["method", "M.run"],
        ["method", "M.stop"],
        ["method", "M.fetch"],
        ["callback", 'register "event"'],
      ]),
    );
    expect(contribution.symbols.find((symbol) => symbol.qualifiedName === "helper")?.callArity)
      .toEqual({ min: 1, max: null });
    expect(contribution.symbols.find((symbol) => symbol.qualifiedName === "M.stop")?.callArity)
      .toEqual({ min: 1, max: 1 });
    const callback = contribution.symbols.find(
      (symbol) => symbol.qualifiedName === 'register "event"',
    );
    expect(contribution.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "import", targetName: "pkg.mod" }),
        expect.objectContaining({
          kind: "invoke",
          targetName: "helper",
          targetQualifier: null,
          argumentCount: 1,
        }),
        expect.objectContaining({
          kind: "invoke",
          targetName: "get",
          targetQualifier: "client.get",
          argumentCount: 2,
        }),
        expect.objectContaining({
          kind: "invoke",
          targetName: "run",
          targetQualifier: "M.run",
          ownerSymbolId: callback?.id,
        }),
      ]),
    );
    expect(contribution.diagnostics).toEqual([]);
    expect(new LuaLanguageAdapter().extract({
      path: "pkg/comments.lua",
      hash: "comments",
      source: "--\nlocal value = 1\n",
    }).diagnostics).toEqual([]);
  });

  it("resolves require modules, local table methods, and self-scoped invokes conservatively", () => {
    const adapter = new LuaLanguageAdapter();
    const dependency = adapter.extract({
      path: "src/pkg/mod.lua",
      hash: "dependency",
      source: `local Mod = {}
function Mod.work(value) return value end
return Mod
`,
    });
    const service = adapter.extract({
      path: "src/service.lua",
      hash: "service",
      source: `local dependency = require("pkg.mod")
local M = {}
local function helper(value) return value end
function M:run(value)
  self:stop()
  dependency.work(value)
  return helper(value)
end
function M:stop() return nil end
local function build() return M.run(1) end
return M
`,
    });
    const resolved = resolveStructuralGraph({
      [dependency.path]: dependency,
      [service.path]: service,
    });
    const stop = service.symbols.find((symbol) => symbol.qualifiedName === "M.stop");
    const run = service.symbols.find((symbol) => symbol.qualifiedName === "M.run");
    const helper = service.symbols.find((symbol) => symbol.qualifiedName === "helper");

    expect(resolved.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "import", to: `${dependency.path}#file` }),
        expect.objectContaining({ kind: "invoke", to: stop?.id }),
        expect.objectContaining({ kind: "invoke", to: run?.id }),
        expect.objectContaining({ kind: "invoke", to: helper?.id }),
      ]),
    );
    expect(resolved.metrics.unknownReceiverReferences).toBe(1);
  });

  it("keeps reference identity stable across line moves and reports recoverable errors", () => {
    const adapter = new LuaLanguageAdapter();
    const source = "local function run() return helper() end\n";
    const before = adapter.extract({ path: "pkg/run.lua", hash: "before", source });
    const after = adapter.extract({
      path: "pkg/run.lua",
      hash: "after",
      source: `-- inserted header\n${source}`,
    });
    expect(after.references.map((reference) => reference.id)).toEqual(
      before.references.map((reference) => reference.id),
    );
    expect(after.references[0]?.line).toBe((before.references[0]?.line ?? 0) + 1);

    const broken = adapter.extract({
      path: "pkg/broken.lua",
      hash: "broken",
      source: "function M.run(\n  return 1\n",
    });
    expect(broken.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "lua-parse-error", path: "pkg/broken.lua" }),
      ]),
    );
  });

  it("registers .lua files", () => {
    expect(createDefaultLanguageRegistry().adapterFor("scripts/service.lua")?.id).toBe("lua");
  });
});

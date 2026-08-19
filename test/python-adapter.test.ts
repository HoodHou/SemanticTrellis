import { describe, expect, it } from "vitest";
import { PythonLanguageAdapter } from "../src/adapters/python/python-adapter.js";
import { createDefaultLanguageRegistry } from "../src/structural/registry.js";
import { resolveStructuralGraph } from "../src/structural/resolver.js";

describe("Python language adapter", () => {
  it("extracts nested declarations, decorators, imports, inheritance, and dynamic invokes", () => {
    const contribution = new PythonLanguageAdapter().extract({
      path: "pkg/service.py",
      hash: "service",
      source: `import os, pkg.tools as tools
from .base import Base

@dataclass
class Service(Base):
    def __init__(self, value: int, optional=2, *args, **kwargs):
        helper(value)

    @property
    def current(self):
        return self._value

    @staticmethod
    async def fetch(url, timeout=3):
        return await client.get(url, timeout=timeout)

async def top(value):
    def nested(item):
        return Service(item)
    return nested(value)
`,
    });

    expect(contribution.language).toBe("python");
    expect(contribution.symbols.map((symbol) => [symbol.kind, symbol.qualifiedName])).toEqual(
      expect.arrayContaining([
        ["file", "pkg/service.py"],
        ["class", "Service"],
        ["constructor", "Service.__init__"],
        ["property", "Service.current"],
        ["method", "Service.fetch"],
        ["function", "top"],
        ["function", "top.nested"],
      ]),
    );
    expect(
      contribution.symbols.find((symbol) => symbol.qualifiedName === "Service.__init__")
        ?.callArity,
    ).toEqual({ min: 1, max: null });
    expect(
      contribution.symbols.find((symbol) => symbol.qualifiedName === "Service.current")
        ?.callArity,
    ).toEqual({ min: 0, max: 0 });
    expect(
      contribution.symbols.find((symbol) => symbol.qualifiedName === "Service.fetch")
        ?.callArity,
    ).toEqual({ min: 1, max: 2 });

    const constructor = contribution.symbols.find(
      (symbol) => symbol.qualifiedName === "Service.__init__",
    );
    const fetch = contribution.symbols.find((symbol) => symbol.qualifiedName === "Service.fetch");
    const nested = contribution.symbols.find((symbol) => symbol.qualifiedName === "top.nested");
    expect(contribution.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "import", targetName: "os" }),
        expect.objectContaining({ kind: "import", targetName: "pkg.tools" }),
        expect.objectContaining({ kind: "import", targetName: ".base" }),
        expect.objectContaining({ kind: "extends", targetName: "Base" }),
        expect.objectContaining({
          kind: "invoke",
          targetName: "helper",
          argumentCount: 1,
          ownerSymbolId: constructor?.id,
        }),
        expect.objectContaining({
          kind: "invoke",
          targetName: "get",
          targetQualifier: "client.get",
          argumentCount: 2,
          ownerSymbolId: fetch?.id,
        }),
        expect.objectContaining({
          kind: "invoke",
          targetName: "Service",
          ownerSymbolId: nested?.id,
        }),
      ]),
    );
    expect(contribution.diagnostics).toEqual([]);
  });

  it("resolves Python modules, classes, functions, and self-scoped methods conservatively", () => {
    const adapter = new PythonLanguageAdapter();
    const base = adapter.extract({
      path: "src/pkg/base.py",
      hash: "base",
      source: "class Base:\n    pass\n",
    });
    const helper = adapter.extract({
      path: "src/pkg/helper.py",
      hash: "helper",
      source: "def helper(value):\n    return value\n",
    });
    const service = adapter.extract({
      path: "src/pkg/service.py",
      hash: "service",
      source: `from .base import Base
from pkg.helper import helper

class Service(Base):
    def run(self, value):
        self.stop()
        client.send(value)
        return helper(value)

    def stop(self):
        return None

def build():
    return Service()
`,
    });
    const resolved = resolveStructuralGraph({
      [base.path]: base,
      [helper.path]: helper,
      [service.path]: service,
    });
    const serviceType = service.symbols.find((symbol) => symbol.qualifiedName === "Service");
    const stop = service.symbols.find((symbol) => symbol.qualifiedName === "Service.stop");
    const helperFunction = helper.symbols.find((symbol) => symbol.qualifiedName === "helper");

    expect(resolved.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "import", to: `${base.path}#file` }),
        expect.objectContaining({ kind: "import", to: `${helper.path}#file` }),
        expect.objectContaining({ kind: "extends", to: expect.stringContaining("#class:Base") }),
        expect.objectContaining({ kind: "invoke", to: stop?.id }),
        expect.objectContaining({ kind: "invoke", to: helperFunction?.id }),
        expect.objectContaining({ kind: "invoke", to: serviceType?.id }),
      ]),
    );
    expect(resolved.metrics.unknownReceiverReferences).toBe(1);
  });

  it("keeps reference identity stable across line moves and reports recoverable errors", () => {
    const adapter = new PythonLanguageAdapter();
    const source = "def run():\n    return helper()\n";
    const before = adapter.extract({ path: "pkg/run.py", hash: "before", source });
    const after = adapter.extract({
      path: "pkg/run.py",
      hash: "after",
      source: `# inserted header\n${source}`,
    });
    expect(after.references.map((reference) => reference.id)).toEqual(
      before.references.map((reference) => reference.id),
    );
    expect(after.references[0]?.line).toBe((before.references[0]?.line ?? 0) + 1);

    const broken = adapter.extract({
      path: "pkg/broken.py",
      hash: "broken",
      source: "def broken(:\n    return 1\n",
    });
    expect(broken.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "python-parse-error", path: "pkg/broken.py" }),
      ]),
    );
  });

  it("registers .py and .pyi files", () => {
    const registry = createDefaultLanguageRegistry();
    expect(registry.adapterFor("pkg/service.py")?.id).toBe("python");
    expect(registry.adapterFor("pkg/service.pyi")?.id).toBe("python");
  });
});

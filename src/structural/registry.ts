import { extname } from "node:path";
import { CSharpLanguageAdapter } from "../adapters/csharp/csharp-adapter.js";
import { LuaLanguageAdapter } from "../adapters/lua/lua-adapter.js";
import { MarkdownLanguageAdapter } from "../adapters/markdown/markdown-adapter.js";
import { PythonLanguageAdapter } from "../adapters/python/python-adapter.js";
import { StrellisJsonLanguageAdapter } from "../adapters/strellis-json/strellis-json-adapter.js";
import { TypeScriptLanguageAdapter } from "../adapters/typescript/typescript-adapter.js";
import type { LanguageAdapter } from "../ports/language-adapter.js";

export class LanguageRegistry {
  private readonly byExtension = new Map<string, LanguageAdapter>();

  constructor(adapters: LanguageAdapter[]) {
    for (const adapter of adapters) {
      for (const extension of adapter.extensions) {
        const normalized = extension.toLowerCase();
        if (this.byExtension.has(normalized)) {
          throw new Error(`More than one language adapter claims ${normalized}.`);
        }
        this.byExtension.set(normalized, adapter);
      }
    }
  }

  adapterFor(path: string): LanguageAdapter | null {
    const adapter = this.byExtension.get(extname(path).toLowerCase()) ?? null;
    if (adapter === null) return null;
    if (adapter.matches !== undefined && !adapter.matches(path)) return null;
    return adapter;
  }
}

export function createDefaultLanguageRegistry(): LanguageRegistry {
  return new LanguageRegistry([
    new CSharpLanguageAdapter(),
    new LuaLanguageAdapter(),
    new MarkdownLanguageAdapter(),
    new PythonLanguageAdapter(),
    new StrellisJsonLanguageAdapter(),
    new TypeScriptLanguageAdapter(),
  ]);
}

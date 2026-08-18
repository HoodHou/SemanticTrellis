import csharp from "@ast-grep/lang-csharp";
import { registerDynamicLanguage } from "@ast-grep/napi";

let registered = false;

export function ensureAstGrepLanguages(): void {
  if (registered) return;
  registerDynamicLanguage({ csharp });
  registered = true;
}

import ts from "typescript6";

/**
 * Every string a module's source spells, as the program reads it: each string literal, each
 * template literal without a substitution, and each text piece of a template between its `${…}`
 * (head, middles, tail), with the escapes decoded (`"a\nb"` is a newline, not `n`), and those inside
 * a template's substitutions too. Parsed with the check's own TypeScript (`typescript6`, the reason is
 * `module-check.core.ts`'s header), so a quote inside a comment or a regular expression is not a
 * literal and a string nested in a `${…}` is one.
 *
 * `@graft/stock`'s scrub keeps these as public code (`keptLiteralsOf`, GRA-257). A file whose path
 * names no script or JSON kind is skipped: its strings are not the module's constants, and a value
 * not kept is scrubbed, which is the safe side.
 */
export function stringLiteralsOf(files: readonly { path: string; content: string }[]): string[] {
  const found = new Set<string>();
  for (const file of files) {
    const kind = scriptKindOf(file.path);
    if (kind === null) continue;
    const source = ts.createSourceFile(
      file.path,
      file.content,
      ts.ScriptTarget.Latest,
      false,
      kind,
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        found.add(node.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...found];
}

function scriptKindOf(path: string): ts.ScriptKind | null {
  const extension = /\.[^./]+$/.exec(path)?.[0].toLowerCase();
  switch (extension) {
    case ".ts":
    case ".mts":
    case ".cts":
      return ts.ScriptKind.TS;
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".json":
      return ts.ScriptKind.JSON;
    default:
      return null;
  }
}

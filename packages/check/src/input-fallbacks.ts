import ts from "typescript6";

/**
 * The input fields a module's default export falls back on when they are absent, read off its
 * syntax tree (the check's own TypeScript, as `string-literals.ts` parses): the left operand of a
 * `??` or `||` that is a read of the input parameter (`input.limit ?? 10`, `input?.limit || 10`,
 * `input["limit"] ?? 10`), and a destructuring default taken off it (`({ limit = 10 }: Input)`, or
 * `const { limit = 10 } = input`). A comment, a string and a nested function whose own parameter
 * shadows the input's name read nothing.
 *
 * The default export of the entry is followed, and nothing past it: a field handed to a helper and
 * defaulted there is not seen. `@graft/stock`'s harness reads this to find a required field the
 * module does without (GRA-279), so a miss lets a defect through and never refuses a good module.
 */
export function inputFallbacksOf(
  files: readonly { path: string; content: string }[],
  entry: string,
): string[] {
  const file = files.find((candidate) => candidate.path === entry);
  if (!file) return [];
  const kind = /\.(?:m|c)?jsx?$/i.test(entry) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(entry, file.content, ts.ScriptTarget.Latest, true, kind);
  const fn = defaultExportFunction(source);
  const parameter = fn?.parameters[0];
  if (!fn || !parameter) return [];

  const found = new Set<string>();
  if (ts.isObjectBindingPattern(parameter.name)) {
    collectBindingDefaults(parameter.name, found);
    return [...found].sort();
  }
  if (!ts.isIdentifier(parameter.name)) return [];
  const name = parameter.name.text;

  const isInput = (node: ts.Expression): boolean => {
    const inner = unwrap(node);
    return ts.isIdentifier(inner) && inner.text === name;
  };
  const visit = (node: ts.Node): void => {
    if (node !== fn && ts.isFunctionLike(node) && shadows(node, name)) return;
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      const field = fieldRead(unwrap(node.left), isInput);
      if (field !== null) found.add(field);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      isInput(node.initializer)
    ) {
      collectBindingDefaults(node.name, found);
    }
    ts.forEachChild(node, visit);
  };
  if (fn.body) visit(fn.body);
  return [...found].sort();
}

type ExportedFunction = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;

function defaultExportFunction(source: ts.SourceFile): ExportedFunction | null {
  for (const statement of source.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      return statement;
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const inner = unwrap(statement.expression);
      if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) return inner;
      if (ts.isIdentifier(inner)) return localFunction(source, inner.text);
    }
  }
  return null;
}

function localFunction(source: ts.SourceFile, name: string): ExportedFunction | null {
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
      const init = declaration.initializer && unwrap(declaration.initializer);
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return init;
    }
  }
  return null;
}

function fieldRead(node: ts.Expression, isInput: (node: ts.Expression) => boolean): string | null {
  if (ts.isPropertyAccessExpression(node) && isInput(node.expression)) return node.name.text;
  if (
    ts.isElementAccessExpression(node) &&
    isInput(node.expression) &&
    ts.isStringLiteralLike(node.argumentExpression)
  ) {
    return node.argumentExpression.text;
  }
  return null;
}

function collectBindingDefaults(pattern: ts.ObjectBindingPattern, found: Set<string>): void {
  for (const element of pattern.elements) {
    if (!element.initializer || element.dotDotDotToken) continue;
    const key = element.propertyName ?? element.name;
    if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) found.add(key.text);
  }
}

/** Through parentheses, `as`, `satisfies`, `!` and a type assertion, to the expression inside. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** Does this function declare a parameter of the input's name, so `name` inside it is another? */
function shadows(fn: ts.SignatureDeclaration, name: string): boolean {
  return fn.parameters.some(
    (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name,
  );
}

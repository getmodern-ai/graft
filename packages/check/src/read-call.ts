import { classifyRequest, type RequestToClassify } from "@graft/proxy/read-request";
import ts from "typescript6";

/**
 * Whether a `fetch(path, init)` call the check can see is a read (ADR 0008 as amended 2026-10-10),
 * judged by the proxy's own classifier (`@graft/proxy`'s `read-request.ts`) on the request as far
 * as the source states it, so the check's annotation and the dry run's write-stop cannot disagree
 * about a call the check can read. What the source does not state is what makes a write:
 *
 * - the **method** is the literal the core's `fetchMethod` read (`GET` with no `init`);
 * - the **path** is the first argument when it is built from literals; otherwise none, so neither
 *   a GraphQL endpoint nor a table entry can match;
 * - the **host** is `init.host` when it is built from literals; otherwise null, since a relative
 *   path goes to the connection's primary host, which a module does not choose, so a table entry
 *   (which names its host) matches only a call that names the host itself;
 * - the **body** is `JSON.stringify({ … })` of an object literal, or a JSON string built from
 *   literals. A key whose value is not built from literals carries `null`, so a `query` the check
 *   cannot read is not a string and the call is a write; a spread, a computed key or a method makes
 *   the whole body unknown.
 *
 * "Built from literals": a string literal, a template with no substitution, a `+` of two such, or
 * an identifier declared exactly once in the file, as a `const` whose initialiser is built from
 * literals. Declared once, by name, so a shadowing declaration anywhere in the file (a parameter,
 * a nested `const`, an import) leaves the name unfollowed rather than followed to the wrong value.
 * `JSON.stringify` is the global only when the file declares no `JSON` of its own and nothing in
 * it writes to a member of `JSON` or names `toJSON` (Greptile on #200).
 *
 * The `init` itself must be an object literal of plainly named properties: a spread, a computed key,
 * a method or an accessor in it may replace the `body` or the `host` the check read, so any of them
 * makes the call a write; a name given twice is read as JavaScript reads it, the last one winning.
 *
 * This is the annotation's source, not its guarantee: a module can still change what leaves at run
 * time in ways no static reading sees, so the proxy classifies every request a read-only tool's run
 * makes with the same function and refuses a write as `annotation_mismatch` (`app.ts`).
 */

/** Every name the file declares, with how many times: what a name is followed by. */
export type Declarations = Map<string, ts.Node[]>;

const NAMED_DECLARATIONS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.Parameter,
  ts.SyntaxKind.BindingElement,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.ImportClause,
  ts.SyntaxKind.ImportSpecifier,
  ts.SyntaxKind.NamespaceImport,
  ts.SyntaxKind.ImportEqualsDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.ModuleDeclaration,
]);

export function declarationsOf(sf: ts.SourceFile): Declarations {
  const declarations: Declarations = new Map();
  const visit = (node: ts.Node): void => {
    if (NAMED_DECLARATIONS.has(node.kind)) {
      const name = (node as ts.NamedDeclaration).name;
      if (name && ts.isIdentifier(name)) {
        const list = declarations.get(name.text) ?? [];
        list.push(node);
        declarations.set(name.text, list);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return declarations;
}

/** How deep a chain of consts is followed; past it, the value is unknown. */
const MAX_FOLLOW = 8;

/** The string an expression is built from literals to, or null. */
export function literalString(
  expression: ts.Expression | undefined,
  declarations: Declarations,
  depth = 0,
): string | null {
  if (expression === undefined || depth > MAX_FOLLOW) return null;
  const expr = unwrap(expression);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literalString(expr.left, declarations, depth + 1);
    const right = left === null ? null : literalString(expr.right, declarations, depth + 1);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isIdentifier(expr)) {
    const found = declarations.get(expr.text);
    const only = found?.length === 1 ? found[0] : undefined;
    if (
      only === undefined ||
      !ts.isVariableDeclaration(only) ||
      only.initializer === undefined ||
      !ts.isVariableDeclarationList(only.parent) ||
      (only.parent.flags & ts.NodeFlags.Const) === 0
    ) {
      return null;
    }
    return literalString(only.initializer, declarations, depth + 1);
  }
  return null;
}

/** Parentheses, `as` and `satisfies` change nothing a request carries. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * Whether the call is a read, given the method the core read off `init` (upper case, never null:
 * a method the check cannot read is a write before this is asked).
 */
export function isReadCall(
  call: ts.CallExpression,
  method: string,
  declarations: Declarations,
  /** Whether any file of the module may change what `JSON.stringify` answers (`stringifyTampered`). */
  bodiesUnknown = false,
): boolean {
  const init = call.arguments[1] === undefined ? null : unwrap(call.arguments[1]);
  const literalInit = init !== null && ts.isObjectLiteralExpression(init) ? init : null;
  if (literalInit !== null && !plainlyNamed(literalInit)) return false;
  const rawPath = literalString(call.arguments[0], declarations);
  let path = "";
  let hasQuery = false;
  if (rawPath !== null && !rawPath.includes("#")) {
    const at = rawPath.indexOf("?");
    path = at === -1 ? rawPath : rawPath.slice(0, at);
    hasQuery = at !== -1;
  }
  const host = literalInit ? literalString(propertyValue(literalInit, "host"), declarations) : null;
  const request: RequestToClassify = {
    method,
    host: host === null ? null : host.toLowerCase(),
    path,
    hasQuery,
    body:
      literalInit && !bodiesUnknown
        ? staticBody(propertyValue(literalInit, "body"), declarations)
        : null,
  };
  return classifyRequest(request).read;
}

/**
 * Whether every property of the literal is a plain assignment or shorthand under a name the check
 * can read: no spread, no computed key, no method, no accessor, any of which may set `body`, `host`
 * or `method` to something the check did not read (Greptile on #200).
 */
function plainlyNamed(literal: ts.ObjectLiteralExpression): boolean {
  return literal.properties.every(
    (property) =>
      ts.isShorthandPropertyAssignment(property) ||
      (ts.isPropertyAssignment(property) && keyOf(property) !== null),
  );
}

/**
 * A property's value in an object literal, by name, the last one winning as it does in JavaScript;
 * undefined when absent.
 */
function propertyValue(
  literal: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  let found: ts.Expression | undefined;
  for (const property of literal.properties) {
    if (ts.isPropertyAssignment(property) && keyOf(property) === name) found = property.initializer;
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) {
      found = property.name;
    }
  }
  return found;
}

function keyOf(property: ts.ObjectLiteralElementLike): string | null {
  const name = property.name;
  if (!name) return null;
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  return null;
}

/** The body as far as the source states it, in `RequestToClassify.body`'s shape. */
function staticBody(
  expression: ts.Expression | undefined,
  declarations: Declarations,
): RequestToClassify["body"] {
  if (expression === undefined) return null;
  const expr = unwrap(expression);
  const text = literalString(expr, declarations);
  if (text !== null) {
    try {
      return { json: JSON.parse(text) };
    } catch {
      return null;
    }
  }
  if (
    !ts.isCallExpression(expr) ||
    expr.arguments.length !== 1 ||
    !isGlobalJsonStringify(expr.expression, declarations)
  ) {
    return null;
  }
  const argument = unwrap(expr.arguments[0] as ts.Expression);
  if (!ts.isObjectLiteralExpression(argument)) return null;
  const json: Record<string, unknown> = {};
  for (const property of argument.properties) {
    if (ts.isPropertyAssignment(property)) {
      const key = keyOf(property);
      if (key === null) return null;
      json[key] = literalString(property.initializer, declarations);
    } else if (ts.isShorthandPropertyAssignment(property)) {
      json[property.name.text] = literalString(property.name, declarations);
    } else {
      return null;
    }
  }
  return { json };
}

/**
 * Whether the file may change what `JSON.stringify` (or the vendor's own `JSON.parse` of a literal)
 * produces: an assignment to a member of `JSON`, or the name `toJSON` anywhere, which a module can
 * put on a prototype to replace the body the check read. Either, in any file of the module, makes
 * every body in the module unknown, so its non-`GET` calls are writes. A cheap reading for the plain spellings; the proxy's run-time
 * classification is what holds for the rest (Greptile on #200).
 */
export function stringifyTampered(sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isPrivateIdentifier(node)) &&
      node.text === "toJSON"
    ) {
      found = true;
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      namesJsonMember(node.left)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function namesJsonMember(target: ts.Expression): boolean {
  const expr = unwrap(target);
  return (
    (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) &&
    ts.isIdentifier(unwrap(expr.expression)) &&
    (unwrap(expr.expression) as ts.Identifier).text === "JSON"
  );
}

function isGlobalJsonStringify(callee: ts.Expression, declarations: Declarations): boolean {
  const expr = unwrap(callee);
  return (
    ts.isPropertyAccessExpression(expr) &&
    expr.name.text === "stringify" &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "JSON" &&
    !declarations.has("JSON")
  );
}

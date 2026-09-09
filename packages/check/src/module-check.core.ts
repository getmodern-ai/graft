import { builtinModules } from "node:module";
import { posix } from "node:path";

import ts from "typescript6";

import { type ToolAnnotations, UNKNOWN_ANNOTATIONS } from "./annotations.ts";

/**
 * The static check of an authored module (`CONTEXT.md`, "Check"). Pure: files in, diagnostics and
 * annotations out, no sandbox and no network. `module-check.ts` is the door — it runs this in a worker
 * thread under a size and time budget — and `module-check.worker.ts` is the thread's entry. Nothing
 * here may import from the rest of the package: this file and its imports are the whole of what the
 * worker loads, and Node resolves them natively (so `.ts` siblings need their extension, and nothing
 * here reaches `@graft/*`).
 *
 * `typescript6`, not `typescript`: the catalog's TypeScript 7 is the Go-native compiler and its npm
 * package ships `tsc` alone — `createProgram`, `createSourceFile` and the rest of the JS API are not in
 * it — so the check pins the last JS-based line under an alias in this package's `package.json`, and
 * `tsc` for the repo stays on 7 (the catalog comment in `pnpm-workspace.yaml`).
 *
 * ## What is checked, and how
 *
 * A virtual TypeScript program: the module's files mounted under `/module`, three ambient declarations
 * under `/graft` — `Input`, generated from the tool's JSON Schema (`inputTypeFromSchema`); `Context`,
 * the four names the runner's `ctx` carries (`CONTEXT_DECLARATION`, matched by `runner.mjs`) with a
 * DOM-free `Response` and the Node globals a module may lean on (`RUNTIME_DECLARATIONS`); and a
 * shorthand `declare module` for every package the version vendors — and a wrapper that imports the
 * entry's default export and assigns it to `(input: Input, ctx: Context) => Promise<unknown>`. The
 * entry's default export is also re-typed *in place* when it is a function literal
 * (`castDefaultExport`), so an unannotated `(input, ctx)` is contextually typed and `input.quanity` is
 * an error at the line that reads it — the diagnostic the whole feature exists for — rather than an
 * `any` that passes.
 *
 * A **refusal** is what publish refuses on; **advice** rides along. The rule names are the vocabulary
 * the model reads back, so they are exported and pinned in the tests. Every diagnostic carries the
 * file, line, column, the offending line and a hint the model can act on in one edit.
 *
 * Three rules are Graft's own. `sdk-not-bound` (ADR 0010): a client constructed from a vendored
 * package must take `ctx.proxyKey` as its credential and a `ctx.proxyBase(...)` call as its base, and
 * nothing else in either slot. `import-not-vendored` (ADR 0013): a package import resolves only into
 * the version's own `node_modules`, so it is allowed only when the module's `package.json` declares
 * it. And the **annotations** (ADR 0008): `readOnly` and `destructive` are read off the HTTP methods
 * the module's calls use, never off anything the module says about itself — `deriveAnnotations`.
 *
 * `.ts` is the contract's entry; `.mjs` is still accepted and checked as JavaScript (`checkJs`), with
 * the same in-place typing through a JSDoc cast. Node 24 runs `.ts` by stripping types, which is
 * exactly why non-erasable syntax is a refusal here: an `enum` compiles and then fails to *load* in
 * the sandbox (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`), where nothing reads it back to the model.
 */

export type ModuleCheckFile = { path: string; content: string };

export type ModuleCheckInput = {
  /** Every file of the module, paths relative to its directory (`readModuleSources`' shape). */
  files: readonly ModuleCheckFile[];
  /** The entry, relative to the module — `index.ts`, `index.mjs`, or the single file. */
  entry: string;
  /** The JSON Schema the tool is (to be) published with; absent, `Input` is `any` and says so. */
  inputSchema?: Record<string, unknown> | null;
  /**
   * The packages the version vendors — the names under `dependencies` in the module's `package.json`
   * (`readModuleSources` reads them). A bare import of anything else is `import-not-vendored`. Absent
   * or empty, no package import is allowed (ADR 0013).
   */
  dependencies?: readonly string[] | null;
};

export const REFUSAL_RULES = [
  "syntax",
  "default-export-missing",
  "default-export-not-async",
  "default-export-arity",
  "default-export-type",
  "type-error",
  "type-import",
  "execute-environment",
  "banned-module",
  "import-outside-module",
  "import-not-vendored",
  "import-unresolved",
  "fetch-absolute-url",
  "global-fetch",
  "sdk-not-bound",
  "non-erasable-syntax",
  "entry-missing",
  "budget",
  "check-failed",
] as const;

export const ADVICE_RULES = [
  "implicit-any",
  "unread-input-field",
  "non-json-return",
  "no-return",
  "no-input-schema",
] as const;

export type RefusalRule = (typeof REFUSAL_RULES)[number];
export type AdviceRule = (typeof ADVICE_RULES)[number];
export type DiagnosticRule = RefusalRule | AdviceRule;

export type Diagnostic = {
  /** Relative to the module, as the model wrote it — `index.ts`, `lib/client.ts`. */
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  /** The offending source line, trimmed. */
  text: string;
  message: string;
  /** One line the model can act on. */
  hint: string;
  rule: DiagnosticRule;
};

export { type ToolAnnotations, UNKNOWN_ANNOTATIONS };

export type ModuleCheckResult = {
  entry: string | null;
  refusals: Diagnostic[];
  advice: Diagnostic[];
  annotations: ToolAnnotations;
};

/**
 * The module's whole route out, as a type: exactly what the runner's `ctx` carries (`runner.mjs`,
 * `Object.freeze({ fetch, proxyBase, proxyKey, connection })`). `proxyBase` and `proxyKey` are the two
 * an SDK is bound with (ADR 0010).
 */
export const CONTEXT_DECLARATION =
  "{ fetch(path: string, init?: RequestInit): Promise<Response>; proxyBase(host?: string): string; proxyKey: string; connection: string | null }";

/** The type the default export must satisfy; declared globally so the entry can be re-typed in place. */
const TOOL_TYPE = "__GraftTool";

/** Bare or `node:`-prefixed, these are refused outright: a tool makes one HTTP call, nothing else. */
export const BANNED_MODULES = ["child_process", "net", "dgram"] as const;

/**
 * The option names an SDK takes its credential and its base URL under, across the SDKs the recipe was
 * checked against (Linear `apiKey`/`apiUrl`, Notion `auth`/`baseUrl`, Airtable `apiKey`/`endpointUrl`,
 * Slack `slackApiUrl`, Google `auth`/`rootUrl`, Octokit `auth`/`baseUrl`) and the spellings a model is
 * likely to reach for beside them. A name here is a slot the rule inspects; a credential under a name
 * not here is a miss the rule accepts, which is why the list errs long.
 */
export const SDK_CREDENTIAL_OPTIONS = [
  "apiKey",
  "api_key",
  "apikey",
  "apiToken",
  "api_token",
  "auth",
  "authToken",
  "auth_token",
  "authorization",
  "accessToken",
  "access_token",
  "bearerToken",
  "clientSecret",
  "client_secret",
  "credentials",
  "key",
  "password",
  "personalAccessToken",
  "secret",
  "secretKey",
  "secret_key",
  "token",
] as const;

export const SDK_BASE_OPTIONS = [
  "apiBase",
  "apiEndpoint",
  "apiHost",
  "apiUrl",
  "api_url",
  "basePath",
  "baseUrl",
  "baseURL",
  "base_url",
  "endpoint",
  "endpointUrl",
  "host",
  "hostname",
  "origin",
  "rootUrl",
  "server",
  "serverUrl",
  "slackApiUrl",
  "url",
] as const;

/** Header-bag options an SDK takes; an authentication header inside one is a credential of the module's own. */
const SDK_HEADER_OPTIONS: ReadonlySet<string> = new Set([
  "headers",
  "defaultHeaders",
  "customHeaders",
  "extraHeaders",
]);
const AUTH_HEADERS =
  /^(authorization|proxy-authorization|cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token)$/i;

/**
 * The one SDK with a rule of its own: `@slack/web-api` treats a method name that is an absolute URL as
 * the URL to call, so a `WebClient` pointed at the proxy still escapes it unless told not to.
 */
const SLACK_PACKAGE = "@slack/web-api";
const SLACK_ABSOLUTE_URLS_OPTION = "allowAbsoluteUrls";

/** How many diagnostics of each kind reach the model; the check is rerun after a fix anyway. */
const MAX_DIAGNOSTICS = 50;
const MAX_TEXT_CHARS = 200;

const MODULE_ROOT = "/module";
const GRAFT_ROOT = "/graft";
const CONTRACT_FILE = `${GRAFT_ROOT}/contract.d.ts`;
const RUNTIME_FILE = `${GRAFT_ROOT}/runtime.d.ts`;
const VENDORED_FILE = `${GRAFT_ROOT}/vendored.d.ts`;
const WRAPPER_FILE = `${GRAFT_ROOT}/entry-check.ts`;

const TS_EXTENSIONS = [".ts", ".mts"];
const JS_EXTENSIONS = [".mjs", ".js", ".cjs"];
const JSX_EXTENSIONS = [".tsx", ".jsx"];
const CODE_EXTENSIONS = [...TS_EXTENSIONS, ...JS_EXTENSIONS];

const NODE_BUILTINS: ReadonlySet<string> = new Set(
  builtinModules.map((name) => name.replace(/^node:/, "")),
);
const BANNED: ReadonlySet<string> = new Set(BANNED_MODULES);
const CREDENTIAL_OPTIONS: ReadonlySet<string> = new Set(SDK_CREDENTIAL_OPTIONS);
const BASE_OPTIONS: ReadonlySet<string> = new Set(SDK_BASE_OPTIONS);

/** The methods the proxy forwards in a dry run and the annotations count as reads (ADR 0008). */
const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/**
 * TypeScript's "implicitly has an 'any' type" family. Advice, not refusal: `strict` reports them and
 * the module still runs, but a value nothing knows the shape of is exactly where a typo hides.
 */
const IMPLICIT_ANY_CODES: ReadonlySet<number> = new Set([
  7005, 7006, 7008, 7009, 7010, 7011, 7015, 7016, 7017, 7018, 7019, 7022, 7023, 7024, 7031, 7032,
  7033, 7034, 7051, 7053,
]);

/**
 * `strict`, but the catch variable stays `any`: `catch (error) { error.message }` is how a module
 * reports a vendor failure, and refusing it would teach the model to annotate `unknown` and cast.
 * `verbatimModuleSyntax` is on because Node strips *types*, not imports — a type imported as a value
 * loads as a missing export in the sandbox (`type-import` below). `types: []` keeps the host's own
 * `@types/node` out of the program: the sandbox is Node 24 without it, and `RUNTIME_DECLARATIONS`
 * says what a module may rely on. The lib is ES2024, what Node 24 implements.
 */
const OPTIONS: ts.CompilerOptions = {
  strict: true,
  useUnknownInCatchVariables: false,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2024.d.ts"],
  types: [],
  allowJs: true,
  checkJs: true,
  resolveJsonModule: true,
  allowImportingTsExtensions: true,
  verbatimModuleSyntax: true,
  skipLibCheck: true,
  allowSyntheticDefaultImports: true,
  esModuleInterop: true,
  forceConsistentCasingInFileNames: true,
  noUnusedLocals: false,
  noUnusedParameters: false,
};

/* -------------------------------------- the check -------------------------------------- */

/**
 * The whole check, synchronously, in whichever thread calls it. `module-check.ts` calls it from a
 * worker so a pathological module cannot hold the server; the tests call it directly.
 */
export function checkModuleSync(input: ModuleCheckInput): ModuleCheckResult {
  const module = mountModule(input.files);
  const entryRel = normaliseRelative(input.entry);
  const entryAbs = `${MODULE_ROOT}/${entryRel}`;
  const entrySource = module.originals.get(entryAbs);
  const bag = new DiagnosticBag(module.originals, entryAbs);
  const dependencies = new Set(input.dependencies ?? []);

  if (!entrySource) {
    bag.plain("entry-missing", entryRel, {
      message: `The module has no entry ${entryRel}: a directory holds index.ts (or index.mjs) at its top level, or the module is a single .ts or .mjs file.`,
      hint: "Write the default export in index.ts beside the module's other files, and check it again.",
    });
    return bag.result(entryRel, UNKNOWN_ANNOTATIONS);
  }

  const schema = objectOrNull(input.inputSchema);
  const declaredFields = schema ? Object.keys(propertiesOf(schema)) : [];
  const entryIsTs = TS_EXTENSIONS.some((ext) => entryRel.endsWith(ext));
  const exported = analyseDefaultExport(entrySource);
  const exportPos = exported?.pos ?? 0;

  // Rules over the model's own text, before the compiler sees anything.
  for (const [abs, source] of module.originals) {
    scanText(source, abs, bag, module, dependencies);
  }
  for (const rel of module.jsxFiles) {
    bag.plain("non-erasable-syntax", rel, {
      message: `${rel} is JSX, which Node's type stripping does not run.`,
      hint: "A tool has no UI; return data from index.ts.",
    });
  }
  // The SDK rules and the annotations read the same bindings: which identifiers reach a package.
  const bindings = analyseSdkBindings(module);
  const tally: MethodTally = { writes: 0, deletes: 0 };
  for (const [abs, source] of module.originals) {
    scanSdk(source, abs, bag, bindings.get(abs) ?? new Map(), tally);
  }
  const annotations = deriveAnnotations(tally);

  let shapeRefused = false;
  if (exported?.fn) {
    const count = exported.fn.parameters.length;
    if (count !== 2) {
      shapeRefused = true;
      bag.at("default-export-arity", entryAbs, exported.fn.getStart(entrySource), {
        message: `The default export takes ${count} parameter${count === 1 ? "" : "s"}; the runner calls it with two, (input, ctx).`,
        hint: "Declare it as async (input: Input, ctx: Context) => …, even when one of the two goes unused.",
      });
    }
    if (!hasModifier(exported.fn, ts.SyntaxKind.AsyncKeyword)) {
      shapeRefused = true;
      bag.at("default-export-not-async", entryAbs, exported.fn.getStart(entrySource), {
        message: "The default export is not an async function; the runner awaits its result.",
        hint: "Write export default async (input: Input, ctx: Context) => { … }.",
      });
    }
  }

  // The program: the module with its entry re-typed in place, the ambient files, the wrapper.
  const cast =
    exported?.castStart !== undefined && exported.castEnd !== undefined ? exported : null;
  const rewritten =
    cast?.castStart !== undefined && cast.castEnd !== undefined
      ? castDefaultExport(entrySource.text, cast.castStart, cast.castEnd, entryIsTs)
      : { text: entrySource.text, insertions: [] as Insertion[] };
  const virtual = new Map(module.virtual);
  virtual.set(entryAbs, rewritten.text);
  virtual.set(CONTRACT_FILE, contractDeclaration(schema));
  virtual.set(RUNTIME_FILE, RUNTIME_DECLARATIONS);
  virtual.set(VENDORED_FILE, vendoredDeclarations(dependencies));
  virtual.set(WRAPPER_FILE, wrapperSource(entryRel));

  const rootNames = [...module.codeFiles, CONTRACT_FILE, RUNTIME_FILE, VENDORED_FILE, WRAPPER_FILE];
  const program = ts.createProgram(rootNames, OPTIONS, createHost(virtual));
  const checker = program.getTypeChecker();
  const mapBack = (abs: string, pos: number) =>
    abs === entryAbs ? originalPosition(pos, rewritten.insertions) : pos;

  const diagnostics: { diagnostic: ts.Diagnostic; syntactic: boolean }[] = [];
  for (const abs of rootNames) {
    const sf = program.getSourceFile(abs);
    if (!sf) continue;
    for (const d of program.getSyntacticDiagnostics(sf)) {
      diagnostics.push({ diagnostic: d, syntactic: true });
    }
    for (const d of program.getSemanticDiagnostics(sf)) {
      diagnostics.push({ diagnostic: d, syntactic: false });
    }
  }
  for (const d of [...program.getGlobalDiagnostics(), ...program.getOptionsDiagnostics()]) {
    diagnostics.push({ diagnostic: d, syntactic: false });
  }

  for (const { diagnostic, syntactic } of diagnostics) {
    if (diagnostic.category !== ts.DiagnosticCategory.Error) continue;
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
    const fileName = diagnostic.file?.fileName;

    if (fileName === WRAPPER_FILE || fileName === undefined) {
      if (diagnostic.code === 1192 || diagnostic.code === 2613) {
        bag.at("default-export-missing", entryAbs, exportPos, {
          message: `${entryRel} has no default export; the runner has nothing to call.`,
          hint: "Add export default async (input: Input, ctx: Context) => { … } to index.ts.",
        });
      } else if (fileName === WRAPPER_FILE && !cast && !shapeRefused) {
        bag.at("default-export-type", entryAbs, exportPos, {
          message: `The default export is not an async function of (input: Input, ctx: Context): ${inContractWords(message)}`,
          hint: "Export exactly that shape, returning a Promise of plain data.",
        });
      } else if (fileName === undefined && !syntactic) {
        bag.at("type-error", entryAbs, 0, { message, hint: GENERIC_TYPE_HINT });
      }
      continue;
    }
    if (!fileName.startsWith(`${MODULE_ROOT}/`) || diagnostic.start === undefined) continue;

    const pos = mapBack(fileName, diagnostic.start);
    // The in-place cast reports its mismatch in terms of `__GraftTool`. A shape rule above already
    // said why; otherwise say it in the contract's own words, at the export.
    if (fileName === entryAbs && message.includes(TOOL_TYPE)) {
      if (shapeRefused) continue;
      bag.at("default-export-type", entryAbs, pos, {
        message: `The default export is not an async function of (input: Input, ctx: Context): ${inContractWords(message)}`,
        hint: "Export exactly that shape, returning a Promise of plain data.",
      });
      continue;
    }
    // A text rule that already refused this line — a banned import, `import x =`, a decorator —
    // said it better than the compiler's view of the same construct.
    if (bag.refusedOnLineOf(fileName, pos)) continue;

    const classified = classify(diagnostic, message, syntactic, {
      fileName,
      pos,
      module,
      exported,
      declaredFields,
      hasSchema: schema !== null,
    });
    if (!classified) continue;
    const body = { message: classified.message, hint: classified.hint };
    if (classified.advice) bag.advise(classified.rule, fileName, pos, body);
    else bag.at(classified.rule, fileName, pos, body);
  }

  // Advice is read off a program that parsed; under a syntax error it would describe the wrong one.
  if (bag.has("syntax")) return bag.result(entryRel, annotations);

  // Advice: what the module never reads, what it returns, what it was not told.
  if (schema === null) {
    bag.advise("no-input-schema", entryAbs, exportPos, {
      message:
        "No inputSchema was given, so input is any and a read of an undeclared field passes.",
      hint: "Pass the schema you will publish; Input is generated from it and field reads are checked.",
    });
  }
  // A module that hands `input` on whole — `JSON.stringify(input)`, `{ ...input }` — reads every
  // field; the advice is for one that picks fields and misses some.
  if (!usesParameterWhole(exported?.fn ?? null, entrySource)) {
    for (const field of declaredFields) {
      if (module.mentioned.has(field)) continue;
      bag.advise("unread-input-field", entryAbs, exportPos, {
        message: `The schema declares ${field} but the module never reads it.`,
        hint: `Read input${isIdentifier(field) ? `.${field}` : `[${JSON.stringify(field)}]`}, or drop it from the schema so the tool asks only for what it uses.`,
      });
    }
  }
  describeReturn(program, checker, bag, entryAbs, exportPos);

  return bag.result(entryRel, annotations);
}

/** The compiler's `__GraftTool` is our `(input: Input, ctx: Context) => Promise<unknown>`. */
function inContractWords(message: string): string {
  return message.replaceAll(TOOL_TYPE, "(input: Input, ctx: Context) => Promise<unknown>");
}

/**
 * Is the first parameter used other than to read a property off it? `input.x` and `input["x"]` are
 * field reads; anything else — passed along, spread, destructured — takes the whole object.
 */
function usesParameterWhole(fn: FunctionLike | null, sf: ts.SourceFile): boolean {
  const first = fn?.parameters[0]?.name;
  if (!fn || !first || !ts.isIdentifier(first)) return false;
  const name = first.text;
  let whole = false;
  const visit = (node: ts.Node): void => {
    if (whole) return;
    if (ts.isIdentifier(node) && node.text === name && node !== first) {
      const parent = node.parent;
      const fieldRead =
        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
        parent.expression === node;
      if (!fieldRead && !ts.isParameter(parent)) whole = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body ?? sf);
  return whole;
}

/* -------------------------------------- the module -------------------------------------- */

type MountedModule = {
  /** Absolute virtual path → content, for every file the compiler may read (code and JSON). */
  virtual: Map<string, string>;
  /** The code files, as root names of the program. */
  codeFiles: string[];
  /** The model's own parse of each code file — original text, original positions. */
  originals: Map<string, ts.SourceFile>;
  /** Files whose extension alone refuses them. */
  jsxFiles: string[];
  /** Every identifier and string literal in the module — the "is this field read" scan. */
  mentioned: Set<string>;
};

function mountModule(files: readonly ModuleCheckFile[]): MountedModule {
  const module: MountedModule = {
    virtual: new Map(),
    codeFiles: [],
    originals: new Map(),
    jsxFiles: [],
    mentioned: new Set(),
  };
  for (const file of files) {
    const rel = normaliseRelative(file.path);
    if (rel === "" || rel.startsWith("../")) continue;
    if (JSX_EXTENSIONS.some((ext) => rel.endsWith(ext))) {
      module.jsxFiles.push(rel);
      continue;
    }
    const abs = `${MODULE_ROOT}/${rel}`;
    if (rel.endsWith(".json")) {
      module.virtual.set(abs, file.content);
      continue;
    }
    if (!CODE_EXTENSIONS.some((ext) => rel.endsWith(ext))) continue;
    module.virtual.set(abs, file.content);
    module.codeFiles.push(abs);
    module.originals.set(abs, ts.createSourceFile(abs, file.content, ts.ScriptTarget.ES2022, true));
  }
  return module;
}

function normaliseRelative(path: string): string {
  const trimmed = path.trim().replace(/^(\.\/|\/)+/, "");
  return trimmed === "" ? "" : posix.normalize(trimmed);
}

/* ---------------------------------- the default export ---------------------------------- */

type FunctionLike = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;

type DefaultExport = {
  /** Where the export statement starts — where export-level diagnostics point. */
  pos: number;
  /** The function behind the export, when it is in this file: a literal, or a top-level declaration. */
  fn: FunctionLike | null;
  /** Set when the function is a literal the check can re-type in place. */
  castStart?: number;
  castEnd?: number;
};

/**
 * Find the entry's default export and, when it is a function literal — `export default async (…) =>`,
 * `export default async function (…)`, or `const run = async (…) => …; export default run` — where to
 * wrap it so the parameters are contextually typed. An identifier the file does not declare, or a
 * `export { x as default }`, is left to the wrapper's assignment: still checked, at the export line.
 */
function analyseDefaultExport(sf: ts.SourceFile): DefaultExport | null {
  for (const statement of sf.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const pos = statement.getStart(sf);
      const expression = unwrapParentheses(statement.expression);
      if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
        return {
          pos,
          fn: expression,
          castStart: expression.getStart(sf),
          castEnd: expression.getEnd(),
        };
      }
      if (ts.isIdentifier(expression)) return { pos, ...resolveTopLevel(sf, expression.text) };
      return { pos, fn: null };
    }
    if (
      ts.isFunctionDeclaration(statement) &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
      hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
    ) {
      const pos = statement.getStart(sf);
      const asyncKeyword = ts
        .getModifiers(statement)
        ?.find((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
      const functionKeyword = statement
        .getChildren(sf)
        .find((child) => child.kind === ts.SyntaxKind.FunctionKeyword);
      const castStart = (asyncKeyword ?? functionKeyword)?.getStart(sf);
      return castStart === undefined
        ? { pos, fn: statement }
        : { pos, fn: statement, castStart, castEnd: statement.getEnd() };
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      const asDefault = statement.exportClause.elements.find((e) => e.name.text === "default");
      if (asDefault) {
        const local = (asDefault.propertyName ?? asDefault.name).text;
        return { pos: statement.getStart(sf), ...resolveTopLevel(sf, local) };
      }
    }
  }
  return null;
}

/** A top-level `const name = <function literal>` (re-typable) or `function name(…)` (checked as is). */
function resolveTopLevel(
  sf: ts.SourceFile,
  name: string,
): { fn: FunctionLike | null; castStart?: number; castEnd?: number } {
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
      return { fn: statement };
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
      if (!declaration.initializer) return { fn: null };
      const initializer = unwrapParentheses(declaration.initializer);
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
        return declaration.type
          ? { fn: initializer }
          : { fn: initializer, castStart: initializer.getStart(sf), castEnd: initializer.getEnd() };
      }
      return { fn: null };
    }
  }
  return { fn: null };
}

type Insertion = { at: number; length: number };

/**
 * Wrap the literal so TypeScript types its parameters from `__GraftTool`: `(…) satisfies __GraftTool`
 * in TypeScript, a JSDoc cast `/** @type {__GraftTool} *\/ (…)` in JavaScript. Two insertions on two
 * lines; nothing else moves, and `originalPosition` maps a diagnostic back to the model's text.
 */
function castDefaultExport(
  text: string,
  start: number,
  end: number,
  typescript: boolean,
): { text: string; insertions: Insertion[] } {
  const prefix = typescript ? "(" : `/** @type {${TOOL_TYPE}} */ (`;
  const suffix = typescript ? `) satisfies ${TOOL_TYPE}` : ")";
  return {
    text: `${text.slice(0, start)}${prefix}${text.slice(start, end)}${suffix}${text.slice(end)}`,
    insertions: [
      { at: start, length: prefix.length },
      { at: end, length: suffix.length },
    ],
  };
}

/** A position in the rewritten entry, back in the original: inside an insertion maps to its point. */
function originalPosition(pos: number, insertions: readonly Insertion[]): number {
  let shift = 0;
  for (const insertion of insertions) {
    const insertedAt = insertion.at + shift;
    if (pos < insertedAt) break;
    if (pos < insertedAt + insertion.length) return insertion.at;
    shift += insertion.length;
  }
  return pos - shift;
}

function wrapperSource(entryRel: string): string {
  return [
    `import tool from "../module/${entryRel}";`,
    `const check: ${TOOL_TYPE} = tool;`,
    "void check;",
    "export {};",
  ].join("\n");
}

/* ------------------------------------- text rules ------------------------------------- */

/**
 * The rules that read the model's text directly, one walk per file: the exec's environment, banned,
 * out-of-module and unvendored imports, an absolute URL handed to `fetch`, and the TypeScript that Node
 * cannot strip. The walk also collects every identifier and string literal, for the unread-field
 * advice.
 */
function scanText(
  sf: ts.SourceFile,
  abs: string,
  bag: DiagnosticBag,
  module: MountedModule,
  dependencies: ReadonlySet<string>,
): void {
  const rel = abs.slice(MODULE_ROOT.length + 1);
  const isTs = TS_EXTENSIONS.some((ext) => rel.endsWith(ext)) && !rel.endsWith(".d.ts");
  // One diagnostic per line, naming every variable that line reaches for.
  const environment = new Map<number, { pos: number; names: Set<string> }>();

  const visit = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) ||
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddleOrTemplateTail(node)
    ) {
      module.mentioned.add(node.text);
      const names = node.text.match(/GRAFT_[A-Z0-9_]*/g);
      if (names) {
        const pos = node.getStart(sf);
        const line = sf.getLineAndCharacterOfPosition(pos).line;
        const hit = environment.get(line) ?? { pos, names: new Set<string>() };
        for (const name of names) hit.names.add(name);
        environment.set(line, hit);
      }
    }

    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        checkSpecifier(
          node.moduleSpecifier.text,
          node.moduleSpecifier,
          abs,
          bag,
          module,
          dependencies,
        );
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (
        ts.isExternalModuleReference(node.moduleReference) &&
        ts.isStringLiteral(node.moduleReference.expression)
      ) {
        checkSpecifier(
          node.moduleReference.expression.text,
          node.moduleReference.expression,
          abs,
          bag,
          module,
          dependencies,
        );
      }
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      if (isRequire || isDynamicImport) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteralLike(argument)) {
          checkSpecifier(argument.text, argument, abs, bag, module, dependencies);
        } else {
          bag.at("import-outside-module", abs, node.getStart(sf), {
            message: `${rel} ${isRequire ? "requires" : "imports"} a module by a computed name, which the check cannot see.`,
            hint: "Import a file beside the entry by its literal relative path, or a Node built-in by name.",
          });
        }
      }
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "fetch") {
        const argument = node.arguments[0];
        const head = argument ? literalHead(argument) : null;
        if (
          head !== null &&
          (/^[a-z][a-z0-9+.-]*:/i.test(head) || head.startsWith("//") || /^http/i.test(head))
        ) {
          bag.at("fetch-absolute-url", abs, argument?.getStart(sf) ?? node.getStart(sf), {
            message: `ctx.fetch is given an absolute URL (${head.slice(0, 60)}); the proxy supplies the host from the connection, and the runner refuses any other.`,
            hint: 'Pass the vendor-relative path — "/v1/orders" — and nothing before it.',
          });
        }
      }
    }

    if (isTs) checkErasable(node, sf, abs, rel, bag);
    ts.forEachChild(node, visit);
  };
  visit(sf);

  for (const { pos, names } of environment.values()) {
    bag.at("execute-environment", abs, pos, {
      message: `${rel} reads ${[...names].join(" and ")}, the exec's environment. A published tool runs through the runner, which reads those itself and removes GRAFT_TOKEN before the module loads, so a module reading them sends no credential and its first run fails with token_invalid.`,
      hint: 'Reach the vendor through the second argument instead — export default async (input: Input, ctx: Context) => ctx.fetch("/<vendor path>", init), or an SDK bound with ctx.proxyKey and ctx.proxyBase() — and never name GRAFT_* in the module.',
    });
  }
}

/** The literal, or the fixed head of a template — `https://${host}/x` starts with `https://`. */
function literalHead(node: ts.Expression): string | null {
  const inner = unwrapParentheses(node);
  if (ts.isStringLiteralLike(inner)) return inner.text;
  if (ts.isTemplateExpression(inner)) return inner.head.text;
  return null;
}

/** Bare, not relative, not absolute, not a Node built-in: `@slack/web-api`, `stripe/esm`. */
function isPackageSpecifier(specifier: string): boolean {
  if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) {
    return false;
  }
  if (specifier.startsWith("node:")) return false;
  return !NODE_BUILTINS.has(specifier.split("/")[0] ?? specifier);
}

/** The package a specifier names: `@scope/name/sub` → `@scope/name`, `name/sub` → `name`. */
function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

function checkSpecifier(
  specifier: string,
  node: ts.Node,
  abs: string,
  bag: DiagnosticBag,
  module: MountedModule,
  dependencies: ReadonlySet<string>,
): void {
  const rel = abs.slice(MODULE_ROOT.length + 1);
  const sf = node.getSourceFile();
  const bare = specifier.replace(/^node:/, "");
  const root = bare.split("/")[0] ?? bare;

  if (BANNED.has(root)) {
    bag.at("banned-module", abs, node.getStart(sf), {
      message: `${rel} imports ${specifier}; a tool makes one HTTP call through the proxy and does not start processes or open sockets.`,
      hint: `Remove the import; whatever ${root} was for is outside what a published tool may do.`,
    });
    return;
  }
  if (specifier.startsWith("node:") || NODE_BUILTINS.has(root)) return;

  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const target = posix.normalize(posix.join(posix.dirname(abs), specifier));
    // Inside the module, present or not is TypeScript's to say (`import-unresolved`).
    if (target.startsWith(`${MODULE_ROOT}/`)) return;
    bag.at("import-outside-module", abs, node.getStart(sf), {
      message: `${rel} imports ${specifier}, outside the module's directory; a published version is copied whole, and anything outside it is not.`,
      hint: "Move the file into the module's directory and import it by relative path.",
    });
    module.mentioned.add(`\0outside:${specifier}`);
    return;
  }
  if (specifier.startsWith("/")) {
    bag.at("import-outside-module", abs, node.getStart(sf), {
      message: `${rel} imports ${specifier} by absolute path; a published version is copied whole, and a path outside it is not there when the tool runs.`,
      hint: "Move the file into the module's directory and import it by relative path.",
    });
    module.mentioned.add(`\0outside:${specifier}`);
    return;
  }
  // A package: allowed only when the version vendors it (ADR 0013). The ambient declaration in
  // `vendoredDeclarations` is what lets the compiler resolve it; an undeclared one is refused here and
  // the compiler's own "cannot find module" is deduplicated away below.
  const pkg = packageNameOf(specifier);
  if (dependencies.has(pkg)) return;
  bag.at("import-not-vendored", abs, node.getStart(sf), {
    message: `${rel} imports the package ${specifier}, which the module's package.json does not declare; nothing installs in the sandbox, and a package reaches a published version only from dependencies, at publish, when it clears the package policy.`,
    hint: `Declare ${JSON.stringify(pkg)} under dependencies in the module's package.json with an exact version — or write the call with ctx.fetch and Node's built-ins (node:crypto, node:url).`,
  });
  module.mentioned.add(`\0outside:${specifier}`);
}

/** The TypeScript Node 24 cannot strip — `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` at load, in the sandbox. */
function checkErasable(
  node: ts.Node,
  sf: ts.SourceFile,
  abs: string,
  rel: string,
  bag: DiagnosticBag,
): void {
  const ambient = isAmbient(node);
  const refuse = (what: string, hint: string) =>
    bag.at("non-erasable-syntax", abs, node.getStart(sf), {
      message: `${rel} uses ${what}, which is not erasable syntax: Node strips types and refuses to load it (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).`,
      hint,
    });

  if (ts.isEnumDeclaration(node) && !ambient) {
    refuse(
      "an enum",
      'Use a union of literals — type Status = "open" | "closed" — or a plain const object.',
    );
  } else if (
    ts.isModuleDeclaration(node) &&
    !ambient &&
    (node.flags & ts.NodeFlags.GlobalAugmentation) === 0
  ) {
    refuse("a namespace", "Use top-level functions and types, or a plain object.");
  } else if (
    ts.isParameter(node) &&
    node.parent &&
    ts.isConstructorDeclaration(node.parent) &&
    hasParameterPropertyModifier(node)
  ) {
    refuse(
      "a parameter property",
      "Declare the field on the class and assign it in the constructor body.",
    );
  } else if (ts.isImportEqualsDeclaration(node)) {
    refuse("import x = …", 'Use import x from "…" (ES modules only).');
  } else if (ts.isExportAssignment(node) && node.isExportEquals) {
    refuse("export =", "Use export default.");
  } else if (ts.isDecorator(node)) {
    refuse("a decorator", "Remove the decorator and call the function directly.");
  } else if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
    refuse("JSX", "A tool has no UI; return data.");
  }
}

function hasParameterPropertyModifier(node: ts.ParameterDeclaration): boolean {
  const kinds: ts.SyntaxKind[] = [
    ts.SyntaxKind.PublicKeyword,
    ts.SyntaxKind.PrivateKeyword,
    ts.SyntaxKind.ProtectedKeyword,
    ts.SyntaxKind.ReadonlyKeyword,
    ts.SyntaxKind.OverrideKeyword,
  ];
  return ts.getModifiers(node)?.some((m) => kinds.includes(m.kind)) ?? false;
}

/** Under a `declare` — its own or an ancestor's — so Node strips it whole. `NodeFlags.Ambient` is internal. */
function isAmbient(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (hasModifier(current, ts.SyntaxKind.DeclareKeyword)) return true;
  }
  return false;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false)
    : false;
}

function unwrapParentheses(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

/* ------------------------------- SDK bindings and methods ------------------------------- */

/**
 * Which identifiers in a file reach a package: `WebClient` imported from `@slack/web-api`, the
 * `client` a `new WebClient(…)` was assigned to, a `client` imported from a sibling that exported one.
 * Local name → package. The two SDK rules read this map: `sdk-not-bound` inspects every construction
 * of a bound identifier, and the annotations count every call through one as a write (ADR 0008 — a
 * request the check cannot see the method of is treated as a write). Propagated to a fixpoint across
 * variable initialisers and relative imports; what it misses (a client returned from a local
 * function, a default export) errs towards fewer diagnostics and never towards `readOnly`.
 */
type SdkBindings = Map<string, string>;

type FileBindings = {
  locals: SdkBindings;
  /** Exported name → the local it exports, or the package it re-exports from directly. */
  exports: Map<string, { local: string } | { pkg: string }>;
  /** Relative imports awaiting the target file's exports. */
  pending: { local: string; target: string; imported: string }[];
};

function analyseSdkBindings(module: MountedModule): Map<string, SdkBindings> {
  const files = new Map<string, FileBindings>();
  for (const [abs, sf] of module.originals) {
    files.set(abs, collectImports(sf, abs));
  }

  for (let round = 0; round < 10; round++) {
    let changed = false;
    for (const [abs, file] of files) {
      for (const { local, target, imported } of file.pending) {
        if (file.locals.has(local)) continue;
        const exported = files.get(target)?.exports.get(imported);
        const pkg =
          exported === undefined
            ? undefined
            : "pkg" in exported
              ? exported.pkg
              : files.get(target)?.locals.get(exported.local);
        if (pkg) {
          file.locals.set(local, pkg);
          changed = true;
        }
      }
      const sf = module.originals.get(abs);
      if (!sf) continue;
      const visit = (node: ts.Node): void => {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer &&
          !file.locals.has(node.name.text)
        ) {
          const pkg = rootPackageOf(node.initializer, file.locals);
          if (pkg) {
            file.locals.set(node.name.text, pkg);
            changed = true;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    if (!changed) break;
  }

  return new Map([...files].map(([abs, file]) => [abs, file.locals]));
}

/** The import and export statements of one file, before any propagation. */
function collectImports(sf: ts.SourceFile, abs: string): FileBindings {
  const file: FileBindings = { locals: new Map(), exports: new Map(), pending: [] };
  const targetOf = (specifier: string) =>
    posix.normalize(posix.join(posix.dirname(abs), specifier));

  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (!clause || clause.isTypeOnly) continue;
      const isPackage = isPackageSpecifier(specifier);
      const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
      if (!isPackage && !isRelative) continue;
      const pkg = packageNameOf(specifier);
      const bind = (local: string, imported: string) => {
        if (isPackage) file.locals.set(local, pkg);
        else file.pending.push({ local, target: targetOf(specifier), imported });
      };
      if (clause.name) bind(clause.name.text, "default");
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) bind(bindings.name.text, "*");
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (element.isTypeOnly) continue;
          bind(element.name.text, (element.propertyName ?? element.name).text);
        }
      }
      continue;
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause) {
      if (!ts.isNamedExports(statement.exportClause)) continue;
      const specifier =
        statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : null;
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly) continue;
        const exported = element.name.text;
        const local = (element.propertyName ?? element.name).text;
        if (specifier === null) file.exports.set(exported, { local });
        else if (isPackageSpecifier(specifier)) {
          file.exports.set(exported, { pkg: packageNameOf(specifier) });
        }
      }
      continue;
    }
    if (ts.isVariableStatement(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          file.exports.set(declaration.name.text, { local: declaration.name.text });
        }
      }
    }
  }
  return file;
}

/**
 * The package an expression is rooted in, if any: the identifier at the bottom of a chain of property
 * accesses, calls, `new`, `await` and casts — or the package a literal `require`/`import()` names.
 */
function rootPackageOf(expression: ts.Expression, locals: SdkBindings): string | undefined {
  let current: ts.Expression = expression;
  for (let depth = 0; depth < 64; depth++) {
    current = unwrapParentheses(current);
    if (ts.isIdentifier(current)) return locals.get(current.text);
    if (
      ts.isAwaitExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    if (ts.isCallExpression(current)) {
      const callee = current.expression;
      const argument = current.arguments[0];
      const loads =
        (ts.isIdentifier(callee) && callee.text === "require") ||
        callee.kind === ts.SyntaxKind.ImportKeyword;
      if (loads && argument && ts.isStringLiteralLike(argument)) {
        return isPackageSpecifier(argument.text) ? packageNameOf(argument.text) : undefined;
      }
      current = callee;
      continue;
    }
    if (ts.isNewExpression(current)) {
      current = current.expression;
      continue;
    }
    return undefined;
  }
  return undefined;
}

/** What the annotations are decided on; a read leaves no mark, so only the two that do are counted. */
type MethodTally = { writes: number; deletes: number };

/**
 * One walk per file for the two SDK-aware rules. Every `new X(…)` of a bound identifier — and every
 * call of one that carries an options object with a credential or base slot, the factory form — is
 * held to the binding (`checkSdkConstruction`). Every call rooted in a binding is tallied as a write;
 * every other `.fetch(…)` is tallied by its `method`.
 */
function scanSdk(
  sf: ts.SourceFile,
  abs: string,
  bag: DiagnosticBag,
  locals: SdkBindings,
  tally: MethodTally,
): void {
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      const pkg = rootPackageOf(node.expression, locals);
      if (pkg) checkSdkConstruction(node, pkg, sf, abs, bag);
    } else if (ts.isCallExpression(node)) {
      const pkg = rootPackageOf(node.expression, locals);
      if (pkg) {
        tally.writes += 1;
        if (hasBindingSlot(node)) checkSdkConstruction(node, pkg, sf, abs, bag);
      } else if (
        (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "fetch") ||
        (ts.isIdentifier(node.expression) && node.expression.text === "fetch")
      ) {
        const method = fetchMethod(node.arguments[1]);
        if (method === "DELETE") tally.deletes += 1;
        else if (method === null || !READ_METHODS.has(method)) tally.writes += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/** Does a call carry an options object with a credential or base option — the shape of a client factory? */
function hasBindingSlot(node: ts.CallExpression): boolean {
  return node.arguments.some((argument) => {
    const inner = unwrapParentheses(argument);
    return (
      ts.isObjectLiteralExpression(inner) &&
      inner.properties.some((property) => {
        const name = propertyNameOf(property);
        return name !== null && (CREDENTIAL_OPTIONS.has(name) || BASE_OPTIONS.has(name));
      })
    );
  });
}

/**
 * The method a `fetch(path, init)` call would send, upper-cased: `GET` when there is no `init` or no
 * `method` in a literal `init`; the literal when there is one; null when the check cannot read it — a
 * variable for `init`, a spread inside it, a computed `method` — which the caller counts as a write.
 */
function fetchMethod(init: ts.Expression | undefined): string | null {
  if (init === undefined) return "GET";
  const literal = unwrapParentheses(init);
  if (!ts.isObjectLiteralExpression(literal)) return null;
  let method: string | null = "GET";
  for (const property of literal.properties) {
    if (ts.isSpreadAssignment(property)) return null;
    if (propertyNameOf(property) !== "method") continue;
    if (!ts.isPropertyAssignment(property)) return null;
    const value = unwrapParentheses(property.initializer);
    method = ts.isStringLiteralLike(value) ? value.text.toUpperCase() : null;
  }
  return method;
}

/** The annotations, from the tally — ADR 0008's rule, and the type's doc comment. */
function deriveAnnotations(tally: MethodTally): ToolAnnotations {
  return {
    readOnly: tally.writes === 0 && tally.deletes === 0,
    destructive: tally.deletes > 0,
  };
}

/**
 * ADR 0010's binding rule, mechanical and literal: a client constructed from a package takes
 * `ctx.proxyKey` in its credential slot and a `ctx.proxyBase(…)` call in its base slot — the positional
 * first argument (Slack's `new WebClient(token, options)`) or a property of the options object under
 * one of the known names — and nothing the check cannot classify anywhere in either. A construction
 * with no credential slot, or no base slot, is refused too: the check cannot tell a credential-less
 * client from one that reads its key off the environment, and a client with no base leaves for the
 * vendor's own host, which the sandbox cannot reach. `@slack/web-api` must also say
 * `allowAbsoluteUrls: false`. The false positives — a utility class from a vendored package, a base
 * computed at run time — are the ones ADR 0010 accepts.
 */
function checkSdkConstruction(
  node: ts.NewExpression | ts.CallExpression,
  pkg: string,
  sf: ts.SourceFile,
  abs: string,
  bag: DiagnosticBag,
): void {
  const rel = abs.slice(MODULE_ROOT.length + 1);
  const client = node.expression.getText(sf);
  const args: readonly ts.Expression[] = node.arguments ?? [];
  const options = args.map(unwrapParentheses).find(ts.isObjectLiteralExpression) ?? null;
  const example = `new ${client}({ apiKey: ctx.proxyKey, baseUrl: ctx.proxyBase() })`;
  const refuse = (at: ts.Node, message: string, hint: string) =>
    bag.at("sdk-not-bound", abs, at.getStart(sf), { message, hint });

  let credential = false;
  let base = false;
  let slackAbsoluteUrls: boolean | null = null;

  const first = args[0] ? unwrapParentheses(args[0]) : undefined;
  if (first && first !== options) {
    credential = true;
    if (!isProxyKey(first)) {
      refuse(
        first,
        `${rel} constructs ${client} with a credential of its own (${describeValue(first, sf)}); a module holds no credential, and the proxy injects the connection's on the way out (ADR 0010).`,
        `Pass ctx.proxyKey in that position — new ${client}(ctx.proxyKey, { …: ctx.proxyBase() }) — and let the proxy replace it.`,
      );
    }
  }

  for (const property of options?.properties ?? []) {
    if (ts.isSpreadAssignment(property)) {
      refuse(
        property,
        `${rel} constructs ${client} from a spread (${property.getText(sf).slice(0, 60)}), which the check cannot read; an SDK is bound to the proxy or not at all (ADR 0010).`,
        `Write the options out literally: ${example}.`,
      );
      return;
    }
    const name = propertyNameOf(property);
    if (name === null) {
      refuse(
        property,
        `${rel} constructs ${client} with an option the check cannot name (${property.getText(sf).slice(0, 60)}).`,
        `Write each option as a plain key: ${example}.`,
      );
      continue;
    }
    const value = ts.isPropertyAssignment(property)
      ? unwrapParentheses(property.initializer)
      : null;

    if (CREDENTIAL_OPTIONS.has(name)) {
      credential = true;
      if (value === null || !isProxyKey(value)) {
        refuse(
          property,
          `${rel} constructs ${client} with a credential of its own (${name}: ${value ? describeValue(value, sf) : `the variable ${name}`}); a module holds no credential, and the proxy injects the connection's on the way out (ADR 0010).`,
          `Write ${name}: ctx.proxyKey — the proxy reads it from the request and swaps in the real credential.`,
        );
      }
    } else if (BASE_OPTIONS.has(name)) {
      base = true;
      if (value === null || !isProxyBaseCall(value)) {
        refuse(
          property,
          `${rel} points ${client} at a base of its own (${name}: ${value ? describeValue(value, sf) : `the variable ${name}`}); an SDK reaches a vendor through the proxy or not at all (ADR 0010).`,
          `Write ${name}: ctx.proxyBase() — or ctx.proxyBase("api.vendor.com") for another host the connection declares — and nothing computed.`,
        );
      }
    } else if (SDK_HEADER_OPTIONS.has(name) && value !== null) {
      if (!ts.isObjectLiteralExpression(value)) {
        refuse(
          property,
          `${rel} hands ${client} ${name} the check cannot read (${describeValue(value, sf)}); a header carrying a credential would bypass the proxy's injection.`,
          "Write the headers out literally, and set no authentication header: the proxy sets it.",
        );
        continue;
      }
      for (const header of value.properties) {
        const headerName = propertyNameOf(header);
        if (headerName !== null && AUTH_HEADERS.test(headerName)) {
          refuse(
            header,
            `${rel} sets the ${headerName} header on ${client}; the proxy sets the credential header from the connection, and a module never carries one of its own (ADR 0010).`,
            "Drop the header; pass ctx.proxyKey as the credential option instead.",
          );
        }
      }
    } else if (pkg === SLACK_PACKAGE && name === SLACK_ABSOLUTE_URLS_OPTION) {
      slackAbsoluteUrls = value !== null && value.kind === ts.SyntaxKind.FalseKeyword;
    }
  }

  if (!credential) {
    refuse(
      node,
      `${rel} constructs ${client} without ctx.proxyKey as its credential; the check cannot see how it authenticates, and a client that reads its key off the environment finds none there.`,
      `Construct it with ctx.proxyKey in the SDK's credential option — ${example} (the option names vary by SDK) — or write the call with ctx.fetch instead.`,
    );
  }
  if (!base) {
    refuse(
      node,
      `${rel} constructs ${client} without a base URL pointing at the proxy; its calls would leave for the vendor's own host, which the sandbox cannot reach, and the credential would not be injected (ADR 0010).`,
      `Set the SDK's base URL option — baseUrl, apiUrl, rootUrl, endpointUrl, slackApiUrl — to ctx.proxyBase(), or ctx.proxyBase("host") for a host the connection declares.`,
    );
  }
  if (pkg === SLACK_PACKAGE && slackAbsoluteUrls !== true) {
    refuse(
      node,
      `${rel} constructs ${client} without allowAbsoluteUrls: false; @slack/web-api treats a method name that is an absolute URL as the URL to call, which would carry the token off the proxy.`,
      `Write new ${client}(ctx.proxyKey, { slackApiUrl: ctx.proxyBase(), allowAbsoluteUrls: false }).`,
    );
  }
}

/** `<identifier>.proxyKey`, or `<identifier>["proxyKey"]`: the runner's token, by the contract's name. */
function isProxyKey(expression: ts.Expression): boolean {
  const inner = unwrapParentheses(expression);
  if (ts.isPropertyAccessExpression(inner)) {
    return inner.name.text === "proxyKey" && ts.isIdentifier(inner.expression);
  }
  if (ts.isElementAccessExpression(inner)) {
    const key = unwrapParentheses(inner.argumentExpression);
    return (
      ts.isStringLiteralLike(key) && key.text === "proxyKey" && ts.isIdentifier(inner.expression)
    );
  }
  return false;
}

/** A call of `<identifier>.proxyBase(…)`, whatever its argument: the runner decides what a host may be. */
function isProxyBaseCall(expression: ts.Expression): boolean {
  const inner = unwrapParentheses(expression);
  if (!ts.isCallExpression(inner)) return false;
  const callee = inner.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "proxyBase" &&
    ts.isIdentifier(callee.expression)
  );
}

/** The name of an object-literal property when it is a plain identifier or string; null when computed. */
function propertyNameOf(property: ts.ObjectLiteralElementLike): string | null {
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

/** A value, named for the diagnostic: what kind of thing sat in the slot. */
function describeValue(expression: ts.Expression, sf: ts.SourceFile): string {
  const inner = unwrapParentheses(expression);
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) {
    return `a string literal, ${JSON.stringify(inner.text.slice(0, 40))}`;
  }
  if (ts.isTemplateExpression(inner)) return "a template literal";
  if (ts.isIdentifier(inner)) return `the variable ${inner.text}`;
  return `the expression ${inner.getText(sf).slice(0, 60)}`;
}

/* --------------------------------- compiler diagnostics --------------------------------- */

const GENERIC_TYPE_HINT = "Read the message: TypeScript names the value and the type it expected.";

type Classified =
  | { rule: RefusalRule; message: string; hint: string; advice: false }
  | { rule: AdviceRule; message: string; hint: string; advice: true };

function classify(
  diagnostic: ts.Diagnostic,
  message: string,
  syntactic: boolean,
  context: {
    fileName: string;
    pos: number;
    module: MountedModule;
    exported: DefaultExport | null;
    declaredFields: string[];
    hasSchema: boolean;
  },
): Classified | null {
  const { code } = diagnostic;
  if (syntactic) {
    return {
      rule: "syntax",
      message,
      hint: "Fix the syntax first; nothing else is checked until the file parses.",
      advice: false,
    };
  }
  if (IMPLICIT_ANY_CODES.has(code)) {
    const onEntryParameter = isParameterOf(
      context.exported?.fn ?? null,
      context.pos,
      context.module.originals.get(context.fileName),
    );
    return {
      rule: "implicit-any",
      message,
      hint: onEntryParameter
        ? "Annotate the default export as (input: Input, ctx: Context) — both types are declared for you during the check."
        : "Give it a type, or initialise it so one can be inferred.",
      advice: true,
    };
  }
  if (code === 2307) {
    if (context.module.mentioned.has(`\0outside:${moduleNameIn(message)}`)) return null;
    return {
      rule: "import-unresolved",
      message,
      hint: "The file is not in the module. Write it beside the entry, or fix the path — Node needs the exact file name, extension included.",
      advice: false,
    };
  }
  if (code === 2304 && /'fetch'/.test(message)) {
    return {
      rule: "global-fetch",
      message:
        "fetch is called bare; a module has no route to a vendor but ctx, and the sandbox reaches nothing else.",
      hint: 'Call ctx.fetch("/<vendor path>", init) — the proxy adds the host and the credential.',
      advice: false,
    };
  }
  if (code === 1484 || code === 1205 || code === 1444 || code === 1446) {
    return {
      rule: "type-import",
      message,
      hint: "Write import type { X } from './x.ts' — Node strips types but not imports, so a type imported as a value fails to load.",
      advice: false,
    };
  }
  if ((code === 2339 || code === 2551) && /on type 'Input'/.test(message)) {
    return {
      rule: "type-error",
      message,
      hint: context.hasSchema
        ? `Input has only the fields the schema declares — ${context.declaredFields.join(", ") || "none"}. Fix the field name, or add it to the schema.`
        : "Pass the schema you will publish so Input carries its fields.",
      advice: false,
    };
  }
  if ((code === 2339 || code === 2551) && /on type 'Context'/.test(message)) {
    return {
      rule: "type-error",
      message,
      hint: `ctx carries fetch, proxyBase, proxyKey and connection, and nothing else: Context is ${CONTEXT_DECLARATION}.`,
      advice: false,
    };
  }
  return { rule: "type-error", message, hint: GENERIC_TYPE_HINT, advice: false };
}

/** The `'./x'` out of "Cannot find module './x' …", for the dedupe against the import rules. */
function moduleNameIn(message: string): string {
  return /Cannot find module '([^']+)'/.exec(message)?.[1] ?? "";
}

function isParameterOf(
  fn: FunctionLike | null,
  pos: number,
  sf: ts.SourceFile | undefined,
): boolean {
  if (!fn || !sf) return false;
  return fn.parameters.some((p) => pos >= p.getStart(sf) && pos < p.getEnd());
}

/* -------------------------------------- the return -------------------------------------- */

/**
 * Best-effort: the awaited return type of the default export, walked three levels for anything JSON
 * loses — a function, a symbol, a bigint, a Map or Set (`{}` after stringify), a Promise left
 * unawaited — and `void`, which the runner writes as `null` where the agent expected the vendor's
 * answer. Advice, because the walk is shallow and `any` says nothing.
 */
function describeReturn(
  program: ts.Program,
  checker: ts.TypeChecker,
  bag: DiagnosticBag,
  entryAbs: string,
  exportPos: number,
): void {
  const wrapper = program.getSourceFile(WRAPPER_FILE);
  const statement = wrapper?.statements.find(ts.isVariableStatement);
  const initializer = statement?.declarationList.declarations[0]?.initializer;
  if (!initializer) return;
  const signature = checker.getTypeAtLocation(initializer).getCallSignatures()[0];
  if (!signature) return;
  const returned = signature.getReturnType();
  const awaited = checker.getAwaitedType(returned) ?? returned;

  if (awaited.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) {
    bag.advise("no-return", entryAbs, exportPos, {
      message: "The default export returns nothing, so the tool's result is null.",
      hint: "Return the fields the agent needs from the vendor's answer — the id it created, the status it gave.",
    });
    return;
  }
  const offence = nonJson(checker, awaited, "result", 0, new Set());
  if (offence) {
    bag.advise("non-json-return", entryAbs, exportPos, {
      message: `The tool's result will not survive JSON: ${offence}. The runner JSON-stringifies what the module returns.`,
      hint: "Return plain data — objects, arrays, strings, numbers, booleans, null.",
    });
  }
}

function nonJson(
  checker: ts.TypeChecker,
  type: ts.Type,
  path: string,
  depth: number,
  seen: Set<ts.Type>,
): string | null {
  if (depth > 3 || seen.has(type)) return null;
  seen.add(type);
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return null;
  if (type.isUnion()) {
    for (const member of type.types) {
      const found = nonJson(checker, member, path, depth, seen);
      if (found) return found;
    }
    return null;
  }
  if (type.flags & (ts.TypeFlags.BigInt | ts.TypeFlags.BigIntLiteral)) return `${path} is a bigint`;
  if (type.flags & (ts.TypeFlags.ESSymbol | ts.TypeFlags.UniqueESSymbol)) {
    return `${path} is a symbol`;
  }
  if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
    return `${path} is a function`;
  }
  if ((type.flags & ts.TypeFlags.Object) === 0) return null;

  const name = type.getSymbol()?.getName();
  if (name === "Map" || name === "Set" || name === "WeakMap" || name === "WeakSet") {
    return `${path} is a ${name}, which JSON turns into {}`;
  }
  if (name === "Promise") return `${path} is a Promise that was not awaited`;
  if (name === "Date" || name === "RegExp" || name === "URL") return null;
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    for (const element of checker.getTypeArguments(type as ts.TypeReference)) {
      const found = nonJson(checker, element, `${path}[]`, depth + 1, seen);
      if (found) return found;
    }
    return null;
  }
  for (const property of type.getProperties().slice(0, 50)) {
    const found = nonJson(
      checker,
      checker.getTypeOfSymbol(property),
      `${path}.${property.getName()}`,
      depth + 1,
      seen,
    );
    if (found) return found;
  }
  return null;
}

/* ------------------------------------- the host ------------------------------------- */

/**
 * TypeScript's own host for the lib files (read from `typescript6`'s package on disk), the virtual
 * map for everything else. Relative specifiers resolve to the exact virtual path and nothing more —
 * no extension guessing — because Node resolves them the same way in the sandbox: `./helper` without
 * its extension fails there, so it fails here. A package specifier resolves to nothing here and falls
 * through to the ambient `declare module` in `vendoredDeclarations`, or to `import-not-vendored`.
 */
function createHost(virtual: Map<string, string>): ts.CompilerHost {
  const base = ts.createCompilerHost(OPTIONS, true);
  const directories = new Set<string>([MODULE_ROOT, GRAFT_ROOT]);
  for (const path of virtual.keys()) {
    let dir = posix.dirname(path);
    while (dir !== "/" && !directories.has(dir)) {
      directories.add(dir);
      dir = posix.dirname(dir);
    }
  }
  return {
    ...base,
    getCurrentDirectory: () => GRAFT_ROOT,
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: (fileName) => fileName,
    fileExists: (fileName) => virtual.has(fileName) || base.fileExists(fileName),
    readFile: (fileName) => virtual.get(fileName) ?? base.readFile(fileName),
    directoryExists: (directory) =>
      directories.has(directory) || (base.directoryExists?.(directory) ?? false),
    getSourceFile: (fileName, languageVersion) => {
      const text = virtual.get(fileName);
      if (text === undefined) return base.getSourceFile(fileName, languageVersion);
      return ts.createSourceFile(fileName, text, languageVersion, true);
    },
    writeFile: () => {},
    resolveModuleNameLiterals: (literals, containingFile) =>
      literals.map((literal) => ({
        resolvedModule: resolveVirtual(literal.text, containingFile, virtual),
      })),
  };
}

const EXTENSIONS: readonly [string, ts.Extension][] = [
  [".d.ts", ts.Extension.Dts],
  [".ts", ts.Extension.Ts],
  [".mts", ts.Extension.Mts],
  [".mjs", ts.Extension.Mjs],
  [".cjs", ts.Extension.Cjs],
  [".js", ts.Extension.Js],
  [".json", ts.Extension.Json],
];

function resolveVirtual(
  specifier: string,
  containingFile: string,
  virtual: Map<string, string>,
): ts.ResolvedModuleFull | undefined {
  if (!specifier.startsWith("./") && !specifier.startsWith("../") && !specifier.startsWith("/")) {
    return undefined;
  }
  const resolved = specifier.startsWith("/")
    ? posix.normalize(specifier)
    : posix.normalize(posix.join(posix.dirname(containingFile), specifier));
  if (!virtual.has(resolved)) return undefined;
  const extension = EXTENSIONS.find(([suffix]) => resolved.endsWith(suffix))?.[1];
  if (!extension) return undefined;
  return {
    resolvedFileName: resolved,
    extension,
    isExternalLibraryImport: false,
    resolvedUsingTsExtension: extension === ts.Extension.Ts || extension === ts.Extension.Mts,
  };
}

/* ----------------------------------- the contract ----------------------------------- */

function contractDeclaration(schema: Record<string, unknown> | null): string {
  return [
    `declare type Input = ${schema ? inputTypeFromSchema(schema) : "any"};`,
    `declare type Context = ${CONTEXT_DECLARATION};`,
    `declare type ${TOOL_TYPE} = (input: Input, ctx: Context) => Promise<unknown>;`,
  ].join("\n");
}

/**
 * A shorthand ambient module for each vendored package and its subpaths, so an import the version
 * carries type-checks as `any` (ADR 0013). The check has no `node_modules` to read the package's own
 * types from, and does not want one: what it holds the SDK to is its construction (`sdk-not-bound`),
 * not its API.
 */
function vendoredDeclarations(dependencies: ReadonlySet<string>): string {
  return `${[...dependencies]
    .sort()
    .flatMap((name) => [
      `declare module ${JSON.stringify(name)};`,
      `declare module ${JSON.stringify(`${name}/*`)};`,
    ])
    .join("\n")}\n`;
}

/**
 * The `Input` type from the tool's JSON Schema — the subset a tool's input uses, and `unknown` for
 * anything else, so the check never refuses a module over a schema feature it does not model.
 *
 * Declared properties only, whatever `additionalProperties` says: an undeclared field may pass the
 * validator, but a module reading one is reading something the schema never promised, and that is
 * the defect this type exists to catch. A schema object under `additionalProperties` is honoured
 * when there are no declared properties (`Record<string, T>`); beside declared ones it is dropped,
 * because the intersection TypeScript would need makes every declared field `never`.
 */
export function inputTypeFromSchema(schema: unknown, depth = 0): string {
  const node = objectOrNull(schema);
  if (!node || depth > 8) return "unknown";

  if ("const" in node) return literal(node.const);
  if (Array.isArray(node.enum)) {
    const members = node.enum.map(literal);
    return members.length === 0 ? "never" : unique(members).join(" | ");
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = node[key];
    if (Array.isArray(branches) && branches.length > 0) {
      return unique(
        branches.map((branch) => parenthesise(inputTypeFromSchema(branch, depth + 1))),
      ).join(" | ");
    }
  }
  if (Array.isArray(node.allOf) && node.allOf.length > 0) {
    return unique(
      node.allOf.map((branch) => parenthesise(inputTypeFromSchema(branch, depth + 1))),
    ).join(" & ");
  }

  const declared = Array.isArray(node.type)
    ? node.type.filter((t): t is string => typeof t === "string")
    : typeof node.type === "string"
      ? [node.type]
      : [];
  const types =
    declared.length > 0
      ? declared
      : "properties" in node
        ? ["object"]
        : "items" in node
          ? ["array"]
          : [];
  if (types.length === 0) return "unknown";

  const mapped = types.map((type) => {
    switch (type) {
      case "string":
        return "string";
      case "number":
      case "integer":
        return "number";
      case "boolean":
        return "boolean";
      case "null":
        return "null";
      case "array":
        return arrayType(node, depth);
      case "object":
        return objectType(node, depth);
      default:
        return "unknown";
    }
  });
  if (node.nullable === true) mapped.push("null");
  return unique(mapped).join(" | ");
}

function arrayType(node: Record<string, unknown>, depth: number): string {
  if (Array.isArray(node.items)) {
    return `[${node.items.map((item) => inputTypeFromSchema(item, depth + 1)).join(", ")}]`;
  }
  return `${parenthesise(inputTypeFromSchema(node.items, depth + 1))}[]`;
}

function objectType(node: Record<string, unknown>, depth: number): string {
  const properties = propertiesOf(node);
  const required = new Set(
    Array.isArray(node.required) ? node.required.filter((r) => typeof r === "string") : [],
  );
  const names = Object.keys(properties);
  if (names.length === 0) {
    const additional = objectOrNull(node.additionalProperties);
    return additional
      ? `Record<string, ${inputTypeFromSchema(additional, depth + 1)}>`
      : "Record<string, unknown>";
  }
  const members = names.map(
    (name) =>
      `${isIdentifier(name) ? name : JSON.stringify(name)}${required.has(name) ? "" : "?"}: ${inputTypeFromSchema(properties[name], depth + 1)}`,
  );
  return `{ ${members.join("; ")} }`;
}

function literal(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  return "unknown";
}

function parenthesise(type: string): string {
  return /[|&]/.test(type) && !type.startsWith("{") && !type.startsWith("[") ? `(${type})` : type;
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function isIdentifier(name: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(name);
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function propertiesOf(schema: Record<string, unknown>): Record<string, unknown> {
  return objectOrNull(schema.properties) ?? {};
}

/* ----------------------------------- the runtime ----------------------------------- */

/**
 * What a module may rely on at run time, declared for the check: the `fetch` types without the DOM
 * (the sandbox is Node, not a browser), and the Node globals a vendor call plausibly reaches for.
 * Deliberately absent: a global `fetch` — its use is the `global-fetch` refusal — and `process.exit`
 * and `process.stdout`, either of which would break the runner's stdout contract. Every Node built-in
 * module is declared shorthand (`any`), so `node:crypto` imports type-check without `@types/node`;
 * the banned ones are refused by name before the compiler sees them.
 */
export const RUNTIME_DECLARATIONS = `${[
  "type HeadersInit = Headers | Record<string, string> | readonly (readonly [string, string])[];",
  "interface Headers { append(name: string, value: string): void; delete(name: string): void; get(name: string): string | null; has(name: string): boolean; set(name: string, value: string): void; forEach(callback: (value: string, key: string) => void): void; entries(): IterableIterator<[string, string]>; keys(): IterableIterator<string>; values(): IterableIterator<string>; [Symbol.iterator](): IterableIterator<[string, string]>; }",
  "declare var Headers: { prototype: Headers; new (init?: HeadersInit): Headers };",
  "type BodyInit = string | ArrayBuffer | ArrayBufferView | URLSearchParams | FormData | Blob;",
  "interface Blob { readonly size: number; readonly type: string; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string>; slice(start?: number, end?: number, contentType?: string): Blob; }",
  "declare var Blob: { prototype: Blob; new (parts?: readonly (string | ArrayBuffer | ArrayBufferView | Blob)[], options?: { type?: string }): Blob };",
  "interface FormData { append(name: string, value: string | Blob, fileName?: string): void; delete(name: string): void; get(name: string): string | Blob | null; getAll(name: string): (string | Blob)[]; has(name: string): boolean; set(name: string, value: string | Blob, fileName?: string): void; }",
  "declare var FormData: { prototype: FormData; new (): FormData };",
  "interface AbortSignal { readonly aborted: boolean; readonly reason: unknown; throwIfAborted(): void; addEventListener(type: 'abort', listener: () => void): void; }",
  "declare var AbortSignal: { prototype: AbortSignal; timeout(milliseconds: number): AbortSignal; abort(reason?: unknown): AbortSignal; any(signals: readonly AbortSignal[]): AbortSignal };",
  "interface AbortController { readonly signal: AbortSignal; abort(reason?: unknown): void; }",
  "declare var AbortController: { prototype: AbortController; new (): AbortController };",
  "interface RequestInit { method?: string; headers?: HeadersInit; body?: BodyInit | null; signal?: AbortSignal | null; redirect?: 'follow' | 'error' | 'manual'; }",
  "interface Response { readonly ok: boolean; readonly status: number; readonly statusText: string; readonly headers: Headers; readonly url: string; readonly redirected: boolean; readonly bodyUsed: boolean; json(): Promise<any>; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer>; blob(): Promise<Blob>; formData(): Promise<FormData>; clone(): Response; }",
  "declare var Response: { prototype: Response; new (body?: BodyInit | null, init?: { status?: number; statusText?: string; headers?: HeadersInit }): Response; json(data: unknown, init?: { status?: number; headers?: HeadersInit }): Response };",
  "interface URLSearchParams { readonly size: number; append(name: string, value: string): void; delete(name: string, value?: string): void; get(name: string): string | null; getAll(name: string): string[]; has(name: string, value?: string): boolean; set(name: string, value: string): void; sort(): void; toString(): string; forEach(callback: (value: string, key: string) => void): void; entries(): IterableIterator<[string, string]>; keys(): IterableIterator<string>; values(): IterableIterator<string>; [Symbol.iterator](): IterableIterator<[string, string]>; }",
  "declare var URLSearchParams: { prototype: URLSearchParams; new (init?: string | Record<string, string> | readonly (readonly [string, string])[] | URLSearchParams): URLSearchParams };",
  "interface URL { hash: string; host: string; hostname: string; href: string; readonly origin: string; password: string; pathname: string; port: string; protocol: string; search: string; readonly searchParams: URLSearchParams; username: string; toString(): string; toJSON(): string; }",
  "declare var URL: { prototype: URL; new (url: string | URL, base?: string | URL): URL; canParse(url: string | URL, base?: string | URL): boolean };",
  "interface TextEncoder { readonly encoding: string; encode(input?: string): Uint8Array; }",
  "declare var TextEncoder: { prototype: TextEncoder; new (): TextEncoder };",
  "interface TextDecoder { readonly encoding: string; decode(input?: ArrayBuffer | ArrayBufferView, options?: { stream?: boolean }): string; }",
  "declare var TextDecoder: { prototype: TextDecoder; new (label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }): TextDecoder };",
  "interface Console { log(...data: unknown[]): void; error(...data: unknown[]): void; warn(...data: unknown[]): void; info(...data: unknown[]): void; debug(...data: unknown[]): void; }",
  "declare var console: Console;",
  "interface Timer { ref(): Timer; unref(): Timer; hasRef(): boolean; [Symbol.toPrimitive](): number; }",
  "declare function setTimeout(callback: (...args: any[]) => void, delay?: number, ...args: any[]): Timer;",
  "declare function clearTimeout(timer: Timer | number | undefined): void;",
  "declare function setInterval(callback: (...args: any[]) => void, delay?: number, ...args: any[]): Timer;",
  "declare function clearInterval(timer: Timer | number | undefined): void;",
  "declare function setImmediate(callback: (...args: any[]) => void, ...args: any[]): Timer;",
  "declare function clearImmediate(timer: Timer | undefined): void;",
  "declare function queueMicrotask(callback: () => void): void;",
  "declare function structuredClone<T>(value: T): T;",
  "declare function atob(data: string): string;",
  "declare function btoa(data: string): string;",
  "declare var performance: { now(): number; readonly timeOrigin: number };",
  "interface CryptoKey { readonly type: string; readonly extractable: boolean; readonly algorithm: object; readonly usages: readonly string[]; }",
  "interface SubtleCrypto { digest(algorithm: string | { name: string }, data: ArrayBuffer | ArrayBufferView): Promise<ArrayBuffer>; importKey(format: string, keyData: ArrayBuffer | ArrayBufferView | object, algorithm: string | object, extractable: boolean, keyUsages: readonly string[]): Promise<CryptoKey>; sign(algorithm: string | object, key: CryptoKey, data: ArrayBuffer | ArrayBufferView): Promise<ArrayBuffer>; verify(algorithm: string | object, key: CryptoKey, signature: ArrayBuffer | ArrayBufferView, data: ArrayBuffer | ArrayBufferView): Promise<boolean>; }",
  "interface Crypto { randomUUID(): string; getRandomValues<T extends ArrayBufferView>(array: T): T; readonly subtle: SubtleCrypto; }",
  "declare var crypto: Crypto;",
  "interface Buffer extends Uint8Array { toString(encoding?: string, start?: number, end?: number): string; toJSON(): { type: 'Buffer'; data: number[] }; equals(other: Uint8Array): boolean; }",
  "declare var Buffer: { from(data: string, encoding?: string): Buffer; from(data: ArrayBuffer | ArrayBufferView | readonly number[]): Buffer; alloc(size: number, fill?: string | number): Buffer; concat(list: readonly Uint8Array[], totalLength?: number): Buffer; isBuffer(value: unknown): value is Buffer; byteLength(value: string | ArrayBuffer | ArrayBufferView, encoding?: string): number };",
  "declare var process: { readonly env: Record<string, string | undefined>; readonly argv: readonly string[]; readonly platform: string; readonly version: string; readonly pid: number; hrtime: { bigint(): bigint }; nextTick(callback: (...args: any[]) => void, ...args: any[]): void; cwd(): string; uptime(): number; memoryUsage(): { rss: number; heapTotal: number; heapUsed: number; external: number } };",
  "interface ImportMeta { url: string; dirname: string; filename: string; resolve(specifier: string): string; }",
].join("\n")}\n${[...NODE_BUILTINS]
  .sort()
  .flatMap((name) => [`declare module "${name}";`, `declare module "node:${name}";`])
  .join("\n")}\n`;

/* --------------------------------- the diagnostics --------------------------------- */

class DiagnosticBag {
  readonly refusals: Diagnostic[] = [];
  readonly advice: Diagnostic[] = [];
  private readonly seen = new Set<string>();
  /** `${file}\0${line}` for every refusal raised so far — what `refusedOnLineOf` answers from. */
  private readonly refusedLines = new Set<string>();

  private readonly originals: Map<string, ts.SourceFile>;
  private readonly entryAbs: string;

  // Assigned here rather than as parameter properties: Node loads this file natively in the worker,
  // and a parameter property is the non-erasable syntax the check itself refuses.
  constructor(originals: Map<string, ts.SourceFile>, entryAbs: string) {
    this.originals = originals;
    this.entryAbs = entryAbs;
  }

  /** A refusal at a position in a file the module holds. */
  at(rule: RefusalRule, abs: string, pos: number, body: { message: string; hint: string }): void {
    const diagnostic = this.located(rule, abs, pos, body);
    this.refusedLines.add(`${abs}\0${diagnostic.line}`);
    this.push(this.refusals, diagnostic);
  }

  /** Has a refusal already been raised on the line this position falls on? */
  refusedOnLineOf(abs: string, pos: number): boolean {
    const sf = this.originals.get(abs);
    if (!sf) return false;
    const clamped = Math.max(0, Math.min(pos, sf.text.length));
    return this.refusedLines.has(`${abs}\0${sf.getLineAndCharacterOfPosition(clamped).line + 1}`);
  }

  has(rule: RefusalRule): boolean {
    return this.refusals.some((diagnostic) => diagnostic.rule === rule);
  }

  advise(
    rule: AdviceRule,
    abs: string,
    pos: number,
    body: { message: string; hint: string },
  ): void {
    this.push(this.advice, this.located(rule, abs, pos, body));
  }

  /** A refusal about the module as a whole, or about a file the compiler never parsed. */
  plain(rule: RefusalRule, file: string, body: { message: string; hint: string }): void {
    this.push(this.refusals, { file, line: 1, column: 1, text: "", ...body, rule });
  }

  result(entry: string, annotations: ToolAnnotations): ModuleCheckResult {
    const order = (a: Diagnostic, b: Diagnostic) =>
      (a.file === entry ? 0 : 1) - (b.file === entry ? 0 : 1) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.column - b.column;
    return {
      entry,
      refusals: this.refusals.sort(order).slice(0, MAX_DIAGNOSTICS),
      advice: this.advice.sort(order).slice(0, MAX_DIAGNOSTICS),
      annotations,
    };
  }

  private located(
    rule: DiagnosticRule,
    abs: string,
    pos: number,
    body: { message: string; hint: string },
  ): Diagnostic {
    const sf = this.originals.get(abs) ?? this.originals.get(this.entryAbs);
    const file = abs.startsWith(`${MODULE_ROOT}/`) ? abs.slice(MODULE_ROOT.length + 1) : abs;
    if (!sf) return { file, line: 1, column: 1, text: "", ...body, rule };
    const clamped = Math.max(0, Math.min(pos, sf.text.length));
    const { line, character } = sf.getLineAndCharacterOfPosition(clamped);
    const starts = sf.getLineStarts();
    const lineStart = starts[line] ?? 0;
    const lineEnd = starts[line + 1] ?? sf.text.length;
    const text = sf.text
      .slice(lineStart, lineEnd)
      .replace(/\r?\n$/, "")
      .trim()
      .slice(0, MAX_TEXT_CHARS);
    return { file, line: line + 1, column: character + 1, text, ...body, rule };
  }

  private push(list: Diagnostic[], diagnostic: Diagnostic): void {
    const key = `${diagnostic.rule}\0${diagnostic.file}\0${diagnostic.line}\0${diagnostic.column}\0${diagnostic.message}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    list.push(diagnostic);
  }
}

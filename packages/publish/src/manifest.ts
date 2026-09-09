import type { Diagnostic, DiagnosticRule } from "@graft/check";
import type { ToolboxFile } from "@graft/toolbox";

import type { PackagePolicyRule } from "./policy";

/**
 * What the publish adds to the check's vocabulary. A refusal from the publish has the check's
 * `Diagnostic` shape — file, line, column, the offending line, a message, a hint — so the model
 * reads one kind of answer whether the check or the publish refused; only the rule word is new.
 *
 *  - `draft-missing`: nothing is at the draft path.
 *  - `draft-contents`: the draft carries a file the publish writes itself or that would steer the
 *    install — a lockfile, an `.npmrc`, a `node_modules` (ADR 0013: the install step resolves
 *    packages, from the registry, under the policy; a lockfile written by the model would resolve
 *    them from wherever it said).
 *  - `manifest-invalid`: `package.json` is not JSON, or declares packages anywhere but under
 *    `dependencies`, which is the one section the policy reads and npm would install from anyway.
 *  - `package-policy`: a declared package fails the policy; `policy` names which rule.
 *  - `registry-unavailable`: the registry could not be asked; try again rather than rewrite.
 *  - `install-failed`: the build step did not complete; its stderr is in the message.
 */
export const PUBLISH_RULES = [
  "draft-missing",
  "draft-contents",
  "manifest-invalid",
  "package-policy",
  "registry-unavailable",
  "install-failed",
] as const;
export type PublishRule = (typeof PUBLISH_RULES)[number];

export type PublishDiagnostic = Omit<Diagnostic, "rule"> & {
  rule: DiagnosticRule | PublishRule;
  /** On a `package-policy` refusal: the package and the rule it failed, as data. */
  policy?: { package: string; version: string; rule: PackagePolicyRule };
};

/** One entry under `dependencies`, with where it sits in the file so a refusal can point at it. */
export type ManifestDependency = { name: string; spec: string; line: number; column: number };

export type ManifestReading =
  | { ok: true; dependencies: ManifestDependency[] }
  | { ok: false; refusals: PublishDiagnostic[] };

export const MANIFEST_FILE = "package.json";

/**
 * Files the install step owns, and files that would steer it. A draft carrying one is refused
 * rather than silently cleaned: the model wrote it for a reason, and the reason is what the
 * diagnostic asks it to drop.
 */
const FORBIDDEN_DRAFT_FILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pnpmfile.cjs",
]);

/** Sections npm would install from that the policy does not read; a module has `dependencies` and nothing else. */
const FORBIDDEN_MANIFEST_SECTIONS = [
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundleDependencies",
  "bundledDependencies",
  "overrides",
  "resolutions",
  "workspaces",
];

/** Anything the draft holds that the publish will not carry into a version. */
export function forbiddenDraftFiles(files: readonly ToolboxFile[]): PublishDiagnostic[] {
  const refusals: PublishDiagnostic[] = [];
  for (const file of files) {
    const top = file.path.split("/")[0] ?? "";
    if (top === "node_modules") {
      refusals.push({
        file: file.path,
        line: 1,
        column: 1,
        text: "",
        rule: "draft-contents",
        message: `The draft holds ${file.path}: packages are installed by the publish, into the version, never written into a draft.`,
        hint: "Remove node_modules from the draft; declare what the module imports under dependencies in package.json and the publish installs it.",
      });
    } else if (FORBIDDEN_DRAFT_FILES.has(file.path)) {
      refusals.push({
        file: file.path,
        line: 1,
        column: 1,
        text: file.content.split("\n")[0]?.trim() ?? "",
        rule: "draft-contents",
        message: `The draft holds ${file.path}: the install step writes the lockfile and reads the registry the deployment configured, so a module carries neither.`,
        hint: `Remove ${file.path} from the draft and publish again.`,
      });
    }
  }
  return refusals;
}

/**
 * The module's `package.json`, read for what the policy and the install need: the `dependencies`
 * table as name, spec and position. A missing file declares nothing. The other dependency sections
 * are refused rather than ignored, because npm would install them and the policy would not have
 * seen them — the one way a package could reach a version without clearing ADR 0013.
 */
export function readManifest(files: readonly ToolboxFile[]): ManifestReading {
  const manifest = files.find((file) => file.path === MANIFEST_FILE);
  if (!manifest) return { ok: true, dependencies: [] };

  const refuse = (
    line: number,
    column: number,
    message: string,
    hint: string,
  ): ManifestReading => ({
    ok: false,
    refusals: [
      {
        file: MANIFEST_FILE,
        line,
        column,
        text: manifest.content.split("\n")[line - 1]?.trim() ?? "",
        rule: "manifest-invalid",
        message,
        hint,
      },
    ],
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest.content);
  } catch (error) {
    return refuse(
      1,
      1,
      `package.json is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      'Write a JSON object with a "dependencies" table, or remove package.json when the module imports no package.',
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return refuse(1, 1, "package.json is not a JSON object.", 'Write { "dependencies": { … } }.');
  }
  const record = parsed as Record<string, unknown>;

  for (const section of FORBIDDEN_MANIFEST_SECTIONS) {
    const value = record[section];
    if (value === undefined) continue;
    if (typeof value === "object" && value !== null && Object.keys(value).length === 0) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    const at = positionOf(manifest.content, section);
    return refuse(
      at.line,
      at.column,
      `package.json declares ${section}; a module declares its packages under dependencies and nothing else, so the package policy sees every package the install would resolve.`,
      `Move what the module imports under dependencies and remove ${section}.`,
    );
  }

  if (record.type !== undefined && record.type !== "module") {
    const at = positionOf(manifest.content, "type");
    return refuse(
      at.line,
      at.column,
      `package.json sets "type": ${JSON.stringify(record.type)}; the runner loads the module as an ES module.`,
      'Remove "type", or set it to "module".',
    );
  }

  const dependencies = record.dependencies;
  if (dependencies === undefined) return { ok: true, dependencies: [] };
  if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) {
    const at = positionOf(manifest.content, "dependencies");
    return refuse(
      at.line,
      at.column,
      "package.json's dependencies is not an object of package name to version.",
      'Write "dependencies": { "<package>": "<exact version>" }.',
    );
  }

  const list: ManifestDependency[] = [];
  for (const [name, spec] of Object.entries(dependencies)) {
    const at = positionOf(manifest.content, name);
    if (typeof spec !== "string") {
      return refuse(
        at.line,
        at.column,
        `The version of ${name} under dependencies is not a string.`,
        `Write "${name}": "<exact version>".`,
      );
    }
    list.push({ name, spec, line: at.line, column: at.column });
  }
  list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { ok: true, dependencies: list };
}

/** Where a JSON key sits in the text, 1-based, so a diagnostic points at the line the model wrote. */
export function positionOf(text: string, key: string): { line: number; column: number } {
  const needle = `${JSON.stringify(key)}`;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const index = line.indexOf(needle);
    if (index !== -1 && /^\s*:/.test(line.slice(index + needle.length))) {
      return { line: i + 1, column: index + 1 };
    }
  }
  return { line: 1, column: 1 };
}

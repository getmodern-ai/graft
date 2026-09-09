import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { RunnerFile } from "./runner-source";

/**
 * Loading the skills that are seeded into a sandbox beside the runner.
 *
 * A skill is procedural knowledge the authoring model reads on demand — the
 * [Agent Skills](https://agentskills.io) layout, `<name>/SKILL.md` with `name` and `description`
 * frontmatter. The split that keeps this cheap is the standard's own: **metadata is always in
 * context, bodies never are**. A skill costs a few dozen tokens to advertise and nothing at all until
 * one is opened.
 *
 * The one skill here, `authoring-a-tool`, is the discipline `acquire` runs (ADR 0004). It is not the
 * thin Hermes skill installed into a person's harness — that one is MIT and lives under the root
 * `skills/` directory (ADR 0015); this one never leaves Graft.
 */

export type Skill = {
  name: string;
  description: string;
  /** The full markdown, frontmatter stripped. What the model reads once it opens the skill. */
  content: string;
};

/** Where the skills are seeded inside a sandbox, beside the runner's `RUNNER_DIR`. */
export const SKILLS_DIR = "/skills";

/**
 * Where the shipped skills live: `packages/runner/skills`, resolved off `import.meta.url` because the
 * package ships source (AGENTS.md). The runner and the skills are the two things seeded into a
 * sandbox, which is why they share a package. If a bundler ever folds this package into an app, the
 * directory has to travel with the bundle and this constant is the one place to change.
 */
export const SKILLS_SOURCE_DIR = fileURLToPath(new URL("../skills/", import.meta.url));

/**
 * Pull `name` and `description` out of YAML frontmatter.
 *
 * Hand-rolled rather than a YAML dependency: the frontmatter of a skill is two scalar fields by
 * definition of the format, and a parser that only understands `key: value` cannot silently
 * misinterpret something more elaborate — it just refuses it. If skills ever need nested
 * frontmatter, take the dependency then.
 *
 * Returns null rather than throwing. A malformed skill should be skipped and logged, not take
 * the process down at boot.
 */
export function parseSkill(raw: string): Skill | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return null;

  const [, frontmatter, body] = match;
  const fields: Record<string, string> = {};

  for (const line of (frontmatter ?? "").split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^["'](.*)["']$/, "$1");
    if (key) fields[key] = value;
  }

  const name = fields.name;
  const description = fields.description;
  if (!name || !description) return null;

  return { name, description, content: (body ?? "").trim() };
}

/** Read every `<dir>/<name>/SKILL.md`. Sorted, so the list is stable between runs. */
export async function loadSkillsFrom(directory: string): Promise<Skill[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const skills: Skill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    let raw: string;
    try {
      raw = await readFile(join(directory, entry.name, "SKILL.md"), "utf8");
    } catch {
      // A directory without a SKILL.md is not a skill. Silent, because this is the normal way
      // to have supporting files sitting alongside skills.
      continue;
    }

    const skill = parseSkill(raw);
    if (!skill) {
      console.error(`skill "${entry.name}" has no usable frontmatter; skipping`);
      continue;
    }
    skills.push(skill);
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The shipped skills, read once per process.
 *
 * Cached on the resolved promise rather than the value, so concurrent first calls share one read
 * instead of racing. Skills ship with the package and cannot change under a running process, so
 * there is nothing to invalidate.
 */
let cached: Promise<Skill[]> | undefined;

export async function loadSkills(): Promise<Skill[]> {
  cached ??= loadSkillsFrom(SKILLS_SOURCE_DIR)
    .then((skills) => {
      // Logged on the happy path too: the directory is resolved off this file, and a deployment that
      // moved it would fail *silently* — the model would simply be a bit worse. One line per process
      // turns "did the skills ship?" into something a log answers.
      console.log(`loaded ${skills.length} skills from ${SKILLS_SOURCE_DIR}`);
      return skills;
    })
    .catch((error) => {
      // Degraded, not broken: a model with no skills still has the check and the dry run.
      console.error(`failed to load skills from ${SKILLS_SOURCE_DIR}:`, error);
      return [];
    });
  return cached;
}

/** Test seam. The cache is process-wide, so a test that loads from a fixture must clear it. */
export function resetSkillCache(): void {
  cached = undefined;
}

/**
 * The tree `writeTree` seeds under `SKILLS_DIR`: `<name>/SKILL.md` per skill, the frontmatter
 * restored so the file in the sandbox parses the same way this one did. The name is a path segment,
 * which `skills.test.ts` pins to `[a-z0-9-]+` for exactly that reason.
 */
export function skillFiles(skills: readonly Skill[]): RunnerFile[] {
  return skills.map((skill) => ({
    path: `${skill.name}/SKILL.md`,
    content: `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.content}\n`,
  }));
}

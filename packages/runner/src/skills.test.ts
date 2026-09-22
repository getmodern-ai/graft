import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { BLOB_REF_SCHEME, BLOB_TTL_MS, DRY_RUN_HEADER, MAX_BLOB_BYTES } from "./runner-source";
import { loadSkillsFrom, parseSkill, SKILLS_SOURCE_DIR, skillFiles } from "./skills";

/**
 * Skill loading.
 *
 * The failure this guards against is quiet: a malformed frontmatter block does not throw, it
 * just produces a model that has silently lost a skill it is supposed to have.
 */

async function fixture(skills: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skills-"));
  for (const [name, content] of Object.entries(skills)) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, "SKILL.md"), content, "utf8");
  }
  return root;
}

function skillFile(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
}

describe("parseSkill", () => {
  it("pulls name and description out of frontmatter and keeps the body", () => {
    const skill = parseSkill(skillFile("triage", "How to triage", "# Triage\n\nDo the thing."));

    expect(skill).toEqual({
      name: "triage",
      description: "How to triage",
      content: "# Triage\n\nDo the thing.",
    });
  });

  it("strips quotes, since a description with a colon has to be quoted in YAML", () => {
    const skill = parseSkill('---\nname: a\ndescription: "Read this: always"\n---\nbody');

    expect(skill?.description).toBe("Read this: always");
  });

  /** A description is the entire basis on which the model decides to open a skill. */
  it("rejects a skill with no description", () => {
    expect(parseSkill("---\nname: a\n---\nbody")).toBeNull();
  });

  it("rejects a file with no frontmatter at all", () => {
    expect(parseSkill("# Just markdown")).toBeNull();
  });

  it("handles CRLF line endings", () => {
    const skill = parseSkill("---\r\nname: a\r\ndescription: b\r\n---\r\nbody");

    expect(skill).toMatchObject({ name: "a", description: "b" });
  });
});

describe("loadSkillsFrom", () => {
  it("reads every <name>/SKILL.md", async () => {
    const root = await fixture({
      alpha: skillFile("alpha", "First", "one"),
      beta: skillFile("beta", "Second", "two"),
    });

    expect((await loadSkillsFrom(root)).map((s) => s.name)).toEqual(["alpha", "beta"]);
  });

  /** Stable ordering, because the list goes into every prompt and churn is noise. */
  it("sorts by name regardless of directory order", async () => {
    const root = await fixture({
      zulu: skillFile("zulu", "Last", "z"),
      alpha: skillFile("alpha", "First", "a"),
    });

    expect((await loadSkillsFrom(root)).map((s) => s.name)).toEqual(["alpha", "zulu"]);
  });

  it("skips a malformed skill rather than failing the whole load", async () => {
    const root = await fixture({
      good: skillFile("good", "Fine", "ok"),
      broken: "no frontmatter here",
    });

    expect((await loadSkillsFrom(root)).map((s) => s.name)).toEqual(["good"]);
  });

  it("ignores a directory with no SKILL.md", async () => {
    const root = await fixture({ real: skillFile("real", "Fine", "ok") });
    await mkdir(join(root, "assets"), { recursive: true });

    expect((await loadSkillsFrom(root)).map((s) => s.name)).toEqual(["real"]);
  });
});

/** The seeded tree round-trips: what `skillFiles` writes, `parseSkill` reads back unchanged. */
describe("skillFiles", () => {
  it("writes <name>/SKILL.md with the frontmatter restored, quoting a description with a colon", () => {
    const skill = { name: "alpha", description: "Read this: always", content: "# Alpha\n\nbody" };
    const [file] = skillFiles([skill]);

    expect(file?.path).toBe("alpha/SKILL.md");
    expect(parseSkill(file?.content ?? "")).toEqual(skill);
  });

  it("round-trips a description holding a double quote", () => {
    const skill = { name: "beta", description: 'Say "yes" once', content: "body" };
    const [file] = skillFiles([skill]);

    expect(file?.content).toContain('description: "Say \\"yes\\" once"');
    expect(parseSkill(file?.content ?? "")).toEqual(skill);
  });
});

/**
 * The skill that actually ships.
 *
 * Not a fixture — this reads the real directory, so a typo in a `SKILL.md` frontmatter block fails
 * here instead of silently removing the skill from the model that runs `acquire`.
 */
describe("the shipped skills", () => {
  it("all parse, and authoring-a-tool is among them", async () => {
    const skills = await loadSkillsFrom(SKILLS_SOURCE_DIR);

    expect(skills.map((skill) => skill.name)).toContain("authoring-a-tool");
    for (const skill of skills) {
      expect(skill.description.length).toBeGreaterThan(20);
      expect(skill.content.length).toBeGreaterThan(100);
    }
  });

  /**
   * The authoring skill carries every rule the loop depends on, pinned here because this suite is
   * where the real body is read: a rewrite that dropped "reads only until published", the SDK
   * binding, or the package policy sentence would otherwise leave the eval scenario the only thing
   * that notices, at model-run prices. The pins are Graft's words (CONTEXT.md, ADR 0010, ADR 0013):
   * the person, the handoff URL and the console, `ctx.proxyBase` and `ctx.proxyKey`, and no trace of
   * the product the skill was copied from (ADR 0011).
   */
  it("says how a tool is authored, in Graft's terms", async () => {
    const skills = await loadSkillsFrom(SKILLS_SOURCE_DIR);
    const authoring = skills.find((skill) => skill.name === "authoring-a-tool");

    expect(authoring).toBeDefined();
    const prose = authoring?.content.replace(/\s+/g, " ") ?? "";
    for (const rule of [
      "read_web_page",
      "untrusted text",
      "ctx.fetch(path, init)",
      "vendor-relative",
      "never names a host, never holds a key",
      "The vendor sees the proxy, not the person",
      "the tool's description and its output names say so or leave it out",
      "The bare minimum",
      "curl and Python are not",
      "Reads only, until the tool is published",
      "publish_tool",
      "run_tool",
      "execute__<connection id>",
      "Republish under the same name",
      "detached: true",
      "wait_for_process({ processName, maxWaitSeconds })",
      "drafts directory",
      "request_connection",
      "request_credential",
      "handoff URL",
      "in the console",
      // The module is TypeScript, checked before it is published.
      "check_tool",
      "index.ts",
      "erasable syntax only",
      "(input: Input, ctx: Context)",
      "import type",
      "refuses on the same list",
      // ADR 0023: the check's banned list, as `BANNED_MODULES` in `@graft/check` spells it (which
      // depends on this package, so the sentence is pinned here rather than the constant), and the
      // blob route the sentence names for a file.
      "`child_process`, `net`, `dgram`, `fs`, `fs/promises`, `worker_threads`, `vm`, `module`, `cluster` or `inspector`",
      "`ctx.blob.write` and `ctx.blob.read` are the route",
      // GRA-190: the blob section, in the words the runner and the door use. The `Context` line
      // is the check's `CONTEXT_DECLARATION` whole (pinned there to the runner's `ctx`); the
      // scheme, the cap and the life are this package's constants; the four refusal names are the
      // runner's (`blob_too_large`, `blob_not_found`) and the door's (`blob_not_found`,
      // `blob_expired`, `blob_quota`, `packages/mcp/src/blob-door.ts`).
      "## Moving a file between tools",
      "blob: { write(data: Uint8Array | Blob | ReadableStream<Uint8Array>, opts: { contentType: string; name?: string }): Promise<string>; read(ref: string): Promise<Blob>; stat(ref: string): Promise<{ bytes: number; contentType: string; name?: string; expiresAt: string }> }",
      `\`${BLOB_REF_SCHEME}<id>\``,
      "When to write a blob",
      "When to return data instead",
      "ctx.blob.write(res.body, {",
      'Buffer.from(data, "base64url")',
      "a field named for what it is, `file` or `attachment`",
      "takes the ref as a plain string",
      "put it in `testInput`",
      "mints a fixture blob (a few hundred bytes of `text/plain`)",
      `lives ${BLOB_TTL_MS / 3_600_000} hours`,
      `past ${MAX_BLOB_BYTES / (1024 * 1024)} MiB is refused as it streams, as \`blob_too_large\``,
      "as `blob_not_found` (another agent's ref reads the same)",
      "as `blob_expired`",
      "as `blob_quota`",
      "Writing a blob asks nothing and moves no annotation",
      // Publish with a test input, read the dry-run report, then the agent's first write.
      "Publish with a test input",
      "testInput",
      "Dry-running it",
      "writesPreviewed",
      "unverified",
      "dryRun: true",
      `${DRY_RUN_HEADER}: intercepted`,
      // The exec's environment is never read, and the names match the runner's prefix.
      "GRAFT_PROXY_URL",
      "GRAFT_TOKEN",
      "token_invalid",
      // ADR 0010: the ctx contract and the SDK section in its terms.
      "proxyBase(host?: string): string; proxyKey: string; connection: string | null",
      "An SDK is the last resort",
      "An SDK reaches the vendor through the proxy or not at all",
      "apiKey: ctx.proxyKey",
      "ctx.proxyBase()",
      "per run, never cached",
      "allowAbsoluteUrls: false",
      "Write Stripe calls with `ctx.fetch`",
      // ADR 0013: a package installs at publish, under the policy, or the calls are written by hand.
      "a package installs at publish, into the version, and only when it clears the package policy",
      "A refused package is a diagnostic, not a blocked tool",
      "import-not-vendored",
      // ADR 0008: the annotations are the check's, never the model's.
      "`readOnly` and `destructive`",
      "You do not declare them",
      "asks once, and the answer holds",
      "asks on every call only when the person has set it to",
    ]) {
      expect(prose, rule).toContain(rule);
    }

    // Cando's vocabulary does not survive the copy (ADR 0011; CONTEXT.md's Avoid lists).
    for (const gone of [
      "member",
      "Cando",
      "CANDO_",
      "/cando/",
      "x-cando",
      "catalogue",
      "Pipedream",
      "request_custom_app",
      "a card",
      "automation",
    ]) {
      expect(prose, gone).not.toContain(gone);
    }
  });

  /**
   * The frontmatter name becomes a path segment inside the sandbox — it is what the tree is
   * written under and what a skill read looks up — so anything needing escaping breaks the read.
   */
  it("are named as legal path segments", async () => {
    const skills = await loadSkillsFrom(SKILLS_SOURCE_DIR);

    for (const skill of skills) {
      expect(skill.name).toMatch(/^[a-z0-9-]+$/);
    }
  });
});

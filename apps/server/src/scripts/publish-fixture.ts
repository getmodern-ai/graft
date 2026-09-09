import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import { createAuth } from "@graft/auth";
import { createDb } from "@graft/db";
import { user } from "@graft/db/schema/auth";
import { env } from "@graft/env/server";
import {
  createPublishDeps,
  createRegistryMetadataSource,
  DEFAULT_PACKAGE_POLICY,
  publishToolVersion,
} from "@graft/publish";
import type { SandboxBackend, SandboxProcessResult } from "@graft/sandbox/types";
import { createDockerSandboxBackend } from "@graft/sandbox-docker";
import {
  createFilesystemToolboxStore,
  createNoopToolboxMirror,
  draftPath,
  type ToolboxFile,
  toolboxIdOf,
} from "@graft/toolbox";
import { eq } from "drizzle-orm";

/**
 * Publish a module from a directory on this machine into a person's toolbox, by hand — the publish
 * (`@graft/publish`, GRA-18) exercised end to end against the real database, the filesystem store
 * at `GRAFT_TOOLBOX_ROOT` and, when `GRAFT_SANDBOX_IMAGE` and `GRAFT_SANDBOX_NETWORK` are set, the
 * Docker backing's install step. Development only; GRA-19 exposes the same service as `publish_tool`
 * over MCP.
 *
 *   pnpm --filter @graft/server publish-fixture -- \
 *     --dir ../../packages/publish/fixtures/hello --vendor demo --name hello \
 *     --description "Greets a name" --email you@example.com [--password …]
 *
 * `--dir` is copied into the toolbox as a draft (`.drafts/fixture-<time>`) and published from there;
 * `schema.json` beside the module is the input schema unless `--schema` names another file, and is
 * not part of the draft. The person is `--person <id>` or `--email <email>`; an unknown email with
 * `--password` is signed up through Better Auth first. Without the Docker pair a module that declares
 * packages is refused with a diagnostic saying so, rather than half-published.
 */

const { values } = parseArgs({
  // pnpm forwards the `--` that separates its own flags from the script's.
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: {
    dir: { type: "string" },
    vendor: { type: "string" },
    name: { type: "string" },
    description: { type: "string" },
    schema: { type: "string" },
    person: { type: "string" },
    email: { type: "string" },
    password: { type: "string" },
  },
});

if (!values.dir || !values.vendor || !values.name || !values.description) {
  console.error(
    "usage: publish-fixture --dir <module dir> --vendor <slug> --name <kebab-name> --description <text> (--person <id> | --email <email> [--password <pw>]) [--schema <file.json>]",
  );
  process.exit(64);
}
if (!values.person && !values.email) {
  console.error("name the person: --person <id> or --email <email>");
  process.exit(64);
}

const dir = resolve(values.dir);
const schemaFile = values.schema ? resolve(values.schema) : join(dir, "schema.json");

/** Every file under the directory, paths relative to it, the schema file left out. */
async function readModuleDir(root: string): Promise<ToolboxFile[]> {
  const files: ToolboxFile[] = [];
  const walk = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (absolute !== schemaFile) {
        files.push({
          path: relative(root, absolute).split("\\").join("/"),
          content: await readFile(absolute, "utf8"),
        });
      }
    }
  };
  await walk(root);
  return files;
}

const inputSchema = JSON.parse(await readFile(schemaFile, "utf8").catch(() => '{"type":"object"}'));

const db = createDb(env.GRAFT_DATABASE_URL);
try {
  let personId = values.person ?? null;
  if (!personId && values.email) {
    const [existing] = await db.select().from(user).where(eq(user.email, values.email)).limit(1);
    if (existing) {
      personId = existing.id;
    } else if (values.password) {
      const auth = createAuth({
        db,
        secret: env.GRAFT_AUTH_SECRET,
        baseURL: env.GRAFT_AUTH_URL,
        trustedOrigins: env.GRAFT_CORS_ORIGIN,
      });
      const signedUp = await auth.api.signUpEmail({
        body: { email: values.email, password: values.password, name: values.email },
      });
      personId = signedUp.user.id;
      console.error(`signed up ${values.email} as person ${personId}`);
    } else {
      console.error(`no person has the email ${values.email}; pass --password to sign one up`);
      process.exit(1);
    }
  }
  if (!personId) throw new Error("unreachable: a person was required above");

  const store = createFilesystemToolboxStore({ root: env.GRAFT_TOOLBOX_ROOT });
  // The Docker backing when the environment names one — bound to the store's root so the install
  // step and the store see one tree (`@graft/toolbox`'s README) — else an install that answers with
  // why it cannot run, which the publish turns into an `install-failed` diagnostic.
  const sandbox: Pick<SandboxBackend, "install"> =
    env.GRAFT_SANDBOX_IMAGE && env.GRAFT_SANDBOX_NETWORK
      ? createDockerSandboxBackend({
          image: env.GRAFT_SANDBOX_IMAGE,
          network: env.GRAFT_SANDBOX_NETWORK,
          toolboxHostRoot: store.root,
        })
      : {
          install: async (): Promise<SandboxProcessResult> => {
            const logs =
              "no sandbox backing is configured: set GRAFT_SANDBOX_IMAGE and GRAFT_SANDBOX_NETWORK to run the install step (packages/sandbox-docker/README.md)";
            return { status: "failed", exitCode: null, logs, stdout: "", stderr: logs };
          },
        };

  const deps = createPublishDeps({
    db,
    store,
    mirror: createNoopToolboxMirror(),
    sandbox,
    metadata: createRegistryMetadataSource(),
    policy: {
      allowlist: [...DEFAULT_PACKAGE_POLICY.allowlist, ...env.GRAFT_PACKAGE_ALLOWLIST],
      minAgeDays: env.GRAFT_PACKAGE_MIN_AGE_DAYS,
      minWeeklyDownloads: env.GRAFT_PACKAGE_MIN_WEEKLY_DOWNLOADS,
    },
    onMirror: (event) => console.error(`mirror: ${JSON.stringify(event)}`),
  });

  const toolboxId = toolboxIdOf(personId);
  const draft = draftPath(`fixture-${Date.now().toString(36)}`);
  await store.writeTree(toolboxId, draft, await readModuleDir(dir));
  console.error(`draft written to ${store.toolboxRoot(toolboxId)}/${draft}`);

  const outcome = await publishToolVersion(deps, {
    personId,
    toolboxId,
    vendor: values.vendor,
    name: values.name,
    description: values.description,
    inputSchema,
    draftPath: draft,
  });

  if (outcome.ok) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          tool: { id: outcome.tool.id, vendor: outcome.tool.vendor, name: outcome.tool.name },
          version: {
            id: outcome.version.id,
            number: outcome.version.versionNumber,
            path: `${store.toolboxRoot(toolboxId)}/${outcome.version.path}`,
            sourceHash: outcome.version.sourceHash,
            lockfileHash: outcome.version.lockfileHash,
          },
          annotations: outcome.annotations,
          dependencies: outcome.dependencies,
          advice: outcome.advice,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      JSON.stringify({ ok: false, refusals: outcome.refusals, advice: outcome.advice }, null, 2),
    );
    process.exitCode = 1;
  }
} finally {
  await db.close();
}

import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { checkModule } from "@graft/check";
import {
  type AcquireStatus,
  type AcquireSuccess,
  createAcquireRunner,
  createInFlightRegistry,
  createToolListChangedNotifier,
  type McpDeps,
  openAgentSession,
  type ReadWebPage,
} from "@graft/mcp";
import { createFakeDeps, createFakeStore } from "@graft/mcp/testing/fake-deps";
import { generateTestKeys } from "@graft/mcp/testing/fake-vendor";
import type { ModelAdapter, ModuleDraft } from "@graft/model";
import { createProxyApp, type ProxyConnection, type UpstreamFetch } from "@graft/proxy";
import {
  createFakeMetadataSource,
  createPublishDeps,
  DEFAULT_PACKAGE_POLICY,
  publishToolVersion,
} from "@graft/publish";
import { loadSkills, runnerFiles } from "@graft/runner";
import { createFakeSandboxBackend } from "@graft/sandbox";
import type { LiveConnection } from "@graft/stock/mode";
import { createCapabilityTokenVerifier } from "@graft/token";
import { createFilesystemToolboxStore, createNoopToolboxMirror } from "@graft/toolbox";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * The `acquire` loop as a maintainer runs it to build a stock tool (GRA-246; ADR 0025): the real
 * MCP session, the real job and runner, the real check, the real publish, and the real proxy on a
 * loopback port in front of the maintainer's own connection. What would need infrastructure is held
 * in this process and thrown away at the end: the database is `@graft/mcp`'s in-memory store, the
 * toolbox a temporary directory, and the sandbox the fake backing (`@graft/sandbox`: the module runs
 * as a child process on the maintainer's machine, which is not a sandbox; the README says so). So
 * nothing reaches a person's toolbox or any database, hosted or local.
 *
 * Shaped as `@graft/evals`' world is, with the vendor real rather than scripted: the proxy's
 * `upstreamFetch` is the vendor (the proxy's own guarded fetch, or a suite's).
 */

const PERSON = "person_stock_maintainer";
const AGENT = "agent_stock_maintainer";
const TOKEN = "grft_stock_build_token_0000000000000000000000000";
const CONNECTION = "conn_stock_maintainer";

/** The integration as the job is told of it: the starter's slug, name and hosts, and how it is reached. */
export type BuildConnection = {
  vendor: string;
  displayName: string;
  primaryHost: string;
  hosts: readonly string[];
  /** The maintainer's scheme and credential; `none` and no fields for a keyless starter. */
  live: LiveConnection;
};

export type LoopOutcome =
  | { ok: true; success: AcquireSuccess; draft: ModuleDraft; progress: string[] }
  | { ok: false; status: AcquireStatus; progress: string[] };

/**
 * The adapter in the model's seat, wrapped: the opening context carries `extraHints` after the
 * job's own (the starting module of a repair, which can run past the 4,000 characters `acquire`
 * takes as hints), and every draft the model writes is kept, since the job writes the test input
 * nowhere a caller can read it back. The last draft is the one that passed.
 */
function buildModel(
  model: ModelAdapter,
  extraHints: string | null,
  drafts: ModuleDraft[],
): ModelAdapter {
  return {
    name: model.name,
    open(context) {
      const hints = [context.hints, extraHints].filter(Boolean).join("\n\n") || null;
      const conversation = model.open({ ...context, hints });
      return {
        async turn(situation) {
          const reply = await conversation.turn(situation);
          if (reply.answer.kind === "write_module") drafts.push(reply.answer.draft);
          return reply;
        },
      };
    },
  };
}

function bodyOf<T>(result: CallToolResult): T {
  const first = result.content[0];
  if (first?.type !== "text") throw new Error("the tool answered with no text content");
  return JSON.parse(first.text) as T;
}

export async function runBuildLoop(args: {
  connection: BuildConnection;
  model: ModelAdapter;
  goal: string;
  /** What `acquire` is handed as `hints`, within its 4,000 characters. */
  hints: string | null;
  /** What the model's opening context carries beyond that: the starting module of a repair. */
  extraHints: string | null;
  upstreamFetch: UpstreamFetch;
  readWebPage: ReadWebPage;
  maxAttempts: number;
  tokenCeiling: number;
  onProgress?: (line: string) => void;
}): Promise<LoopOutcome> {
  const { connection } = args;
  const keys = await generateTestKeys();
  const primary = new URL(connection.primaryHost);
  const hosts = [...new Set([primary.hostname, ...connection.hosts])];

  // The proxy, in front of the maintainer's own credential, which never leaves this process.
  const proxyConnection: ProxyConnection = {
    id: CONNECTION,
    personId: PERSON,
    authScheme: connection.live.scheme,
    primaryHost: connection.primaryHost,
    hosts,
    schemeConfig: connection.live.schemeConfig,
    // A placeholder the decrypt below ignores: the fields are in hand already.
    credentialCiphertext: connection.live.scheme === "none" ? null : new Uint8Array([0]),
  };
  const proxy = createProxyApp({
    ...createCapabilityTokenVerifier(keys),
    connections: { get: async (id) => (id === CONNECTION ? proxyConnection : null) },
    decryptCredential: async () => connection.live.credential,
    upstreamFetch: args.upstreamFetch,
    log: () => {},
  });
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const listening = serve({ fetch: proxy.fetch, hostname: "127.0.0.1", port: 0 }, () =>
      resolve(listening),
    );
  });

  const sandbox = createFakeSandboxBackend();
  const store = createFakeStore();
  store.addConnection({
    id: CONNECTION,
    personId: PERSON,
    vendor: connection.vendor,
    displayName: connection.displayName,
    scheme: connection.live.scheme,
    schemeConfig: connection.live.schemeConfig,
    primaryHost: connection.primaryHost,
    hosts,
  });
  store.addAgent({
    scopeMode: "listed",
    id: AGENT,
    personId: PERSON,
    token: TOKEN,
    name: "stock maintainer",
    connectionIds: [CONNECTION],
  });
  // The maintainer is the person here, and running the command is their yes to the build.
  store.grantBuild(AGENT, CONNECTION);

  const fake = createFakeDeps(store);
  const toolbox = createFilesystemToolboxStore({ root: join(sandbox.root, "toolboxes") });
  const publish = createPublishDeps({
    db: fake.db,
    store: toolbox,
    mirror: createNoopToolboxMirror(),
    sandbox,
    // No package is admitted: a stock tool declares none, and the build refuses a draft that does.
    metadata: createFakeMetadataSource({}),
    policy: DEFAULT_PACKAGE_POLICY,
    tool: fake.tool,
    check: (input, checkOptions) => checkModule(input, checkOptions),
  });
  const drafts: ModuleDraft[] = [];
  const runnerErrors: unknown[] = [];
  const deps: McpDeps = {
    ...fake,
    sandbox,
    keys,
    proxyPublicUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    checkModule,
    runnerFiles,
    skills: loadSkills,
    readWebPage: args.readWebPage,
    listChangedWindowMs: 50,
    toolbox,
    publishTool: (publishArgs) => publishToolVersion(publish, publishArgs),
    handoff: {
      consoleUrl: "http://console.stock-build.invalid",
      secret: "graft-stock-build-handoff-secret-long-enough-32",
      // `acquire` and `acquire_status` hold their call for news up to this long, looking at the
      // row every `pollMs`; at 0 each answers at once and the wait below spins on the event loop.
      waitMs: 20_000,
      pollMs: 100,
      ttlMs: 60 * 60 * 1000,
    },
    notifier: createToolListChangedNotifier({ windowMs: 50 }),
    inFlight: createInFlightRegistry(),
    model: buildModel(args.model, args.extraHints, drafts),
    acquire: { maxAttempts: args.maxAttempts, tokenCeiling: args.tokenCeiling },
  };
  const runner = createAcquireRunner(deps, {
    concurrency: 1,
    pollIntervalSeconds: 3600,
    staleAfterSeconds: 3600,
    heartbeatMs: 1_000,
    // A throw the job could not record (the runner's own failure) ends the build, not the wait.
    onError: (error) => runnerErrors.push(error),
    onEvent: (event) => {
      if (event.kind === "failed") runnerErrors.push(new Error(event.error));
    },
  });
  deps.acquireRunner = runner;

  const notifier = deps.notifier;
  if (!notifier) throw new Error("the loop has no notifier");
  const session = await openAgentSession(deps, TOKEN, notifier);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await session.server.connect(serverTransport);
  const client = new Client({ name: "graft-stock-build", version: "0.0.0" });
  await client.connect(clientTransport);
  const call = async <T>(name: string, toolArgs: Record<string, unknown>) =>
    bodyOf<T>((await client.callTool({ name, arguments: toolArgs })) as CallToolResult);

  try {
    const started = await call<AcquireStatus & { error?: string; message?: string }>("acquire", {
      connectionId: CONNECTION,
      goal: args.goal,
      ...(args.hints ? { hints: args.hints } : {}),
      // The toolbox is empty and stock is not searched here: the build is asked for by name.
      ignoreExisting: true,
    });
    if (typeof started.jobId !== "string") {
      // A refusal at the door (Greptile on #191): answered as a failed build, never a throw.
      const refused = {
        status: "failed",
        progress: [],
        result: {
          failure: started.error ?? "acquire_refused",
          message: started.message ?? `acquire did not start a job: ${JSON.stringify(started)}`,
        },
      } as unknown as AcquireStatus;
      return { ok: false, status: refused, progress: [] };
    }
    let status = started;
    let relayed = 0;
    const relay = () => {
      for (const line of status.progress.slice(relayed)) args.onProgress?.(line);
      relayed = status.progress.length;
    };
    while (status.status === "queued" || status.status === "running") {
      relay();
      // Waits for a line past the ones relayed, or the end, then answers the whole status.
      status = await call<AcquireStatus>("acquire_status", {
        jobId: started.jobId,
        after: relayed,
      });
      const [error] = runnerErrors;
      if (error) {
        throw new Error(
          `the acquire runner failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    relay();
    const result = status.result;
    if (status.status !== "succeeded" || !result || !("tool" in result)) {
      return { ok: false, status, progress: status.progress };
    }
    const draft = drafts.at(-1);
    if (!draft || draft.name !== result.name) {
      throw new Error(`the job published ${result.tool}, but no draft of that name was kept`);
    }
    return { ok: true, success: result, draft, progress: status.progress };
  } finally {
    await client.close().catch(() => undefined);
    await session.close().catch(() => undefined);
    runner.stop();
    notifier.close();
    deps.inFlight?.close();
    await sandbox.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

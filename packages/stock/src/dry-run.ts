import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { starterVendorFor } from "@graft/core";
import {
  createProxyApp,
  DRY_RUN_HEADER,
  type ProxyConnection,
  type UpstreamFetch,
} from "@graft/proxy";
import { RUNNER_SOURCE_PATH, readRunnerEnvelope } from "@graft/runner";
import {
  createCapabilityTokenVerifier,
  importCapabilityTokenKeys,
  mintCapabilityToken,
} from "@graft/token";
import { serve } from "@hono/node-server";

import type { LiveConnection } from "./mode";
import { type RecordedBody, recordedBodyOf } from "./recording";
import type { StockWorkspaceTool } from "./workspace";

/**
 * One dry run of a stock tool's module with its test input, by the real runner (a child process)
 * through the real proxy on loopback, under a dry-run capability token: what the harness's replay
 * (`harness.ts`) and the build command's recording (`record.ts`, GRA-246) both are. The caller
 * hands the proxy its vendor (`upstreamFetch`): the recording, the live vendor, or the live vendor
 * behind a recorder. Every write stops at the proxy's preview, and the proxy's own account of each
 * is handed to `onPreview` with the sequence its request was issued in.
 *
 * **Every request is numbered at the proxy's door, in the order it arrived** (Greptile on #191): a
 * module that calls with `Promise.all` has its answers come back in whatever order the vendor
 * keeps, so the order of issue is taken before the proxy awaits anything and carried through the
 * proxy's own call of the vendor as `issueSequence()`. The recorder orders its exchanges by it.
 */

const PERSON = "person_stock_harness";
const AGENT = "agent_stock_harness";
export const STOCK_CONNECTION_ID = "conn_stock_harness";
/** Long enough for a cold Node to load a module and make a few calls; the runner's own default is 60 s. */
const RUN_TIMEOUT_MS = 30_000;

/** A write the proxy stopped, as its preview named it. */
export type PreviewedWrite = {
  method: string;
  host: string;
  path: string;
  body: RecordedBody | undefined;
  /** Where its request came in the order the module issued its requests, from 0. */
  sequence: number;
};

const issued = new AsyncLocalStorage<number>();

/**
 * The sequence of the request the proxy is handling, read inside its `upstreamFetch`: where the
 * request came in the order the module issued them. Undefined outside a dry run's request.
 */
export function issueSequence(): number | undefined {
  return issued.getStore();
}

/** The runner's dry-run report, as much of it as the harness and the recorder read. */
export type StockDryRunReport = {
  passed: boolean;
  reads: { method: string; path: string; status: number; reason?: string }[];
  writesRefused: { method: string; path: string; status: number }[];
  moduleResult?: unknown;
  moduleError?: string;
};

export type StockDryRun =
  | { ran: true; report: StockDryRunReport }
  | { ran: false; code: number | null; stderr: string };

async function testKeys() {
  const pair = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return importCapabilityTokenKeys({
    privateKeyPem: pair.privateKey,
    publicKeyPem: pair.publicKey,
  });
}

function runRunner(args: {
  moduleDir: string;
  env: Record<string, string>;
  input: unknown;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER_SOURCE_PATH, args.moduleDir], {
      // A clean environment, so a developer's own `HTTPS_PROXY` or `NODE_OPTIONS` cannot leak in.
      env: { PATH: process.env.PATH ?? "", ...args.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(args.input));
  });
}

/**
 * The connection a dry run is minted for. With no live connection: the tool's declared hosts and
 * nothing else, so a call to an undeclared host is the proxy's `host_not_in_set`, and the `none`
 * scheme, since the vendor is the recording and the credential's header is not compared. With one:
 * its scheme and parameters, or a sentence when a keyed starter has none. **The primary host is one
 * the manifest declares** (Greptile on #187): the proxy admits the primary host's name beside
 * `hosts`, so a starter's primary host the manifest omits would let an undeclared call pass. The
 * starter's is used where the manifest declares its name, else the manifest's first host; a live
 * connection's own primary host (a test account that answers elsewhere) is used as given.
 */
export function stockConnectionFor(
  tool: Pick<StockWorkspaceTool, "vendor" | "hosts">,
  live: LiveConnection | null,
  required: boolean,
): ProxyConnection | string {
  const starter = starterVendorFor(tool.vendor);
  const declared = new Set(tool.hosts);
  const hostnameOf = (url: string) => new URL(url).hostname.toLowerCase();
  const primaryHost =
    live?.primaryHost ??
    (starter && declared.has(hostnameOf(starter.primaryHost))
      ? starter.primaryHost
      : `https://${tool.hosts[0]}`);
  const hosts = [...new Set([hostnameOf(primaryHost), ...tool.hosts])];
  if (required && live === null && starter && starter.scheme !== "none") {
    return `there is no live connection for ${tool.vendor}; give it under GRAFT_STOCK_LIVE_CONNECTIONS`;
  }
  return {
    id: STOCK_CONNECTION_ID,
    personId: PERSON,
    authScheme: live?.scheme ?? "none",
    primaryHost,
    hosts,
    schemeConfig: live?.schemeConfig ?? {},
    // A placeholder the decrypt below ignores: the fields are in hand already.
    credentialCiphertext: live && live.scheme !== "none" ? new Uint8Array([0]) : null,
  };
}

export async function dryRunStockTool(args: {
  tool: StockWorkspaceTool;
  connection: ProxyConnection;
  credential: Record<string, string>;
  upstreamFetch: UpstreamFetch;
  onPreview: (write: PreviewedWrite) => void;
  /**
   * Each request as the module sent it to the proxy, query included: a write's preview names no
   * query (`@graft/proxy`'s dry run), so a test of a write's query reads it here.
   */
  onRequest?: (method: string, url: string) => void;
}): Promise<StockDryRun> {
  const { tool } = args;
  const keys = await testKeys();
  const app = createProxyApp({
    ...createCapabilityTokenVerifier(keys),
    connections: {
      get: async (id) => (id === args.connection.id ? args.connection : null),
    },
    decryptCredential: async () => args.credential,
    upstreamFetch: args.upstreamFetch,
    log: () => {},
  });
  // The proxy's own account of each write it stopped: its preview names the vendor host and path.
  let arrived = 0;
  const observed = async (request: Request): Promise<Response> => {
    // Numbered on arrival, before anything is awaited, and carried into the proxy's vendor call.
    const sequence = arrived++;
    args.onRequest?.(request.method, request.url);
    const response = await issued.run(sequence, () => app.fetch(request));
    if (response.headers.get(DRY_RUN_HEADER) === "intercepted") {
      const preview = (await response.clone().json()) as {
        request: {
          method: string;
          host: string;
          path: string;
          body: string;
          bodyEncoding: string;
        };
      };
      const bytes =
        preview.request.bodyEncoding === "base64"
          ? Buffer.from(preview.request.body, "base64")
          : new TextEncoder().encode(preview.request.body);
      args.onPreview({
        method: preview.request.method,
        host: preview.request.host,
        path: preview.request.path,
        body: recordedBodyOf(bytes),
        sequence,
      });
    }
    return response;
  };
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const listening = serve({ fetch: observed, hostname: "127.0.0.1", port: 0 }, () =>
      resolve(listening),
    );
  });
  const moduleDir = await mkdtemp(join(tmpdir(), "graft-stock-dry-run-"));
  try {
    for (const file of tool.files) {
      const path = join(moduleDir, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content);
    }
    const token = await mintCapabilityToken(
      {
        personId: PERSON,
        agentId: AGENT,
        connectionIds: [args.connection.id],
        tool: `${tool.vendor}__${tool.name}`,
        ttlSeconds: 300,
        dryRun: true,
      },
      keys,
    );
    const run = await runRunner({
      moduleDir,
      input: tool.testInput,
      env: {
        GRAFT_PROXY_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        GRAFT_CONNECTION: args.connection.id,
        GRAFT_TOKEN: token,
        GRAFT_DRY_RUN: "1",
        GRAFT_TIMEOUT_MS: String(RUN_TIMEOUT_MS),
        GRAFT_BLOBS_DIR: join(moduleDir, ".blobs"),
      },
    });
    const envelope = readRunnerEnvelope(run.stdout);
    if (!envelope) return { ran: false, code: run.code, stderr: run.stderr };
    return { ran: true, report: envelope.result as StockDryRunReport };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(moduleDir, { recursive: true, force: true });
  }
}

/** A dry run that did not pass, in one clause: the reads that failed, the writes refused, the throw. */
export function dryRunFailureOf(report: StockDryRunReport): string {
  const failed = [
    ...report.reads
      .filter((read) => read.status >= 300)
      .map(
        (read) =>
          `${read.method} ${read.path} answered ${read.status}${read.reason ? ` (${read.reason})` : ""}`,
      ),
    ...report.writesRefused.map(
      (write) => `${write.method} ${write.path} was refused ${write.status}`,
    ),
    ...(report.moduleError ? [`the module threw: ${report.moduleError.split("\n")[0]}`] : []),
  ];
  return failed.join("; ") || "no reason given";
}

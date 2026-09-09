import { request as httpRequest, type IncomingMessage } from "node:http";
import type { Readable } from "node:stream";

/**
 * The Docker Engine API over the socket, with nothing between us and it.
 *
 * Raw HTTP rather than a client library, because the surface this backing uses is a dozen
 * endpoints and the one hard part — demultiplexing an exec's output stream — is the same eight-byte
 * frame header whichever client reads it. A library would add a dependency tree (SSH transport,
 * its own tar) and a second typing package for an API whose JSON we read a handful of fields from.
 * The same code reaches a daemon over a mounted socket or a TCP sibling, which is what the compose
 * file needs (ADR 0002, "the Docker socket or a sibling-container pattern"); `resolveDockerHost`
 * reads the same `DOCKER_HOST` the CLI does.
 */

/**
 * Pinned so a field we read cannot change shape under us. 1.45 is Docker 26 (March 2024): the first
 * with `VolumeOptions.Subpath`, which the shared-toolbox arrangement mounts by (`backend.ts`,
 * `toolboxVolume`). An older daemon would accept the field and ignore it, mounting the whole volume
 * into a sandbox — so the version is asked for outright and an older daemon refuses every call.
 */
export const DOCKER_API_VERSION = "v1.45";

export const DEFAULT_DOCKER_SOCKET = "/var/run/docker.sock";

export type DockerEndpoint = { socketPath: string } | { host: string; port: number };

/**
 * `DOCKER_HOST` as the CLI reads it: `unix:///path` or `tcp://host:port`, defaulting to the local
 * socket. TLS is refused outright rather than half-supported: a daemon on a TLS port wants client
 * certificates this backing has no way to be handed, and a plaintext attempt against it would fail
 * with a message about the protocol rather than about the certificate.
 */
export function resolveDockerHost(value: string | undefined): DockerEndpoint {
  if (!value || value.trim() === "") return { socketPath: DEFAULT_DOCKER_SOCKET };
  if (value.startsWith("unix://"))
    return { socketPath: value.slice("unix://".length) || DEFAULT_DOCKER_SOCKET };
  if (value.startsWith("tcp://") || value.startsWith("http://")) {
    const url = new URL(value.replace(/^tcp:/, "http:"));
    return { host: url.hostname, port: url.port ? Number(url.port) : 2375 };
  }
  if (value.startsWith("https://") || value.startsWith("ssh://") || value.startsWith("npipe://")) {
    throw new Error(`DOCKER_HOST scheme not supported by @graft/sandbox-docker: ${value}`);
  }
  throw new Error(`DOCKER_HOST is not unix:// or tcp://: ${value}`);
}

export class DockerEngineError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly path: string,
  ) {
    super(`docker ${path} answered ${status}: ${message}`);
    this.name = "DockerEngineError";
  }
}

type RequestOptions = {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** A stream to send as the body (a tar for the archive endpoint) instead of JSON. */
  stream?: Readable;
  headers?: Record<string, string>;
  /** Fail the request after this long. Unset means the daemon decides, which for a wait is never. */
  timeoutMs?: number;
};

export class DockerEngine {
  constructor(readonly endpoint: DockerEndpoint) {}

  /** Send a request and return the response with its body read in full. */
  async request(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<{ status: number; body: Buffer; headers: IncomingMessage["headers"] }> {
    const response = await this.open(method, path, options);
    const body = await readAll(response);
    return { status: response.statusCode ?? 0, body, headers: response.headers };
  }

  /** A JSON endpoint: parses the answer, throws `DockerEngineError` on a non-2xx status. */
  async json<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const { status, body } = await this.request(method, path, options);
    if (status < 200 || status >= 300) throw errorFrom(status, body, path);
    return body.length === 0 ? (undefined as T) : (JSON.parse(body.toString("utf8")) as T);
  }

  /**
   * A streaming endpoint: the response is handed back unread once its status is known, or thrown as
   * `DockerEngineError` on a non-2xx status. The caller owns the stream from here.
   */
  async stream(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<IncomingMessage> {
    const response = await this.open(method, path, options);
    const status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      const body = await readAll(response);
      throw errorFrom(status, body, path);
    }
    return response;
  }

  /** `GET /_ping`: whether a daemon answers at the endpoint. */
  async ping(timeoutMs = 3000): Promise<boolean> {
    try {
      const { status } = await this.request("GET", "/_ping", { timeoutMs });
      return status === 200;
    } catch {
      return false;
    }
  }

  private open(method: string, path: string, options: RequestOptions): Promise<IncomingMessage> {
    const query = Object.entries(options.query ?? {})
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      .join("&");
    const fullPath = `/${DOCKER_API_VERSION}${path}${query ? `?${query}` : ""}`;
    const json = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
    const headers: Record<string, string> = {
      // The daemon answers a request for a hostname it does not know with 400 on some versions;
      // `localhost` is what the CLI sends over the socket.
      Host: "localhost",
      ...(json
        ? { "Content-Type": "application/json", "Content-Length": String(json.length) }
        : {}),
      ...(options.stream ? { "Content-Type": "application/x-tar" } : {}),
      ...options.headers,
    };
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          ...this.endpoint,
          method,
          path: fullPath,
          headers,
          ...(options.timeoutMs !== undefined
            ? { signal: AbortSignal.timeout(options.timeoutMs) }
            : {}),
        },
        resolve,
      );
      request.on("error", (error) =>
        reject(
          new Error(
            `docker ${method} ${fullPath} failed: ${error.message} (endpoint ${describeEndpoint(this.endpoint)})`,
            { cause: error },
          ),
        ),
      );
      if (options.stream) {
        options.stream.on("error", (error) => request.destroy(error));
        options.stream.pipe(request);
      } else {
        request.end(json);
      }
    });
  }
}

function describeEndpoint(endpoint: DockerEndpoint): string {
  return "socketPath" in endpoint
    ? `unix://${endpoint.socketPath}`
    : `tcp://${endpoint.host}:${endpoint.port}`;
}

function errorFrom(status: number, body: Buffer, path: string): DockerEngineError {
  let message = body.toString("utf8").trim();
  try {
    const parsed = JSON.parse(message) as { message?: string };
    if (typeof parsed.message === "string") message = parsed.message;
  } catch {
    // Not JSON: the raw body is the message.
  }
  return new DockerEngineError(status, message, path);
}

export function readAll(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/** The two streams of a multiplexed Docker stream, apart and together in arrival order. */
export type DemuxedOutput = { stdout: string; stderr: string; logs: string };

/**
 * Docker multiplexes an exec's or a container's stdout and stderr into one stream of frames, each
 * an eight-byte header — stream type in the first byte, payload length big-endian in the last four
 * — followed by the payload. Frames arrive split across chunks however the socket delivered them,
 * so this keeps what it has not yet been able to read and picks up where it left off.
 */
export function createDemuxer(): {
  push(chunk: Buffer): void;
  result(): DemuxedOutput;
} {
  let pending: Buffer = Buffer.alloc(0);
  let stdout = "";
  let stderr = "";
  let logs = "";
  return {
    push(chunk) {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      for (;;) {
        if (pending.length < 8) return;
        const type = pending[0];
        const size = pending.readUInt32BE(4);
        if (pending.length < 8 + size) return;
        const payload = pending.subarray(8, 8 + size).toString("utf8");
        pending = pending.subarray(8 + size);
        logs += payload;
        if (type === 2) stderr += payload;
        else stdout += payload;
      }
    },
    result: () => ({ stdout, stderr, logs }),
  };
}

/** Read a whole multiplexed stream. */
export async function demux(stream: Readable): Promise<DemuxedOutput> {
  const demuxer = createDemuxer();
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => demuxer.push(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return demuxer.result();
}

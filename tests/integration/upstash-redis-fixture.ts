import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile) as (
  file: string,
  args: readonly string[],
  options?: { maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface UpstashRedisFixture {
  /** Upstash REST base URL understood by `@upstash/redis`. */
  url: string;
  /** Port serving the Upstash-compatible HTTP surface. */
  port: number;
  /** Port of the real Redis process behind the fixture. */
  redisPort: number;
  redisVersion: string;
  close(): Promise<void>;
}

const READY_TIMEOUT_MS = 10_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function redisCli(port: number, args: readonly string[]) {
  return execFileAsync("redis-cli", ["-p", String(port), ...args], { maxBuffer: 16 * 1024 * 1024 });
}

async function waitForRedis(redisPort: number, child: ChildProcess, output: () => string) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let spawnError: Error | undefined;
  let exited = false;
  child.once("error", (error) => { spawnError = error; });
  child.once("exit", () => { exited = true; });
  let lastError = "";
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`redis-server could not start: ${spawnError.message}`);
    if (exited) throw new Error(`redis-server exited before becoming ready\n${output()}`);
    try {
      const { stdout } = await redisCli(redisPort, ["--raw", "PING"]);
      if (stdout.trim() === "PONG") return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(100);
  }
  throw new Error(`redis-server did not become ready within ${READY_TIMEOUT_MS}ms: ${lastError}\n${output()}`);
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  for (let i = 0; i < 20 && child.exitCode === null && child.signalCode === null; i++) await sleep(100);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

/**
 * Start a real Redis 7 process and expose the subset of the Upstash REST API
 * used by the quota ledger. `redis-cli --json` supplies the RESP-to-JSON
 * conversion, so EVAL arrays, MGET nulls and scalar replies keep their types.
 */
export async function startUpstashRedisFixture(): Promise<UpstashRedisFixture> {
  const redisPort = await freePort();
  const directory = await mkdtemp(path.join(tmpdir(), "free-router-quota-redis-"));
  const child = spawn("redis-server", [
    "--port", String(redisPort),
    "--bind", "127.0.0.1",
    "--save", "",
    "--appendonly", "no",
    "--dir", directory,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });

  let server: http.Server | undefined;
  try {
    await waitForRedis(redisPort, child, () => logs);
    const version = await redisCli(redisPort, ["--raw", "INFO", "server"]);
    const redisVersion = version.stdout.match(/redis_version:([^\r\n]+)/)?.[1] ?? "unknown";

    server = http.createServer(async (request, response) => {
      try {
        if (request.method !== "POST") throw new Error("fixture only accepts POST");
        let body = "";
        for await (const chunk of request) body += chunk;
        const payload = JSON.parse(body) as unknown;
        if (!Array.isArray(payload) || payload.length === 0) throw new Error("fixture expected a non-empty command array");

        const run = async (raw: unknown) => {
          if (!Array.isArray(raw) || raw.length === 0) throw new Error("fixture expected a command array");
          const command = raw.map((part) => String(part));
          try {
            const { stdout } = await execFileAsync(
              "redis-cli",
              ["-p", String(redisPort), "--json", ...command],
              { maxBuffer: 16 * 1024 * 1024 },
            );
            const text = stdout.trim();
            return { result: text ? JSON.parse(text) : null };
          } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) };
          }
        };

        const result = Array.isArray(payload[0])
          ? await Promise.all(payload.map(run))
          : await run(payload);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });

    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture did not bind a TCP port");

    return {
      url: `http://127.0.0.1:${address.port}`,
      port: address.port,
      redisPort,
      redisVersion,
      async close() {
        await new Promise<void>((resolve) => {
          if (!server || !server.listening) return resolve();
          server.close(() => resolve());
        });
        await stopChild(child);
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await new Promise<void>((resolve) => {
      if (!server || !server.listening) return resolve();
      server.close(() => resolve());
    });
    await stopChild(child);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

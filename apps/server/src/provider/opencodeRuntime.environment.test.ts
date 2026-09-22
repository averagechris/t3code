import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import {
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { describe, expect, it } from "vite-plus/test";

import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  OpenCodeRuntimeLive,
  openCodeApiVersionForVersion,
  parseOpenCodeCliVersion,
  parseServerUrlFromOutput,
  probeOpenCodeServer,
  resolveOpenCodeConfigContent,
  resolveOpenCodeServerPassword,
  verifyOpenCodeServerVersion,
} from "./opencodeRuntime.ts";

describe("OpenCode version and ready-line detection", () => {
  it("detects V1 and V2 CLI versions including build metadata", () => {
    expect(parseOpenCodeCliVersion("opencode 1.14.19")).toBe("1.14.19");
    expect(parseOpenCodeCliVersion("opencode2 v2.0.8+desktop.3")).toBe("2.0.8+desktop.3");
    expect(openCodeApiVersionForVersion("1.14.19")).toBe(1);
    expect(openCodeApiVersionForVersion("2.0.8+desktop.3")).toBe(2);
  });

  it("parses both server ready-line formats", () => {
    expect(parseServerUrlFromOutput("opencode server listening on http://127.0.0.1:1\n")).toBe(
      "http://127.0.0.1:1",
    );
    expect(parseServerUrlFromOutput("server listening on http://127.0.0.1:2\n")).toBe(
      "http://127.0.0.1:2",
    );
  });
});

describe("probeOpenCodeServer", () => {
  effectIt.effect("uses authenticated /api/info and enforces the OpenCode 2 minimum", () =>
    Effect.gen(function* () {
      let authorization: string | null = null;
      const result = yield* probeOpenCodeServer({
        baseUrl: "https://opencode.test",
        directory: "/workspace",
        serverPassword: "secret",
        v1Client: makeHealthClient(() => Promise.reject(new Error("v1 fallback must not run"))),
        fetch: Object.assign(
          async (_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
            authorization = new Headers(init?.headers).get("authorization");
            return Response.json({
              version: "2.0.8+desktop.1",
              pid: 1,
              urls: [],
              paths: { tmp: "/tmp" },
            });
          },
          { preconnect: () => undefined },
        ),
      });
      expect(result).toEqual({ version: "2.0.8+desktop.1", apiVersion: 2 });
      expect(authorization).toBe(`Basic ${Buffer.from("opencode:secret").toString("base64")}`);
    }),
  );

  effectIt.effect("reports a missing OpenCode 2 password precisely", () =>
    probeOpenCodeServer({
      baseUrl: "https://opencode.test",
      directory: "/workspace",
      v1Client: makeHealthClient(() => Promise.reject(new Error("v1 fallback must not run"))),
      fetch: Object.assign(async () => new Response(null, { status: 401 }), {
        preconnect: () => undefined,
      }),
    }).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => expect(error.detail).toContain("requires authentication (HTTP 401)")),
      ),
    ),
  );

  effectIt.effect("rejects an OpenCode 2 server below the minimum version", () =>
    probeOpenCodeServer({
      baseUrl: "https://opencode.test",
      directory: "/workspace",
      v1Client: makeHealthClient(() => Promise.reject(new Error("v1 fallback must not run"))),
      fetch: Object.assign(
        async () =>
          Response.json({ version: "2.0.7", pid: 1, urls: [], paths: { tmp: "/tmp" } }),
        { preconnect: () => undefined },
      ),
    }).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => expect(error.detail).toContain("OpenCode v2.0.7 is too old")),
      ),
    ),
  );

  effectIt.effect("does not mistake a starting OpenCode 2 server for OpenCode 1", () =>
    Effect.gen(function* () {
      let v1FallbackCalled = false;
      const error = yield* probeOpenCodeServer({
        baseUrl: "https://opencode.test",
        directory: "/workspace",
        v1Client: makeHealthClient(() => {
          v1FallbackCalled = true;
          return Promise.resolve({ data: { healthy: true, version: "1.14.19" } });
        }),
        fetch: Object.assign(async () => new Response(null, { status: 503 }), {
          preconnect: () => undefined,
        }),
      }).pipe(Effect.flip);

      expect(error.detail).toContain("not ready (HTTP 503)");
      expect(v1FallbackCalled).toBe(false);
    }),
  );

  effectIt.effect("falls back to OpenCode 1 only when /api/info is missing", () =>
    Effect.gen(function* () {
      const result = yield* probeOpenCodeServer({
        baseUrl: "https://opencode.test",
        directory: "/workspace",
        v1Client: makeHealthClient(() =>
          Promise.resolve({ data: { healthy: true, version: "1.14.19" } }),
        ),
        fetch: Object.assign(async () => new Response(null, { status: 404 }), {
          preconnect: () => undefined,
        }),
      });

      expect(result).toEqual({ version: "1.14.19", apiVersion: 1 });
    }),
  );
});

describe("resolveOpenCodeConfigContent", () => {
  it("prefers the caller environment over the inherited environment", () => {
    expect(
      resolveOpenCodeConfigContent(
        { OPENCODE_CONFIG_CONTENT: '{"source":"caller"}' },
        { OPENCODE_CONFIG_CONTENT: '{"source":"process"}' },
      ),
    ).toBe('{"source":"caller"}');
  });

  it("falls back to the inherited environment and then an empty config", () => {
    expect(
      resolveOpenCodeConfigContent(undefined, {
        OPENCODE_CONFIG_CONTENT: '{"source":"process"}',
      }),
    ).toBe('{"source":"process"}');
    expect(resolveOpenCodeConfigContent(undefined, {})).toBe("{}");
  });
});

describe("resolveOpenCodeServerPassword", () => {
  it("uses the local environment password when settings do not provide one", () => {
    expect(
      resolveOpenCodeServerPassword(
        { external: false, environment: { OPENCODE_SERVER_PASSWORD: " env password " } },
        {},
      ),
    ).toBe(" env password ");
  });

  it("uses the settings password for a local server", () => {
    expect(
      resolveOpenCodeServerPassword({ external: false, serverPassword: " settings password " }, {}),
    ).toBe(" settings password ");
  });

  it("uses the settings password when local settings and environment differ", () => {
    expect(
      resolveOpenCodeServerPassword(
        {
          external: false,
          serverPassword: "settings-password",
          environment: { OPENCODE_SERVER_PASSWORD: "environment-password" },
        },
        {},
      ),
    ).toBe("settings-password");
  });

  it("does not send an inherited local password to an external server", () => {
    expect(
      resolveOpenCodeServerPassword(
        { external: true, environment: { OPENCODE_SERVER_PASSWORD: "local-secret" } },
        { OPENCODE_SERVER_PASSWORD: "inherited-secret" },
      ),
    ).toBeUndefined();
  });
});

function makeHealthClient(
  result: (options?: { readonly signal?: AbortSignal }) => Promise<unknown>,
): OpencodeClient {
  return {
    global: {
      health: result,
    },
  } as unknown as OpencodeClient;
}

describe("verifyOpenCodeServerVersion", () => {
  effectIt.effect("accepts a supported server version", () =>
    Effect.gen(function* () {
      const version = yield* verifyOpenCodeServerVersion(
        makeHealthClient(() => Promise.resolve({ data: { healthy: true, version: "1.14.19" } })),
      );
      expect(version).toBe("1.14.19");
    }),
  );

  effectIt.effect("rejects a server below the supported version", () =>
    Effect.gen(function* () {
      const error = yield* verifyOpenCodeServerVersion(
        makeHealthClient(() => Promise.resolve({ data: { healthy: true, version: "1.14.18" } })),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(OpenCodeRuntimeError);
      expect(error.detail).toContain("v1.14.18 is too old");
    }),
  );

  for (const data of [
    { healthy: true },
    { healthy: true, version: "not-a-version" },
    { healthy: false, version: "1.14.19" },
  ]) {
    effectIt.effect(`rejects an invalid health response: ${JSON.stringify(data)}`, () =>
      Effect.gen(function* () {
        const error = yield* verifyOpenCodeServerVersion(
          makeHealthClient(() => Promise.resolve({ data })),
        ).pipe(Effect.flip);
        expect(error).toBeInstanceOf(OpenCodeRuntimeError);
        expect(error.detail).toContain("requires OpenCode v1.14.19 or newer");
      }),
    );
  }

  effectIt.effect("preserves an unauthorized health error", () =>
    Effect.gen(function* () {
      const error = yield* verifyOpenCodeServerVersion(
        makeHealthClient(() =>
          Promise.reject({ response: { status: 401 }, error: { message: "Unauthorized" } }),
        ),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(OpenCodeRuntimeError);
      expect(error.detail).toContain("status=401");
      expect(error.detail).toContain("Unauthorized");
    }),
  );

  effectIt.effect("aborts a health request when the version check times out", () =>
    Effect.gen(function* () {
      let requestSignal: AbortSignal | undefined;
      const checkFiber = yield* verifyOpenCodeServerVersion(
        makeHealthClient((options) => {
          requestSignal = options?.signal;
          return new Promise(() => undefined);
        }),
      ).pipe(Effect.flip, Effect.forkChild);

      yield* Effect.yieldNow;
      expect(requestSignal).toBeDefined();
      yield* TestClock.adjust("6 seconds");

      const error = yield* Fiber.join(checkFiber);
      expect(error.detail).toBe("Timed out while checking the OpenCode server version.");
      expect(requestSignal?.aborted).toBe(true);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

describe("OpenCode server output", () => {
  effectIt.live(
    "drains stdout and stderr after startup so server requests can finish",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const environment = yield* HostProcessEnvironment;
        const executablePath = yield* HostProcessExecutablePath;
        const platform = yield* HostProcessPlatform;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-output-" });
        const isWindows = platform === "win32";
        const binaryPath = path.join(tempDir, isWindows ? "opencode.cmd" : "opencode");
        const scriptPath = path.join(tempDir, "opencode.mjs");

        yield* fs.writeFileString(
          scriptPath,
          `import { createServer } from "node:http";
const writeOutput = (stream) => new Promise((resolve, reject) => {
  stream.write("x".repeat(2 * 1024 * 1024), (error) => error ? reject(error) : resolve());
});
const server = createServer(async (request, response) => {
  if (request.url.startsWith("/api/info")) {
    response.statusCode = 404;
    response.end();
    return;
  }
  if (request.url.startsWith("/global/health")) {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ healthy: true, version: "1.14.19" }));
    return;
  }
  await Promise.all([writeOutput(process.stdout), writeOutput(process.stderr)]);
  response.end("drained");
});
if (process.argv.includes("--version")) {
  process.stdout.write("opencode 1.14.19\\n");
  process.exit(0);
}
server.listen(0, "127.0.0.1", () => {
  process.stdout.write("opencode server listening on http://127.0.0.1:" + server.address().port + "\\n");
});
`,
        );
        yield* fs.writeFileString(
          binaryPath,
          [
            ...(isWindows ? ["@echo off"] : ["#!/bin/sh"]),
            isWindows
              ? '"%T3_TEST_NODE_BINARY%" "%T3_TEST_OPENCODE_SCRIPT%" %*'
              : 'exec "$T3_TEST_NODE_BINARY" "$T3_TEST_OPENCODE_SCRIPT" "$@"',
            "",
          ].join("\n"),
        );
        if (!isWindows) {
          yield* fs.chmod(binaryPath, 0o755);
        }

        const runtime = yield* OpenCodeRuntime;
        const server = yield* runtime.startOpenCodeServerProcess({
          binaryPath,
          directory: tempDir,
          port: 0,
          environment: {
            ...environment,
            T3_TEST_NODE_BINARY: executablePath,
            T3_TEST_OPENCODE_SCRIPT: scriptPath,
          },
        });
        const response = yield* HttpClient.get(`${server.url}/output`);

        expect(yield* response.text).toBe("drained");
        expect(yield* server.isRunning).toBe(true);
      }).pipe(
        Effect.scoped,
        Effect.provide([
          OpenCodeRuntimeLive.pipe(Layer.provideMerge(NodeServices.layer)),
          FetchHttpClient.layer,
        ]),
      ),
    10_000,
  );
});

import http from "node:http";
import type { ServerType } from "@hono/node-server";
import { afterAll, beforeAll, expect, it, describe } from "vitest";
import { networkInterfaces } from "node:os";
import { serve } from "@hono/node-server";
import {
  startTestServer,
  type RunningTestServer,
} from "../helpers/test-app.js";

/**
 * A4 deployment test (audit CR-1 Phase 0; spec requirement A4).
 *
 * Binds a real listener on a non-loopback interface — the configuration that
 * requires BB_SERVER_ALLOW_NON_LOOPBACK=1 in production — and asserts that
 * every critical operation rejects an unauthenticated caller arriving over
 * that interface: host enumeration, file read, and terminal creation. The
 * client socket is bound to the same non-loopback address so the request
 * traverses the external interface rather than loopback.
 *
 * If the environment refuses a non-loopback bind (execution sandbox, macOS
 * firewall prompt pending, no non-loopback interface), the suite skips with
 * an explicit logged reason instead of failing — the unauthenticated-rejection
 * boundary itself is covered interface-agnostically by
 * public-api-capability.test.ts. CI environments permit the bind and exercise
 * this file fully.
 */

let harness: RunningTestServer | null = null;
let externalServer: ServerType | null = null;
let externalPort = 0;
let skipReason: string | null = null;

const detectedAddress = nonLoopbackLocalAddress();
const bindAddress = detectedAddress ?? "0.0.0.0";
const hasExternalInterface = detectedAddress !== null;

function nonLoopbackLocalAddress(): string | null {
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const entry of interfaces ?? []) {
      if (entry.family !== "IPv4" || entry.internal) {
        continue;
      }
      return entry.address;
    }
  }
  return null;
}

async function requestStatus(
  args: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
  } = { path: "/api/v1/threads" },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        localAddress: bindAddress,
        hostname: bindAddress,
        port: externalPort,
        path: args.path,
        method: args.method ?? "GET",
        setHost: false,
        headers: { host: `${bindAddress}:${externalPort}`, ...args.headers },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on("error", (error) => reject(error));
    request.end();
  });
}

beforeAll(async () => {
  if (!hasExternalInterface) {
    skipReason = "no non-loopback IPv4 interface available";
    return;
  }
  harness = await startTestServer({ requirePublicApiCapability: true });
  // createApp returns injectWebSocket; the harness does not expose it.
  const { createApp } = await import("../../src/server.js");
  const { app, injectWebSocket } = createApp(harness.deps);
  let bindError: Error | null = null;
  const server = serve(
    {
      hostname: bindAddress,
      port: 0,
      fetch: app.fetch,
    },
    (info) => {
      externalPort = info.port;
    },
  );
  server.on("error", (error) => {
    bindError = error;
  });
  injectWebSocket(server);
  externalServer = server;

  const deadline = Date.now() + 10_000;
  while (externalPort === 0 && bindError === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const bindFailure = bindError as Error | null;
  if (bindFailure !== null) {
    skipReason = `non-loopback bind refused by environment: ${bindFailure.message}`;
    return;
  }
  if (externalPort === 0) {
    skipReason =
      "non-loopback bind did not complete in 10s (sandbox or pending macOS firewall approval)";
  }
});

describe.skipIf(skipReason !== null)(
  "unauthenticated non-loopback peer is rejected (A4)",
  () => {
    it("binds a real non-loopback listener with the override and rejects host enumeration", async () => {
      const status = await requestStatus({ path: "/api/v1/hosts" });
      expect(status).toBe(401);
    });

    it("rejects unauthenticated file read", async () => {
      const status = await requestStatus({
        method: "POST",
        path: "/api/v1/files/read",
      });
      expect(status).toBe(401);
    });

    it("rejects unauthenticated terminal creation", async () => {
      const status = await requestStatus({
        method: "POST",
        path: "/api/v1/terminals",
      });
      expect(status).toBe(401);
    });

    it("rejects unauthenticated host enumeration", async () => {
      const status = await requestStatus({ path: "/api/v1/hosts" });
      expect(status).toBe(401);
    });

    it("ignores forged forwarded headers from the non-loopback peer (TG2.2)", async () => {
      // A dedicated flag-off harness isolates the origin layer: a LAN peer
      // forges both a trusted origin and a matching X-Forwarded-Host.
      // Pre-TG2.2 this passed the origin check; now forwarded headers from
      // an untrusted peer are ignored and the origin middleware 403s.
      const originHarness = await startTestServer({
        requirePublicApiCapability: false,
      });
      let forgedPort = 0;
      try {
        const { createApp } = await import("../../src/server.js");
        const { app } = createApp(originHarness.deps);
        const forgedServer = serve(
          {
            hostname: bindAddress,
            port: 0,
            fetch: app.fetch,
          },
          (info) => {
            forgedPort = info.port;
          },
        );
        try {
          const deadline = Date.now() + 10_000;
          while (forgedPort === 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }

          // The forwarded-host target is only trusted when it arrives from
          // a trusted proxy peer. A non-loopback peer claiming a dev-app
          // origin via X-Forwarded-Host must not have that claim honored:
          // pre-TG2.2 this request passed the origin check (the forwarded
          // target matched the forged origin); now it 403s.
          const forged = await fetch(
            new URL("/api/v1/threads", `http://${bindAddress}:${forgedPort}`),
            {
              headers: {
                origin: "http://100.64.158.8:5173",
                "x-forwarded-host": "100.64.158.8:5173",
              },
            },
          );
          await forged.text();
          expect(forged.status).toBe(403);
        } finally {
          await new Promise<void>((resolve) => {
            forgedServer.close(() => resolve());
          });
        }
      } finally {
        await originHarness.close();
      }
    }, 30_000);

    it("gates the former bootstrap path for the non-loopback peer", async () => {
      // No issuance route exists; the gate 401s the path before any fallback.
      const status = await requestStatus({
        path: "/api/v1/system/capability-bootstrap",
      });
      expect(status).toBe(401);
    });
  },
);

afterAll(async () => {
  await new Promise<void>((resolve) => {
    if (externalServer === null) {
      resolve();
      return;
    }
    externalServer.close(() => resolve());
  });
  await harness?.close();
  harness = null;
  externalServer = null;
  if (skipReason !== null) {
    // Keep the skip auditable rather than silent.
    console.warn(`A4 deployment test skipped: ${skipReason}`);
  }
});

import http from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostDaemonServerWsMessage } from "@bb/host-daemon-contract";
import type {
  TerminalSessionWithCapability,
  TerminalCapability,
} from "@bb/server-contract";
import { terminalSessions } from "@bb/db";
import {
  createTestAppHarness,
  type TestAppHarness,
  type TestAppHarnessConfigOverrides,
} from "../helpers/test-app.js";
import { PUBLIC_API_CAPABILITY_FILE_NAME } from "../../src/services/public-api-capability.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";

/**
 * TG3 (HI-1): terminal capabilities. Creation issues a short-lifetime
 * credential bound to that terminal; every mutation and the WS upgrade
 * require it. SP-5 properties live in terminal-capability.property.test.ts.
 */

interface FakeDaemonSocket {
  close(code?: number, reason?: string): void;
  send(data: string): void;
  sentMessages: string[];
}

interface TerminalFixture {
  acknowledgedOpens: number;
  harness: TestAppHarness;
  hostId: string;
  sessionId: string;
  socket: FakeDaemonSocket;
}

function createFakeDaemonSocket(
  onMessage?: (message: HostDaemonServerWsMessage) => void,
): FakeDaemonSocket {
  const sentMessages: string[] = [];
  return {
    close: vi.fn(() => {}),
    send: vi.fn((data: string) => {
      sentMessages.push(data);
      const message = JSON.parse(data) as HostDaemonServerWsMessage;
      onMessage?.(message);
    }),
    sentMessages,
  };
}

async function createTerminalFixture(
  overrides: TestAppHarnessConfigOverrides = {},
): Promise<TerminalFixture> {
  const harness = await createTestAppHarness(overrides);
  const seeded = seedHostSession(harness.deps, { id: "terminal-host" });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: seeded.host.id,
    path: "/tmp/terminal-project",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: seeded.host.id,
    path: "/tmp/terminal-workspace",
    projectId: project.id,
    status: "ready",
  });
  seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    status: "idle",
  });
  const socket = createFakeDaemonSocket((message) => {
    // A real daemon settles close RPCs with terminal.exited; the fake does
    // the same so the close route completes instead of timing out.
    if (message.type === "terminal.close") {
      harness.deps.terminalSessions.handleDaemonTerminalMessage({
        hostId: seeded.host.id,
        sessionId: seeded.session.id,
        message: {
          type: "terminal.exited",
          terminalId: message.terminalId,
          exitCode: null,
          closeReason: "user",
        },
      });
    }
  });
  harness.hub.registerDaemon(seeded.session.id, seeded.host.id, socket);
  return {
    acknowledgedOpens: 0,
    harness,
    hostId: seeded.host.id,
    sessionId: seeded.session.id,
    socket,
  };
}

async function waitForTerminalOpen(
  fixture: TerminalFixture,
): Promise<HostDaemonServerWsMessage> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const opens = fixture.socket.sentMessages
      .map((raw) => JSON.parse(raw) as HostDaemonServerWsMessage)
      .filter((message) => message.type === "terminal.open");
    const message = opens[fixture.acknowledgedOpens];
    if (message !== undefined) {
      fixture.acknowledgedOpens += 1;
      return message;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for terminal.open");
}

async function createStandaloneTerminal(
  fixture: TerminalFixture,
  options: { installCapability?: string } = {},
): Promise<TerminalSessionWithCapability> {
  const pending = Promise.resolve(
    fixture.harness.app.request("/api/v1/terminals", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.installCapability === undefined
          ? {}
          : { "x-bb-capability": options.installCapability }),
      },
      body: JSON.stringify({
        cols: 100,
        rows: 30,
        target: {
          kind: "host_path",
          hostId: fixture.hostId,
          cwd: "/tmp/standalone-terminal",
        },
      }),
    }),
  );
  const openMessage = await waitForTerminalOpen(fixture);
  if (openMessage.type !== "terminal.open") {
    throw new Error(`Expected terminal.open, received ${openMessage.type}`);
  }
  fixture.harness.deps.terminalSessions.handleDaemonTerminalMessage({
    hostId: fixture.hostId,
    sessionId: fixture.sessionId,
    message: {
      type: "terminal.opened",
      requestId: openMessage.requestId,
      terminalId: openMessage.terminalId,
      shell: "/bin/zsh",
      title: "zsh",
      initialCwd: "/tmp/terminal-cwd",
      cols: 100,
      rows: 30,
    },
  });
  const response = await pending;
  expect(
    response.status,
    `create failed: ${await response.clone().text()}`,
  ).toBe(201);
  return (await response.json()) as TerminalSessionWithCapability;
}

async function inputStatus(
  harness: TestAppHarness,
  terminalId: string,
  headers: Record<string, string> = {},
): Promise<number> {
  const response = await harness.app.request(
    `/api/v1/terminals/${terminalId}/input`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        dataBase64: Buffer.from("echo hi\n").toString("base64"),
      }),
    },
  );
  await response.text();
  return response.status;
}

describe("terminal capability enforcement (TG3)", () => {
  let fixture: TerminalFixture | null = null;

  afterEach(async () => {
    for (const external of externalServers.splice(0)) {
      await new Promise<void>((resolve) => {
        external.close(() => resolve());
      });
    }
    await fixture?.harness.cleanup();
    fixture = null;
  });

  it("issues a short-lifetime capability at creation", async () => {
    fixture = await createTerminalFixture();
    const session = await createStandaloneTerminal(fixture);
    const capability: TerminalCapability = session.capability;
    expect(capability.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(capability.expiresAt).toBeGreaterThan(Date.now());
  });

  it("requires the capability for mutations and admits the issued token", async () => {
    fixture = await createTerminalFixture();
    const session = await createStandaloneTerminal(fixture);

    const denied = await inputStatus(fixture.harness, session.id);
    expect(denied).toBe(401);

    const allowed = await inputStatus(fixture.harness, session.id, {
      "x-bb-terminal-capability": session.capability.token,
    });
    expect(allowed).toBe(200);

    // The daemon received the input: the credential did not merely satisfy
    // an error path, it authorized the real operation.
    const daemonInputs = fixture.socket.sentMessages
      .map((raw) => JSON.parse(raw) as HostDaemonServerWsMessage)
      .filter((message) => message.type === "terminal.input");
    expect(daemonInputs.length).toBeGreaterThan(0);
  });

  it("binds the credential to its own terminal (cross-terminal rejection)", async () => {
    fixture = await createTerminalFixture();
    const first = await createStandaloneTerminal(fixture);
    const second = await createStandaloneTerminal(fixture);

    const cross = await inputStatus(fixture.harness, second.id, {
      "x-bb-terminal-capability": first.capability.token,
    });
    expect(cross).toBe(401);

    // The same token still works on its own terminal.
    const own = await inputStatus(fixture.harness, first.id, {
      "x-bb-terminal-capability": first.capability.token,
    });
    expect(own).toBe(200);
  });

  it("an authenticated request denied by per-resource authorization performs no side effect (SP-1 / A3; TG2.7)", async () => {
    // The catalog's SP-1 gate battery can only ever exercise the
    // authentication boundary: every member of it dies at the root capability
    // gate before any handler runs, so "no DB writes" holds there by
    // construction. This covers the quadrant the audit's A3 actually names —
    // a request that IS authenticated (valid install capability, root gate
    // passed, handler entered) yet is denied by per-resource authorization
    // (a terminal capability issued for a different terminal).
    fixture = await createTerminalFixture({
      requirePublicApiCapability: true,
    });
    const installToken = (
      await readFile(
        join(fixture.harness.config.dataDir, PUBLIC_API_CAPABILITY_FILE_NAME),
        "utf8",
      )
    ).trim();

    const pool: TerminalSessionWithCapability[] = [];
    for (let i = 0; i < 3; i += 1) {
      pool.push(
        await createStandaloneTerminal(fixture, {
          installCapability: installToken,
        }),
      );
    }

    // Local captures keep the non-null narrowing across the closures below
    // (fixture is a let that later tests may reassign).
    const harness = fixture.harness;
    const socket = fixture.socket;

    // Proves the handler was entered: a root-gate rejection, a 404, or a
    // never-routed request cannot satisfy it, so the zero-side-effect
    // assertions below cannot pass vacuously.
    const requireSpy = vi.spyOn(
      harness.deps.terminalSessions,
      "requireTerminalCapability",
    );

    const snapshot = () =>
      JSON.stringify(harness.db.select().from(terminalSessions).all());
    const before = snapshot();

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: pool.length - 1 }),
        fc.integer({ min: 0, max: pool.length - 1 }),
        async (targetIndex, foreignIndex) => {
          fc.pre(targetIndex !== foreignIndex);
          const target = pool[targetIndex];
          const foreign = pool[foreignIndex];

          const denied = await harness.app.request(
            `/api/v1/terminals/${target.id}/input`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-bb-capability": installToken,
                "x-bb-terminal-capability": foreign.capability.token,
              },
              body: JSON.stringify({
                dataBase64: Buffer.from("echo hi\n").toString("base64"),
              }),
            },
          );
          expect(denied.status).toBe(401);
          // The handler ran and reached the per-resource check for this exact
          // terminal with this exact presented credential.
          expect(requireSpy.mock.calls.at(-1)).toEqual([
            target.id,
            foreign.capability.token,
          ]);
        },
      ),
      { numRuns: 12 },
    );

    // Zero DB writes across the whole denied battery...
    expect(snapshot()).toBe(before);
    // ...and zero PTY effects: the daemon never received any input.
    expect(
      socket.sentMessages.filter(
        (raw) =>
          (JSON.parse(raw) as HostDaemonServerWsMessage).type ===
          "terminal.input",
      ),
    ).toHaveLength(0);
  });

  it("re-issues the same token on authenticated reads", async () => {
    fixture = await createTerminalFixture();
    const session = await createStandaloneTerminal(fixture);
    const read = await fixture.harness.app.request(
      `/api/v1/terminals/${session.id}`,
    );
    expect(read.status).toBe(200);
    const body = (await read.json()) as TerminalSessionWithCapability;
    expect(body.capability.token).toBe(session.capability.token);
  });

  it("revokes the capability when the terminal closes", async () => {
    fixture = await createTerminalFixture();
    const session = await createStandaloneTerminal(fixture);
    const closed = await fixture.harness.app.request(
      `/api/v1/terminals/${session.id}/close`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bb-terminal-capability": session.capability.token,
        },
        body: JSON.stringify({ mode: "force", reason: "user" }),
      },
    );
    expect(closed.status).toBe(200);
    const afterClose = await inputStatus(fixture.harness, session.id, {
      "x-bb-terminal-capability": session.capability.token,
    });
    expect(afterClose).toBe(401);
  });

  it("refuses the WebSocket upgrade without the terminal token", async () => {
    fixture = await createTerminalFixture();
    const session = await createStandaloneTerminal(fixture);

    // The same lifecycle must serve both the HTTP route and the WS upgrade:
    // create an external server over the fixture's deps.
    const { createApp } = await import("../../src/server.js");
    const { app, injectWebSocket } = createApp(fixture.harness.deps);
    const external = (await import("@hono/node-server")).serve(
      {
        hostname: "127.0.0.1",
        port: 0,
        fetch: app.fetch,
      },
      (info) => {
        externalPort = info.port;
      },
    );
    injectWebSocket(external);
    externalServers.push(external);
    const deadline = Date.now() + 10_000;
    while (externalPort === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const denied = await upgradeStatus("127.0.0.1", session.id, {});
    expect(denied).toBe(401);

    const authorized = await upgradeStatus("127.0.0.1", session.id, {
      "x-bb-terminal-capability": session.capability.token,
    });
    expect(authorized).toBe(101);
  });
});

let externalPort = 0;
const externalServers: Array<{ close(callback: () => void): void }> = [];

async function upgradeStatus(
  hostname: string,
  terminalId: string,
  extraHeaders: Record<string, string>,
): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname,
        port: externalPort,
        path: `/ws/terminals/${terminalId}`,
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-version": "13",
          ...extraHeaders,
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on("upgrade", () => {
      request.destroy();
      resolve(101);
    });
    request.on("error", (error) => reject(error));
    request.end();
  });
}

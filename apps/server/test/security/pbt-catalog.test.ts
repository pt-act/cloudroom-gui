import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isLoopbackHostname,
  nonLoopbackBindRefusal,
} from "@bb/config/loopback";
import { PUBLIC_API_CAPABILITY_FILE_NAME } from "../../src/services/public-api-capability.js";
import { ApiError } from "../../src/errors.js";
import { containAbsolutePathWithinRoots } from "../../src/routes/host-path-containment.js";
import { pluginWireAuthProblem } from "../../src/routes/plugin-wire-auth.js";
import { withTestHarness } from "../helpers/test-app.js";

/**
 * Property-based test catalog for the audit-remediation program
 * (.agents/specs/audit-remediation/spec.md §Security Properties).
 *
 * Each skipped group below activates (skip removed, real property written)
 * as its owning task group lands; the skip label names the activating tasks
 * and the findings the property guards. Traceability matrix lives in
 * .agents/specs/audit-remediation/tasks.md (TG0.5).
 */

describe("SP-1 access control — capability gate (CR-1, HI-1; TG1.8)", () => {
  it("rejects every uncredentialed or wrong-credential request with 401 and admits exactly the per-install token", async () => {
    await withTestHarness(
      { requirePublicApiCapability: true },
      async (harness) => {
        const token = (
          await readFile(
            join(harness.config.dataDir, PUBLIC_API_CAPABILITY_FILE_NAME),
            "utf8",
          )
        ).trim();

        await fc.assert(
          fc.asyncProperty(
            fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
            fc.constantFrom("x-bb-capability", "authorization"),
            async (wrongToken, channel) => {
              const headers: Record<string, string> =
                channel === "x-bb-capability"
                  ? { "x-bb-capability": wrongToken ?? "" }
                  : { authorization: `Bearer ${wrongToken ?? ""}` };
              const response = await harness.app.request("/api/v1/threads", {
                headers,
              });
              expect(response.status).toBe(401);
            },
          ),
          { numRuns: 30 },
        );

        const headerAllowed = await harness.app.request("/api/v1/threads", {
          headers: { "x-bb-capability": token },
        });
        expect(headerAllowed.status).toBe(200);
        const bearerAllowed = await harness.app.request("/api/v1/threads", {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(bearerAllowed.status).toBe(200);
      },
    );
  });
  it.todo(
    "SP-1 residual (TG2.7): denied requests cause zero side effects — no file reads, PTY spawns, or DB writes (deployment-test scope)",
  );
});

describe("SP-1 credential extraction (TG1.9)", () => {
  it("never authenticates a fabricated credential in either channel", async () => {
    await withTestHarness(
      { requirePublicApiCapability: true },
      async (harness) => {
        const token = (
          await readFile(
            join(harness.config.dataDir, PUBLIC_API_CAPABILITY_FILE_NAME),
            "utf8",
          )
        ).trim();

        await fc.assert(
          fc.asyncProperty(
            fc.string({ minLength: 1, maxLength: 64 }),
            fc.constantFrom("header", "bearer"),
            async (fabricated, channel) => {
              // The token is 43-char base64url, so arbitrary strings are
              // vanishingly unlikely to collide; assert the invariant.
              expect(fabricated).not.toBe(token);

              const headers: Record<string, string> =
                channel === "header"
                  ? { "x-bb-capability": fabricated }
                  : { authorization: `Bearer ${fabricated}` };
              const response = await harness.app.request("/api/v1/threads", {
                headers,
              });
              expect(response.status).toBe(401);
            },
          ),
          { numRuns: 50 },
        );

        // Positive control: the real token authenticates in both channels.
        expect(
          (
            await harness.app.request("/api/v1/threads", {
              headers: { "x-bb-capability": token },
            })
          ).status,
        ).toBe(200);
        expect(
          (
            await harness.app.request("/api/v1/threads", {
              headers: { authorization: `Bearer ${token}` },
            })
          ).status,
        ).toBe(200);
      },
    );
  });
});

describe("SP-2 path containment (HI-2; TG4.7)", () => {
  it("resolves every absolute target inside a canonical registered root or rejects it", () => {
    // Exhaustive 500-run property plus endpoint-level dispatch checks live
    // in raw-file-containment.property.test.ts; this catalog entry keeps a
    // compact property so the catalog itself reflects that SP-2 is active.
    const roots = ["/tmp/worktree", "/tmp/storage"];
    const target = fc.oneof(
      fc
        .tuple(
          fc.constantFrom(...roots),
          fc.stringMatching(/^[a-z0-9_-]{1,8}$/),
        )
        .map(([root, name]) => `${root}/${name}/report.html`),
      fc
        .tuple(
          fc.constantFrom(...roots),
          fc.stringMatching(/^[a-z0-9_-]{1,8}$/),
        )
        .map(([root, name]) => `${root}/../${name}.html`),
      fc
        .tuple(
          fc.stringMatching(/^[a-z0-9_-]{1,8}$/),
          fc.stringMatching(/^[a-z0-9_-]{1,8}$/),
        )
        .map(([a, b]) => `/etc/${a}/${b}.html`),
      fc.constantFrom(
        "C:\\Users\\x\\report.html",
        "\\\\server\\share\\report.html",
      ),
    );
    fc.assert(
      fc.property(target, (rawTarget) => {
        let admitted: { rootPath: string; path: string } | null = null;
        try {
          admitted = containAbsolutePathWithinRoots({
            rawPath: rawTarget,
            roots,
          });
        } catch (error) {
          expect(error).toBeInstanceOf(ApiError);
          expect((error as ApiError).status).toBe(400);
        }
        if (admitted !== null) {
          expect(roots).toContain(admitted.rootPath);
          expect(admitted.path.startsWith(`${admitted.rootPath}/`)).toBe(true);
          expect(admitted.path).not.toContain("..");
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe("SP-3 credential placement (ME-1; TG5.6 — ME-5 half activates with TG6.5)", () => {
  it("rejects query-string plugin credentials and honors header-only tokens", () => {
    // Exhaustive 200-run property plus the real-route matrix live in
    // plugin-credential-placement.property.test.ts and plugin-wire.test.ts;
    // this catalog entry keeps a compact property so the catalog reflects
    // that the ME-1 half of SP-3 is active.
    const token = "catalog-wire-token-0123456789abcdef";
    const deps = { config: { serverPort: 3000 } };
    const plugins = { httpToken: async () => token };
    const channel = fc.constantFrom<
      "x-bb-plugin-token" | "authorization" | "query"
    >("x-bb-plugin-token", "authorization", "query");
    fc.assert(
      fc.asyncProperty(
        channel,
        fc.boolean(),
        fc.constantFrom("Bearer ", "bearer ", "Basic ", "Bearer"),
        async (channel, correct, bearerPrefix) => {
          const presented = correct ? token : "wrong-token-value";
          const headers: Record<string, string> = {};
          if (channel === "x-bb-plugin-token") {
            headers["x-bb-plugin-token"] = presented;
          }
          if (channel === "authorization") {
            headers.authorization = `${bearerPrefix}${presented}`;
          }
          const url = new URL("http://localhost:3000/api/v1/plugins/p/http/x");
          if (channel === "query") {
            url.searchParams.set("token", presented);
          }
          const problem = await pluginWireAuthProblem({
            context: {
              req: {
                url: url.toString(),
                method: "GET",
                header: (name: string) => headers[name.toLowerCase()],
              },
            },
            deps,
            plugins,
            pluginId: "p",
            auth: "token",
            capability: null,
          });
          const authenticates =
            correct &&
            (channel === "x-bb-plugin-token" ||
              (channel === "authorization" &&
                (bearerPrefix === "Bearer " || bearerPrefix === "bearer ")));
          if (authenticates) {
            expect(problem).toBeNull();
          } else {
            expect(problem).toMatchObject({ status: 401 });
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe.skip("SP-4 state integrity and idempotency (HI-3, ME-2, ME-3 — activates with TG8.8, TG9.7)", () => {
  it.todo(
    "same idempotency key applied twice → provider effect exactly once; title and search segments never diverge; pin and section never partially commit",
  );
});

describe.skip("SP-5 capability security (HI-1 — activates with TG3.7)", () => {
  it.todo(
    "expired, wrong-owner, or wrong-target capability → every terminal REST/WS mutation rejected",
  );
});

describe("PBT harness smoke (TG0.2)", () => {
  it("bind-refusal gate admits exactly the loopback-or-explicitly-allowed binds", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "127.0.0.1",
          "localhost",
          "[::1]",
          "0:0:0:0:0:0:0:1",
          "0.0.0.0",
          "192.168.1.50",
          "example.test",
          "::ffff:192.168.1.50",
        ),
        fc.boolean(),
        (bindHost, allowUnauthenticatedRemote) => {
          const refusal = nonLoopbackBindRefusal({
            bindHost,
            allowUnauthenticatedRemote,
          });
          if (isLoopbackHostname(bindHost) || allowUnauthenticatedRemote) {
            expect(refusal).toBeNull();
          } else {
            expect(refusal).toContain(bindHost);
            expect(refusal).toContain("BB_SERVER_ALLOW_NON_LOOPBACK");
          }
        },
      ),
    );
  });
});

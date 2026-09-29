import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { pluginWireAuthProblem } from "../../src/routes/plugin-wire-auth.js";

/**
 * SP-3, ME-1 half (TG5.1/5.6): plugin HTTP credentials are honored only in
 * headers. Property: for every credential placement, the query-string
 * location is ALWAYS rejected — even when it carries the exact correct
 * token — because query credentials leak through access logs, proxies,
 * browser history, referrers, and screenshots. Header placements
 * (`x-bb-plugin-token`, `Authorization: Bearer`) authenticate exactly when
 * the presented token is the plugin's own token.
 *
 * Written property-first: against the pre-TG5 guard this fails immediately,
 * because `?token=<correct>` authenticated (the ME-1 defect). The
 * header-placement legs double as the 5.1 authorization-channel matrix.
 */

const CORRECT_TOKEN = "wire-token-0123456789abcdef";
const WRONG_TOKEN = "wire-token-fedcba9876543210";
const PLUGIN_ID = "wire-plugin";

const deps = { config: { serverPort: 3000 } };
const plugins = {
  httpToken: async () => CORRECT_TOKEN,
};

type Channel = "x-bb-plugin-token" | "authorization" | "query" | "none";

interface Placement {
  channel: Channel;
  correct: boolean;
  queryName: string;
  bearerPrefix: string;
  extraParam: string;
}

const placementArb = fc.record({
  channel: fc.constantFrom<Channel>(
    "x-bb-plugin-token",
    "authorization",
    "query",
    "none",
  ),
  correct: fc.boolean(),
  queryName: fc.constantFrom("token", "Token", "TOKEN", "auth_token"),
  // Prefix concatenated directly to the token: the space-terminated forms
  // are well-formed "Bearer <token>" headers; the others are the malformed
  // values the guard must reject (wrong scheme, glued scheme, bare token).
  bearerPrefix: fc.constantFrom("Bearer ", "bearer ", "Basic ", "Bearer"),
  extraParam: fc.stringMatching(/^[a-z_]{1,8}$/),
});

function wellFormedBearerHeader(placement: Placement): boolean {
  return (
    placement.bearerPrefix === "Bearer " || placement.bearerPrefix === "bearer "
  );
}

function fabricatedContext(placement: Placement) {
  const token = placement.correct ? CORRECT_TOKEN : WRONG_TOKEN;
  const headers: Record<string, string> = {};
  if (placement.channel === "x-bb-plugin-token") {
    headers["x-bb-plugin-token"] = token;
  }
  if (placement.channel === "authorization") {
    headers.authorization = `${placement.bearerPrefix}${token}`;
  }
  const query: Record<string, string> = {
    [placement.extraParam]: "decoy",
  };
  if (placement.channel === "query") {
    query[placement.queryName] = token;
  }
  const url = new URL(
    `http://localhost:3000/api/v1/plugins/${PLUGIN_ID}/http/resource`,
  );
  for (const [name, value] of Object.entries(query)) {
    url.searchParams.set(name, value);
  }
  return {
    req: {
      url: url.toString(),
      method: "GET",
      header: (name: string) => headers[name.toLowerCase()],
      query: (name: string) => url.searchParams.get(name) ?? undefined,
    },
  };
}

async function problemFor(
  placement: Placement,
): Promise<{ status: number; error: string } | null> {
  const problem = await pluginWireAuthProblem({
    context: fabricatedContext(placement),
    deps,
    plugins,
    pluginId: PLUGIN_ID,
    auth: "token",
    capability: null,
  });
  return problem;
}

describe("SP-3 credential placement (ME-1; TG5.1/5.6)", () => {
  it("rejects every query-string credential placement and honors header-only tokens", async () => {
    await fc.assert(
      fc.asyncProperty(placementArb, async (placement) => {
        const problem = await problemFor(placement);
        if (placement.channel === "query") {
          // The ME-1 property: the query location never authenticates, not
          // even with the exact correct token.
          expect(problem, "query credential must be rejected").toMatchObject({
            status: 401,
          });
          return;
        }
        const authenticates =
          placement.correct &&
          (placement.channel === "x-bb-plugin-token" ||
            (placement.channel === "authorization" &&
              wellFormedBearerHeader(placement)));
        if (authenticates) {
          expect(
            problem,
            `correct token via ${placement.channel} must authenticate`,
          ).toBeNull();
        } else {
          expect(
            problem,
            `unusable credential via ${placement.channel} must be rejected`,
          ).toMatchObject({ status: 401 });
        }
      }),
      { numRuns: 200 },
    );
  });

  it("never echoes the presented credential in the rejection message", async () => {
    await fc.assert(
      fc.asyncProperty(placementArb, async (placement) => {
        const problem = await problemFor(placement);
        if (problem === null) {
          return;
        }
        expect(problem.error).not.toContain(CORRECT_TOKEN);
        expect(problem.error).not.toContain(WRONG_TOKEN);
      }),
      { numRuns: 100 },
    );
  });
});

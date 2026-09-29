import { timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import type { PluginHttpAuthMode } from "@get-bb/plugin-sdk";
import {
  browserRequestProblem,
  type BrowserRequestProblem,
} from "../browser-request-guard.js";
import {
  presentedCapability,
  type PublicApiCapabilityService,
} from "../services/public-api-capability.js";

export type WireAuthProblem =
  | BrowserRequestProblem
  | { status: 401; error: string };

type TokenReader = (name: string) => string | undefined;

interface WireAuthContext {
  req: {
    url: string;
    method: string;
    header: TokenReader;
  };
}

interface PluginWireAuthDeps {
  config: {
    serverPort: number;
    appUrl?: string;
    devAppPort?: number;
    trustedProxies?: readonly string[];
  };
}

interface PluginWireTokenSource {
  httpToken(
    id: string,
    opts?: { rotate?: boolean },
  ): Promise<string | undefined>;
}

export interface PluginWireAuthArgs {
  context: Context | WireAuthContext;
  trustedRemoteAddress?: string;
  deps: PluginWireAuthDeps;
  plugins: PluginWireTokenSource;
  pluginId: string;
  auth: PluginHttpAuthMode;
  /**
   * The per-install capability service, when the gate is enabled. It is the
   * operator's all-access credential: presenting it satisfies every wire auth
   * mode, because the operator already holds the entire API. Null when the
   * capability gate is disabled.
   */
  capability: PublicApiCapabilityService | null;
}

export function localWireAuthProblem(
  context: WireAuthContext,
  deps: PluginWireAuthDeps,
  trustedRemoteAddress?: string,
): WireAuthProblem | null {
  return browserRequestProblem(
    context,
    deps,
    { requireJsonForMutation: true },
    trustedRemoteAddress,
  );
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

/**
 * ME-1 (TG5.1): plugin credentials are header-only. The former `?token=`
 * query channel was removed — query credentials leak through access logs,
 * reverse proxies, browser history, monitoring, copied URLs, and referrer
 * handling. `WireAuthContext` deliberately has no `query` accessor, so a
 * future edit cannot reintroduce the channel without touching this guard.
 * Malformed Authorization values fail closed (nothing presented).
 */
function presentedWireToken(header: TokenReader): string | undefined {
  const dedicated = header("x-bb-plugin-token")?.trim();
  if (dedicated !== undefined && dedicated.length > 0) {
    return dedicated;
  }
  const authorization = header("authorization")?.trim();
  if (authorization === undefined) {
    return undefined;
  }
  return /^Bearer\s+(\S+)$/iu.exec(authorization)?.[1];
}

async function pluginTokenAuthProblem(
  context: WireAuthContext,
  plugins: PluginWireTokenSource,
  id: string,
): Promise<WireAuthProblem | null> {
  const presented = presentedWireToken((name) => context.req.header(name));
  const expected = await plugins.httpToken(id);
  if (
    expected === undefined ||
    presented === undefined ||
    !timingSafeEqualStrings(presented, expected)
  ) {
    return {
      status: 401,
      error:
        'missing or invalid plugin token — send it as the "x-bb-plugin-token" header ' +
        '(or "Authorization: Bearer <token>"); print it with `bb plugin token ' +
        `${id}\``,
    };
  }
  return null;
}

/**
 * Authorization guard for plugin wire routes (plugin → scoped endpoint,
 * spec A3). The credential is bound to the route's own plugin id — a token
 * minted for plugin A never authorizes plugin B — and the per-install
 * capability satisfies every mode. Unknown auth modes fail closed: this
 * handler is the last line of defense on a capability-exempt surface, so an
 * unrecognized mode must never degrade to "open".
 */
export async function pluginWireAuthProblem(
  args: PluginWireAuthArgs,
): Promise<WireAuthProblem | null> {
  const { context, capability } = args;
  if (
    capability !== null &&
    capability.verify(presentedCapability((name) => context.req.header(name)))
  ) {
    return null;
  }
  switch (args.auth) {
    case "local":
      return localWireAuthProblem(
        context,
        args.deps,
        args.trustedRemoteAddress,
      );
    case "token":
      return pluginTokenAuthProblem(context, args.plugins, args.pluginId);
    case "none":
      return null;
    default:
      return {
        status: 401,
        error: `plugin route declares unsupported auth mode "${String(args.auth)}"`,
      };
  }
}

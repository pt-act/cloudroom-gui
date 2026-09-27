import {
  buildLocalAppOrigins,
  type BuildLocalAppOriginsArgs,
} from "@bb/config/local-app-origins";
import type { ServerRuntimeConfig } from "./types.js";

interface BrowserRequestGuardDeps {
  config: Pick<ServerRuntimeConfig, "serverPort" | "appUrl" | "devAppPort">;
  trustedProxies?: readonly string[];
}

export interface BrowserRequestProblem {
  status: 403 | 415;
  error: string;
}

interface BrowserRequestGuardOptions {
  requireJsonForMutation?: boolean;
}

import { isLoopbackAddress } from "@bb/config/loopback";

interface BrowserRequestContext {
  req: {
    url: string;
    method: string;
    header(name: string): string | undefined;
  };
  /**
   * Direct socket peer address, when the caller knows it (captured from the
   * connection by request-context). Forwarded identity headers are honored
   * only when this peer is trusted (TG2.2).
   */
  trustedRemoteAddress?: string;
}

export function allowedAppOrigins(deps: BrowserRequestGuardDeps): Set<string> {
  const args: BuildLocalAppOriginsArgs = {
    serverPort: deps.config.serverPort,
  };
  if (deps.config.appUrl !== undefined) {
    args.appUrl = deps.config.appUrl;
  }
  if (deps.config.devAppPort !== undefined) {
    args.devAppPort = deps.config.devAppPort;
  }
  return new Set(buildLocalAppOrigins(args));
}

function knownAppPorts(deps: BrowserRequestGuardDeps): Set<number> {
  const ports = new Set<number>([deps.config.serverPort]);
  if (deps.config.devAppPort !== undefined) {
    ports.add(deps.config.devAppPort);
  }
  return ports;
}

export function effectivePort(url: URL): number | null {
  if (url.port.length > 0) {
    const port = Number(url.port);
    return Number.isInteger(port) ? port : null;
  }
  if (url.protocol === "http:") {
    return 80;
  }
  if (url.protocol === "https:") {
    return 443;
  }
  return null;
}

function parseRequestHost(host: string, protocol: string): URL | null {
  try {
    const url = new URL(`${protocol}//${host}`);
    return url.username.length === 0 &&
      url.password.length === 0 &&
      url.pathname === "/" &&
      url.search.length === 0 &&
      url.hash.length === 0
      ? url
      : null;
  } catch {
    return null;
  }
}

// TG2.2: forwarded identity headers are honored only when the direct peer
// is a trusted proxy — loopback by default, plus explicitly configured
// addresses. A peer that can reach the port directly cannot forge its way
// into a trusted-origin claim.
function isTrustedProxyPeer(
  context: BrowserRequestContext,
  deps: BrowserRequestGuardDeps,
): boolean {
  const peer = context.trustedRemoteAddress;
  if (peer === undefined) {
    return false;
  }
  if (isLoopbackAddress(peer)) {
    return true;
  }
  return (deps.trustedProxies ?? []).includes(peer);
}

function requestTargets(
  context: BrowserRequestContext,
  deps: BrowserRequestGuardDeps,
): URL[] {
  const requestUrl = new URL(context.req.url);
  const targets = [requestUrl];
  const forwardedProtocol =
    context.req.header("x-forwarded-proto")?.split(",", 1)[0]?.trim() ||
    requestUrl.protocol.replace(/:$/u, "");

  const trustForwarded = isTrustedProxyPeer(context, deps);
  for (const rawHost of [
    context.req.header("host"),
    trustForwarded
      ? context.req.header("x-forwarded-host")?.split(",", 1)[0]?.trim()
      : undefined,
  ]) {
    if (rawHost === undefined || rawHost.length === 0) {
      continue;
    }
    const target = parseRequestHost(rawHost, `${forwardedProtocol}:`);
    if (target !== null) {
      targets.push(target);
    }
  }
  return targets;
}

function isTrustedOrigin(
  context: BrowserRequestContext,
  deps: BrowserRequestGuardDeps,
  origin: string,
): boolean {
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  if (
    originUrl.origin !== origin ||
    (originUrl.protocol !== "http:" && originUrl.protocol !== "https:")
  ) {
    return false;
  }

  if (allowedAppOrigins(deps).has(originUrl.origin)) {
    return true;
  }

  const targets = requestTargets(context, deps);
  if (targets.some((target) => target.origin === originUrl.origin)) {
    return true;
  }

  const originPort = effectivePort(originUrl);
  if (originPort === null || !knownAppPorts(deps).has(originPort)) {
    return false;
  }

  return targets.some((target) => target.hostname === originUrl.hostname);
}

function isJsonContentType(contentType: string | undefined): boolean {
  return (
    contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json"
  );
}

export function browserRequestProblem(
  context: BrowserRequestContext,
  deps: BrowserRequestGuardDeps,
  options: BrowserRequestGuardOptions = {},
  trustedRemoteAddress?: string,
): BrowserRequestProblem | null {
  const guardedContext: BrowserRequestContext =
    trustedRemoteAddress === undefined
      ? context
      : { req: context.req, trustedRemoteAddress };
  const origin = guardedContext.req.header("origin");
  if (origin !== undefined && !isTrustedOrigin(guardedContext, deps, origin)) {
    return {
      status: 403,
      error: `origin "${origin}" is not a local BB app origin`,
    };
  }

  const method = guardedContext.req.method.toUpperCase();
  if (
    options.requireJsonForMutation === true &&
    method !== "GET" &&
    method !== "HEAD" &&
    method !== "OPTIONS" &&
    !isJsonContentType(guardedContext.req.header("content-type"))
  ) {
    return {
      status: 415,
      error: "content-type must be application/json",
    };
  }

  return null;
}

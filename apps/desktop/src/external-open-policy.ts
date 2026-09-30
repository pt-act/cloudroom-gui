/**
 * External-open policy (ME-5 / TG6): the single decision point for every
 * URL this desktop shell hands to `shell.openExternal`. The allowlist is
 * HTTP and HTTPS only — custom schemes can launch registered protocol
 * handlers, and `file:`/`javascript:`/`data:` URLs must never leave the
 * renderer through the OS opener. Callers apply the decision immediately
 * before `shell.openExternal` so no earlier path can bypass it.
 *
 * Gesture rule, restated after the verdict-TG6 blocker: Electron's
 * window-open API exposes NO gesture signal — HandlerDetails carries
 * exactly url, frameName, features, disposition, referrer, and postBody —
 * so a gesture requirement is unimplementable at that boundary. User
 * intent is enforced where it is observable: the renderer's own click
 * handlers (button, defaultPrevented, modifier checks) and the IPC path,
 * which is reachable only by registered application windows. The
 * window-open path therefore enforces the scheme allowlist only; the
 * residual — script-initiated window.open of http(s) URLs from renderer
 * content reaching the default browser — is accepted and documented in
 * the TG6 resolution report.
 */
export type ExternalUrlOpenDecision =
  | { action: "open"; url: string }
  | { action: "deny"; reason: "invalid_url" | "scheme_not_allowed" };

export type ExternalOpenIpcDecision =
  | { action: "open"; url: string }
  | {
      action: "deny";
      reason:
        | "untrusted_sender"
        | "invalid_payload"
        | "invalid_url"
        | "scheme_not_allowed";
    };

const CONTROL_CHARACTER = /[\u0000-\u001f]/u;

// The open branch carries the NORMALIZED url (verdict-TG6 Minor 2): the
// string handed to the OS must be the exact string that was validated, so
// callers open `decision.url`, never their own raw input.
export function externalUrlOpenDecision(
  rawUrl: string,
): ExternalUrlOpenDecision {
  if (rawUrl.length === 0 || CONTROL_CHARACTER.test(rawUrl)) {
    return { action: "deny", reason: "invalid_url" };
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { action: "deny", reason: "invalid_url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { action: "deny", reason: "scheme_not_allowed" };
  }
  return { action: "open", url: parsed.toString() };
}

export function externalOpenIpcDecision(args: {
  payload: unknown;
  senderIsApplicationWindow: boolean;
}): ExternalOpenIpcDecision {
  if (!args.senderIsApplicationWindow) {
    return { action: "deny", reason: "untrusted_sender" };
  }
  if (typeof args.payload !== "string") {
    return { action: "deny", reason: "invalid_payload" };
  }
  const decision = externalUrlOpenDecision(args.payload);
  if (decision.action === "deny") {
    return decision;
  }
  return decision;
}

/**
 * Rejection-log form (task 6.7): scheme/host/path only — query strings can
 * carry credentials (see `apps/server/src/request-url-redaction.ts` for the
 * server-side rule) and must never reach logs.
 */
export function redactExternalUrlForLogging(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "[unparseable-url]";
  }
}

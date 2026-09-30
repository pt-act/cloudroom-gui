import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  externalOpenIpcDecision,
  externalUrlOpenDecision,
  redactExternalUrlForLogging,
} from "../src/external-open-policy.js";

/**
 * SP-3 openExternal half (ME-5 / TG6): a URL reaches the OS opener if and
 * only if it parses to http/https and the sender is trusted. Electron's
 * window-open API exposes no gesture signal (verdict-TG6 blocker), so user
 * intent is enforced in the renderer's click handlers and the sender-gated
 * IPC path; the window-open boundary enforces the scheme allowlist. The
 * predicates below state the security rule independently of the
 * implementation.
 */
const specUrlAllowed = (url: string): boolean => {
  if (url.length === 0 || /[\u0000-\u001f]/u.test(url)) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

const urlArb = fc.oneof(
  fc
    .tuple(
      fc.constantFrom("https", "http"),
      fc.webSegment(),
      fc.stringMatching(/^[a-z]{0,6}$/),
    )
    .map(([scheme, host, path]) => `${scheme}://${host}/${path}?q=${path}`),
  fc
    .tuple(fc.constantFrom("HTTPS", "Http"), fc.webSegment())
    .map(([scheme, host]) => `${scheme}://${host}/uppercase-scheme`),
  fc
    .tuple(fc.webSegment(), fc.stringMatching(/^[a-z0-9_-]{0,8}$/))
    .map(([host, user]) => `https://${user}@${host}/credentialed`),
  fc.constantFrom(
    "file:///etc/passwd",
    "javascript:alert(1)",
    "javascript:fetch('https://exfil.test')",
    "data:text/html,<h1>preview</h1>",
    "vscode://file/tmp/report",
    "slack://channel/team",
    "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
    "chrome://settings",
    "about:blank",
    "ftp://host/file",
    "mailto:someone@example.test",
    "ssh://host.example.test",
  ),
  fc.constantFrom("", "not a url", "//host/path", "http:", "https:/", "   "),
  fc.constantFrom(
    "http://example.com/\u0000escape",
    "https://ex\nample.com/path",
    "javascript:alert(1)\n//still-script",
  ),
);

describe("SP-3 external-open policy (ME-5; TG6.3/6.5)", () => {
  it("allows exactly parseable http(s) URLs and rejects everything else", () => {
    fc.assert(
      fc.property(urlArb, (url) => {
        const decision = externalUrlOpenDecision(url);
        if (specUrlAllowed(url)) {
          // The open branch carries the normalized URL (Minor 2): the OS
          // receives the exact string that was validated.
          expect(decision, `url: ${JSON.stringify(url)}`).toEqual({
            action: "open",
            url: new URL(url).toString(),
          });
        } else {
          expect(decision.action, `url: ${JSON.stringify(url)}`).toBe("deny");
        }
      }),
      { numRuns: 300 },
    );
  });

  it("opens over IPC only for trusted senders with parseable http(s) payloads", () => {
    fc.assert(
      fc.property(
        urlArb,
        fc.boolean(),
        fc.constantFrom(42, null, { url: "https://x.test" }, undefined),
        (url, senderIsApplicationWindow, nonStringPayload) => {
          const stringDecision = externalOpenIpcDecision({
            payload: url,
            senderIsApplicationWindow,
          });
          if (!senderIsApplicationWindow) {
            expect(stringDecision).toEqual({
              action: "deny",
              reason: "untrusted_sender",
            });
          } else if (specUrlAllowed(url)) {
            expect(stringDecision).toEqual({
              action: "open",
              url: new URL(url).toString(),
            });
          } else {
            expect(stringDecision.action).toBe("deny");
          }

          const nonStringDecision = externalOpenIpcDecision({
            payload: nonStringPayload,
            senderIsApplicationWindow: true,
          });
          expect(nonStringDecision).toEqual({
            action: "deny",
            reason: "invalid_payload",
          });
        },
      ),
      { numRuns: 200 },
    );
  });

  it("logs rejections without query strings or fragments", () => {
    fc.assert(
      fc.property(
        fc.webSegment(),
        fc.stringMatching(/^[a-zA-Z0-9_-]{4,20}$/),
        fc.stringMatching(/^[a-zA-Z0-9_-]{4,20}$/),
        (host, queryValue, fragment) => {
          const url = `https://${host}/path?secret=${queryValue}#${fragment}`;
          // The generated host may itself be unparseable; the redactor's
          // contract for parseable URLs is what this property pins.
          let parsed: URL;
          try {
            parsed = new URL(url);
          } catch {
            return fc.pre(false);
          }
          // The secret must not collide with path/host text, or the
          // not-contains assertion below would be a false failure.
          fc.pre(!parsed.pathname.includes(queryValue));
          const redacted = redactExternalUrlForLogging(url);
          // Exact structural equality: origin + path, nothing else.
          expect(redacted).toBe(
            `${parsed.protocol}//${parsed.host}${parsed.pathname}`,
          );
          expect(redacted).not.toContain(queryValue);
        },
      ),
      { numRuns: 100 },
    );
  });
});

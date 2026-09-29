import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { redactCredentialQueryParams } from "../../src/request-url-redaction.js";

/**
 * TG5.7: the stated redaction rule for credential-bearing URLs. No server
 * write path records raw request URLs today (there is deliberately no
 * request logger); this property pins the canonical implementation that any
 * future logger must use, so the rule is enforceable the day one appears.
 * Property: every query parameter whose NAME contains "token"
 * (case-insensitive) has its value replaced; every other part of the URL is
 * preserved; a URL without credential params round-trips unchanged.
 */

const safeValueArb = fc
  .stringMatching(/^[a-zA-Z0-9._~:/?#[\]@!$&'()*+,;=-]{0,12}$/)
  .filter((value) => !value.includes("token"));

const secretValueArb = fc.stringMatching(/^[a-zA-Z0-9_-]{4,24}$/);

describe("credential URL redaction (TG5.7)", () => {
  it("redacts every token-named parameter value and preserves the rest", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("token", "Token", "terminalToken", "auth_token"),
        secretValueArb,
        safeValueArb,
        (credentialName, secret, safeValue) => {
          const query = new URLSearchParams({
            [credentialName]: secret,
            safe: safeValue,
          });
          const url = `https://host.test/ws?${query.toString()}`;
          const redacted = redactCredentialQueryParams(url);
          expect(redacted).not.toContain(secret);
          const params = new URLSearchParams(
            redacted.slice(redacted.indexOf("?") + 1),
          );
          expect(params.get(credentialName)).toBe("[redacted]");
          expect(params.get("safe")).toBe(safeValue);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("leaves URLs without credential parameters unchanged", () => {
    fc.assert(
      fc.property(safeValueArb, safeValueArb, (a, b) => {
        const query = new URLSearchParams({ alpha: a, beta: b });
        const url = `https://host.test/ws?${query.toString()}`;
        expect(redactCredentialQueryParams(url)).toBe(url);
      }),
      { numRuns: 100 },
    );
  });
});

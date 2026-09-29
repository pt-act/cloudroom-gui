/**
 * Redaction rule for credential-bearing URLs (TG5, verdict-tg3 advisory):
 * no log, event, metric, or history write path may persist a raw request
 * URL that carries a credential query parameter. The one credential that
 * legitimately travels in a query string is the terminal WebSocket
 * capability (`?terminalToken=`) — platform-forced, because browsers cannot
 * set headers on a WS handshake; its short lifetime is the mitigation, and
 * it is documented at the upgrade site in server.ts. Plugin credentials
 * have no query channel at all (ME-1, TG5.1).
 *
 * There is deliberately no request logger in this server today; this helper
 * is the canonical implementation waiting for one, so the rule is a
 * function call rather than a cautionary comment.
 */
const CREDENTIAL_QUERY_PARAM = /token/i;
const REDACTED_VALUE = "[redacted]";

export function redactCredentialQueryParams(url: string): string {
  const queryStart = url.indexOf("?");
  if (queryStart === -1) {
    return url;
  }
  const base = url.slice(0, queryStart);
  const query = url.slice(queryStart + 1);
  if (query.length === 0) {
    return url;
  }
  const params = new URLSearchParams(query);
  let changed = false;
  for (const name of [...params.keys()]) {
    if (CREDENTIAL_QUERY_PARAM.test(name)) {
      params.set(name, REDACTED_VALUE);
      changed = true;
    }
  }
  return changed ? `${base}?${params.toString()}` : url;
}

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

// Refresh proactively if the access token expires within this window.
// Buffer prevents race conditions where the SDK starts a request with a
// "still valid" token that expires mid-flight.
const REFRESH_THRESHOLD_MS = 60_000;

// Single-flight: at most one refresh in progress. Concurrent callers
// share the same promise and don't all hit the OAuth endpoint.
let active_refresh = null;

function read_credentials() {
  const raw = readFileSync(CREDENTIALS_PATH, "utf-8");
  return JSON.parse(raw);
}

function write_credentials_atomic(creds) {
  // Write to temp + rename so the file is never observed in a partial
  // state by a concurrent reader.
  const tmp = CREDENTIALS_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(creds, null, 2), { mode: 0o600 });
  renameSync(tmp, CREDENTIALS_PATH);
}

async function refresh_tokens(refresh_token, signal) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token,
    client_id: CLIENT_ID,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OAuth refresh failed: ${res.status} ${res.statusText} ${text}`);
  }

  return await res.json();
}

/**
 * SDK callback for getOAuthToken in query() options.
 * Returns a valid access token, refreshing via the OAuth endpoint if
 * the cached one is expired or near-expired.
 */
export async function get_access_token({ signal } = {}) {
  const creds = read_credentials();
  const oauth = creds.claudeAiOauth;

  if (!oauth) {
    throw new Error("No claudeAiOauth field in ~/.claude/.credentials.json");
  }

  if (oauth.expiresAt > Date.now() + REFRESH_THRESHOLD_MS) {
    return oauth.accessToken;
  }

  if (!active_refresh) {
    active_refresh = (async () => {
      try {
        const refreshed = await refresh_tokens(oauth.refreshToken, signal);
        const updated = {
          ...creds,
          claudeAiOauth: {
            ...oauth,
            accessToken: refreshed.access_token,
            refreshToken: refreshed.refresh_token ?? oauth.refreshToken,
            expiresAt: Date.now() + refreshed.expires_in * 1000,
          },
        };
        write_credentials_atomic(updated);
        return updated.claudeAiOauth.accessToken;
      } finally {
        active_refresh = null;
      }
    })();
  }

  return active_refresh;
}

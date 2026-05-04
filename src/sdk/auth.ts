/**
 * Pure OAuth refresh against Anthropic's token endpoint.
 *
 * Read ~/.claude/.credentials.json, return the cached access token if
 * still valid, otherwise refresh via POST and persist the new tokens
 * atomically before returning.
 *
 * Called from ManagedQuery.run() before each query() invocation. The
 * SDK's bundled CLI reads the credentials file at startup; ensuring the
 * file is fresh before spawning means the CLI sees a valid token. The
 * SDK does expose a `getOAuthToken` callback option, but the bundled
 * CLI gates delegation on an entrypoint allowlist that excludes
 * `sdk-ts`, so that path is dead for our use.
 *
 * See docs/AUTH.md for the broader auth story and the failed-refresh
 * recovery design (currently manual; future in-app re-auth flow).
 */

import { readFileSync, writeFileSync, renameSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

// Refresh proactively if the access token expires within this window.
// Buffer prevents a request from starting "still valid" and expiring
// mid-flight.
const REFRESH_THRESHOLD_MS = 60_000;

interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  [key: string]: unknown;
}

interface CredentialsFile {
  claudeAiOauth: OAuthCredentials;
  [key: string]: unknown;
}

interface RefreshResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type?: string;
}

// Single-flight: at most one refresh in progress at a time. Concurrent
// callers share the same in-flight promise.
let activeRefresh: Promise<string> | null = null;

function readCredentials(): CredentialsFile {
  const raw = readFileSync(CREDENTIALS_PATH, "utf-8");
  return JSON.parse(raw) as CredentialsFile;
}

function writeCredentialsAtomic(creds: CredentialsFile): void {
  // Temp + rename so concurrent readers never observe a partial file.
  const tmp = CREDENTIALS_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(creds, null, 2), { mode: 0o600 });
  renameSync(tmp, CREDENTIALS_PATH);
}

async function refreshTokens(
  refreshToken: string,
  signal?: AbortSignal,
): Promise<RefreshResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
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
    throw new Error(
      `OAuth refresh failed: ${res.status} ${res.statusText} ${text}`,
    );
  }

  return (await res.json()) as RefreshResponse;
}

/**
 * SDK callback for `getOAuthToken` in `query()` options. Returns a
 * valid access token, refreshing via the OAuth endpoint if the cached
 * one is expired or near-expired.
 */
export async function getAccessToken(
  ctx?: { signal?: AbortSignal },
): Promise<string> {
  console.log("[auth] getAccessToken invoked");
  const creds = readCredentials();
  const oauth = creds.claudeAiOauth;

  if (!oauth) {
    console.error("[auth] no claudeAiOauth in credentials file");
    throw new Error("No claudeAiOauth field in ~/.claude/.credentials.json");
  }

  const now = Date.now();
  const msUntilExpiry = oauth.expiresAt - now;
  console.log(
    `[auth] expiresAt=${new Date(oauth.expiresAt).toISOString()} now=${new Date(now).toISOString()} msUntilExpiry=${msUntilExpiry} threshold=${REFRESH_THRESHOLD_MS}`,
  );

  if (oauth.expiresAt > now + REFRESH_THRESHOLD_MS) {
    console.log("[auth] cached token still valid, returning");
    return oauth.accessToken;
  }

  console.log("[auth] token expired or near-expiry, refreshing");

  if (!activeRefresh) {
    activeRefresh = (async () => {
      try {
        const refreshed = await refreshTokens(oauth.refreshToken, ctx?.signal);
        console.log(
          `[auth] refresh succeeded, new expires_in=${refreshed.expires_in}s, refresh_token rotated=${refreshed.refresh_token !== undefined && refreshed.refresh_token !== oauth.refreshToken}`,
        );
        const updated: CredentialsFile = {
          ...creds,
          claudeAiOauth: {
            ...oauth,
            accessToken: refreshed.access_token,
            refreshToken: refreshed.refresh_token ?? oauth.refreshToken,
            expiresAt: Date.now() + refreshed.expires_in * 1000,
          },
        };
        writeCredentialsAtomic(updated);
        console.log("[auth] credentials file rewritten atomically");
        return updated.claudeAiOauth.accessToken;
      } catch (err) {
        console.error(
          "[auth] refresh failed:",
          err instanceof Error ? err.message : err,
        );
        throw err;
      } finally {
        activeRefresh = null;
      }
    })();
  } else {
    console.log("[auth] joining in-flight refresh");
  }

  return activeRefresh;
}

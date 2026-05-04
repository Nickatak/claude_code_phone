# Auth

How authentication works in the spike, and known gaps to address later.

## Current state

OAuth bearer tokens live in `~/.claude/.credentials.json` under the `claudeAiOauth` key (`accessToken`, `refreshToken`, `expiresAt`, `subscriptionType`, `scopes`). The Anthropic CLI populates this file via an interactive browser-based OAuth flow on first sign-in.

Our [auth.js](../auth.js) refreshes the bearer token on demand:

- Reads the credentials file on every `get_access_token()` call
- If `expiresAt` is more than 60s away, returns the cached `accessToken`
- Otherwise POSTs a `refresh_token` grant to `https://platform.claude.com/v1/oauth/token` with `client_id: 9d1c250a-e61b-44d9-88ed-5944d1962f5e` and the current `refreshToken`
- Writes the new tokens back to disk atomically (temp + rename, mode `0o600`)
- Single-flight: concurrent callers share one in-flight refresh promise

ManagedQuery threads `get_access_token` into the SDK's `getOAuthToken` option, which flips on the SDK's `CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH=1` mechanism. The bundled CLI calls back to us when it needs a fresh token.

## Recovery: when refresh fails

If `auth.js`'s POST to the OAuth endpoint returns `400 invalid_grant` (or similar), the `refreshToken` itself is no longer valid. Reasons this happens:

- User revoked Claude Code's access via their Anthropic account settings
- Server-side invalidation (security event, password change, etc.)
- Refresh-token natural expiry (lifetime unknown; needs empirical observation)
- Refresh-token rotation race: our code crashed between receiving a rotated `refreshToken` and writing it to disk, so the on-disk one is now invalid server-side

**Current recovery**: manual. SSH to the host, run `claude` interactively to re-auth via the browser flow, which repopulates `~/.claude/.credentials.json` with a fresh `refreshToken`. Then the app's auth.js works again.

This is fine for development but bad for a deployed phone-only app. If the user is away from a desktop and the refresh token dies, the app is unrecoverable until they get to a machine with `claude` installed and a browser.

## Future: in-app re-auth flow

(Way later. Capture only.)

When `auth.js` detects a failed refresh, the server should surface a sign-in link to the phone instead of just throwing. The user taps it on their phone, completes the OAuth flow in mobile Safari/Chrome, and the server captures the callback to repopulate the credentials file. Recovery from the phone alone, no SSH.

Sketch of what this involves:

1. **Detect refresh failure**: `auth.js` already throws on `invalid_grant`. The server-side wrapper around it would catch and emit a "needs re-auth" signal to the connected phone (an SSE event, or a state on the next REST poll).
2. **Build the authorize URL**: construct `https://platform.claude.com/oauth/authorize?client_id=9d1c250a-...&redirect_uri=<our-server's-callback>&response_type=code&scope=<scopes>&state=<CSRF-token>` and possibly PKCE params if Anthropic requires them.
3. **Phone receives the URL**, displays a "session expired, tap to sign in" prompt with the link.
4. **User taps**, browser opens, user signs into Anthropic, authorizes Claude Code, browser redirects to our callback with `?code=<authorization_code>`.
5. **Our callback endpoint** exchanges the code for tokens (POST to the same `/v1/oauth/token` endpoint, but with `grant_type: "authorization_code"`, the `code`, the `redirect_uri`, the `client_id`, and the PKCE verifier if used).
6. **Write the new `accessToken` and `refreshToken`** into `~/.claude/.credentials.json`. App is now back online.
7. **Resume the failed Query** (or just let the user retry).

What needs investigation before implementing:

- The exact authorize URL parameters Anthropic accepts (response_type, scope formatting, PKCE requirement). Probably visible in the SDK's CLI source under the `CONSOLE_AUTHORIZE_URL` constant we found.
- Whether PKCE is required (it should be for public clients — and the SDK's CLI is one).
- Where the server's callback endpoint should live and how it correlates back to the user's session (state parameter, probably).
- Whether the `client_id` baked into the SDK is reusable from a third-party app or whether Anthropic restricts it to their own clients (likely the latter, but worth confirming — could mean we'd need our own client registration, which is a bigger lift).

If the `client_id` isn't reusable, the in-app auth path becomes substantially harder (or impossible without registering a separate OAuth client with Anthropic). Worth checking before sinking time into the design.

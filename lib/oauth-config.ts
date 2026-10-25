import { appBaseUrl } from './auth';

// Constants of the OAuth sign-in for MCP clients (docs/auth.md "Connecting Claude with OAuth"). No server-only here:
// pages and the well-known routes read them too.

/** The one scope: act as the signed-in person in the organization they approved (what a Claude chat key does). */
export const OAUTH_SCOPE = 'workos';
/** `offline_access` asks for a refresh token; Claude adds it itself when the metadata lists it. */
export const OAUTH_SCOPES = [OAUTH_SCOPE, 'offline_access'] as const;
export const ACCESS_TOKEN_SECONDS = 3600;
export const REFRESH_TOKEN_SECONDS = 30 * 86_400;
/** Registered clients that never got an approval are deleted after this long. */
export const UNUSED_CLIENT_HOURS = 48;

/** The MCP endpoint's address: the protected resource the tokens are for (RFC 8707/9728). Must equal what the user enters in Claude. */
export function mcpResource(): string {
  return `${(appBaseUrl() ?? '').replace(/\/+$/, '')}/api/mcp`;
}

/** The authorization server's issuer: Better Auth's base URL. */
export function oauthIssuer(): string {
  return `${(appBaseUrl() ?? '').replace(/\/+$/, '')}/api/auth`;
}

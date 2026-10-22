// Shared by the server (lib/fresh.ts, the /api/auth route) and the browser (components/reauth.tsx).

/** Minutes after a sign-in or password re-entry during which new credentials can be made. */
export const FRESH_MINUTES = 10;
/** The error text that makes the UI ask for the password and retry. */
export const REAUTH_MESSAGE = 'Enter your password again to continue.';
/** The code the /api/auth route answers with (403) when a passkey is added without a fresh session. */
export const REAUTH_CODE = 'FRESH_SESSION_REQUIRED';

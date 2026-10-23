# Saved Google Drive access

`drive-session` renews Google Drive access after a browser reload and before the short-lived Google access token expires. The static GitHub Pages app calls this Supabase Edge Function with the signed-in Note user's Supabase JWT. Each person connects their own linked Google account; no account IDs are accepted from the request body.

The function exchanges and independently verifies the Google refresh grant, checks its Google subject against the user's server-verified linked identity, and checks Drive permission before saving anything. A browser-supplied access token cannot prove ownership of a refresh grant.

Google client secrets and the encryption key stay in Edge Function secrets. Refresh tokens, cached access tokens, and expiration times are stored together as AES-GCM ciphertext in a service-role-only database table. Authenticated users cannot read or change even their own ciphertext row through the Data API. AAD binds each encrypted payload to its Note owner and Google subject. Responses contain only a short-lived access token, its expiration, and the verified subject. The browser may cache that short-lived access token with its absolute expiry, Note owner, and Google subject so reloading does not require consent; sign-out clears that browser cache. Google refresh tokens are never persisted in browser storage. The function never logs request bodies, Google token responses, or credentials.

## One-time deployment

This repository prepares the function and SQL; building or deploying GitHub Pages does **not** deploy a Supabase Edge Function or run SQL. These steps must be completed by the Supabase project owner in their own dashboard or trusted local terminal. Do not paste credentials into chat, repository files, frontend variables, issues, or screenshots.

1. Open **Supabase → SQL Editor** and run the entire [enable-drive-refresh.sql](../../enable-drive-refresh.sql). The migration is safe to rerun and preserves boards, images, and saved ciphertext.
2. Open **Supabase → Edge Functions → Secrets** and add the following server-only secrets:

   | Secret | Value |
   | --- | --- |
   | `GOOGLE_CLIENT_ID` | The same Google **web OAuth** client ID configured under Supabase Authentication → Google. |
   | `GOOGLE_CLIENT_SECRET` | The secret for that same Google client, copied privately from Google Cloud. |
   | `DRIVE_TOKEN_ENCRYPTION_KEY` | A fresh, stable, base64-encoded 32-byte random key. Generate privately with `openssl rand -base64 32`. |
   | `DRIVE_ALLOWED_ORIGINS` | Exact allowed origins, separated by commas. For this deployment: `https://augustof2022.github.io`. Do not include `/notes/`, a trailing slash, or `*`. |

   Supabase provides `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` automatically in the deployed runtime. They must never be frontend variables. Preserve the encryption key: replacing or losing it requires users to reconnect Drive, although their boards and Drive images remain intact.

3. From this repository on a trusted computer with the Supabase CLI, sign in privately and deploy:

   ```bash
   npx supabase login
   npx supabase functions deploy drive-session --project-ref wrkoxjlzdeiffdtgbyvq
   ```

   For another project, replace the project ref. The checked-in `supabase/config.toml` sets `verify_jwt = true`. Leave platform JWT verification enabled. The handler also calls `auth.getUser(jwt)` and requires an authenticated Note user with a linked Google identity; an API key alone, an anonymous token, or a service-role token is insufficient. Current Supabase platform verification supports both legacy HS256 and asymmetric user JWT signing keys.

4. Load the updated Note app and choose **Reconnect Google Drive** once. The OAuth request uses `access_type=offline` and `prompt=consent` so Google can return `provider_refresh_token`. That new grant passes transiently through the OAuth session and is sent to this authenticated function over HTTPS; it is not persisted in browser storage. Subsequent browser reloads and other devices using the same Note account can request a fresh access session from the saved server grant.
5. Reopen the app and open a board containing an uncached Drive image. It should retrieve a short-lived access session without a new Google consent prompt. Renewals happen when needed; there is no background cron job and the browser need not remain open.

Keep the Google Drive API enabled and retain the same Google OAuth client for existing `drive.file` images. A Google External app left in **Testing** can issue Drive refresh grants that expire after seven days; revoked, expired, or changed permissions legitimately require reconnection. Complete Google Production/verification requirements where applicable. The backend cannot override Google's consent rules.

Supabase Edge Function and database usage counts toward the project's ordinary quotas. This integration requires no additional paid image or OAuth service, but it is not an unlimited-usage guarantee.

## API

All actions use `POST /functions/v1/drive-session`, `Content-Type: application/json`, and `Authorization: Bearer <current Note user JWT>`. Supabase's normal publishable/anon project key belongs in the `apikey` header; it is not the user JWT.

```json
{"action":"connect","provider_refresh_token":"<transient OAuth grant>"}
```

```json
{"action":"token"}
```

If Google rejects a previously issued access token with HTTP 401, retry the token request once with that exact value as `rejected_token`. The function renews only when the rejected value is still current, and otherwise returns a newer cached token.

```json
{"action":"token","rejected_token":"<rejected short-lived access token>"}
```

Successful connect/token response:

```json
{"access_token":"<short-lived access token>","expires_at":1792756800000,"google_subject":"<verified Google sub>","renewable":true}
```

`expires_at` is epoch **milliseconds**. The browser keeps a short-lived, account-bound access cache with the original absolute expiry; it never receives a saved refresh token, encryption key, or client secret from the function. Refresh tokens are never persisted in browser storage. Successful and error responses use `Cache-Control: no-store, private`. CORS allows only configured exact origins; CORS supplements authentication and does not replace it.

`{"action":"disconnect"}` clears the current user's saved Google tokens and returns `{"disconnected":true}`. It retains an inert encrypted-empty row/version marker so an already running connect/renew operation cannot recreate the cleared grant. It does not delete Drive images, sign out Note, or revoke Google's app-wide consent. Normal Note sign-out clears that browser's memory and access cache; it keeps the saved server grant usable by the user's other devices. To revoke Google's authorization fully, remove Note from **Google Account → Third-party connections**. Revocation can affect all devices.

Rows use version-conditional writes. A stale refresh cannot overwrite a newer connection or restore credentials after disconnect. An `invalid_grant` response clears only the credential version that failed; a newer connection survives. Concurrent requests within one instance share a renewal, and different instances reuse the winning conditional write.

Errors are redacted JSON `{ "error": "...", "message": "..." }`:

| HTTP | `error` | Meaning |
| --- | --- | --- |
| 401 | `unauthorized` | Note session must be renewed or signed in again. This does not itself remove the Google grant. |
| 409 | `drive_reconnect_required` | Saved grant is absent, cleared, expired/revoked by Google, unreadable with the configured key, or no longer belongs to the linked Google identity. |
| 403 | `drive_account_mismatch` / `drive_permission_required` | Reconnect the Google account linked to Note and allow app-created Drive file access. |
| 503 | `drive_setup_required` | Missing/misconfigured server secrets, table, or service permissions. The app owner must finish setup; repeated Google consent will not fix it. |
| 503 | `drive_temporarily_unavailable` | Temporary provider/network/database failure. Retry without deleting the saved grant. |

Requests are bounded to 16 KiB, tokens to 8 KiB, and Google requests time out after 15 seconds. Transient failures retain stored grants.

## Local testing

The production handler and AES-GCM routines are exercised with injected identity verification, storage, and Google responses:

```bash
npm test -- src/lib/drive-refresh-server.test.ts src/lib/drive-refresh-schema.test.ts
```

For a local Supabase stack, copy `supabase/functions/.env.example` to a private ignored `supabase/functions/.env`, set the values, and add your exact local origin to `DRIVE_ALLOWED_ORIGINS`. Do not commit the populated file. Hosted Google OAuth/Edge runtime still needs the owner's actual project configuration for an end-to-end deployment check.

References: [Supabase Google sign-in](https://supabase.com/docs/guides/auth/social-sign-in/auth-google), [Edge Function authentication headers](https://supabase.com/docs/guides/functions/auth-headers), [function secrets](https://supabase.com/docs/guides/functions/secrets), [Google refresh-token guidance](https://github.com/googleapis/google-auth-library-nodejs#oauth2).

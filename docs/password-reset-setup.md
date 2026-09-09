# Password reset deployment

The app now sends both password-reset requests with an explicit redirect to
`reset-password.html` in the current site's directory. That page consumes the
Supabase recovery session, asks for the new password twice, and calls
`auth.updateUser({ password })`. A missing/expired link offers a fresh email.
Recovery links landing on the app root are also routed to the reset page after
the SDK has persisted the recovery session, without copying tokens into a URL.

## Required hosted Auth configuration

These settings are managed by Supabase Auth, not Postgres migrations. In the
`Mayan ai app` project (`kgkdkkqoebnpahvetwzk`), open **Authentication → URL
Configuration** and set:

| Setting | Value for the current GitHub Pages deployment |
| --- | --- |
| Site URL | `https://mayangabinet-create.github.io/-/` |
| Additional Redirect URL | `https://mayangabinet-create.github.io/-/reset-password.html` |

Preserve other legitimate redirect entries. If the repository or domain changes,
update these settings to the actual deployed URLs. Do not use a broad wildcard
to work around a mismatch. The default recovery email should use
`{{ .ConfirmationURL }}`; a customized template must not hardcode localhost.

Changing JavaScript alone cannot fix an Auth redirect allow-list mismatch:
Supabase falls back to Site URL when the requested destination is not allowed.

## Verification

Run `node tests/password-reset.mjs` for controller regression tests without
touching any account. Then verify the deployed reset page opens without a 404.

After saving the dashboard configuration, request a **new** password-reset
email. The account owner should open its newest link and choose their password
themselves. Check that the URL stays on the deployed site, the password form
appears, and an actual successful save displays “Password updated”. Verify
sign-in with the new password. Never put recovery tokens, passwords or complete
email links in logs, screenshots, issues or commits.

References: [redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls),
[password recovery](https://supabase.com/docs/reference/javascript/auth-resetpasswordforemail).

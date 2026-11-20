# ChatHub on GitHub Pages

The frontend is published at `https://ymhomer.github.io/ChatHub/`. Cloudflare
Workers serves the API and file-sharing links at
`https://chathub-api.ymhomer-4253.workers.dev`. ChatHub uses its own D1 database
and R2 bucket.

## Repository settings

Set the Pages publishing source to **GitHub Actions**. Add these repository
secrets in **Settings → Secrets and variables → Actions**.

| Secret | Value |
| --- | --- |
| `_D1_NAME` | ChatHub D1 database name |
| `_D1_ID` | ChatHub D1 database ID |
| `_R2_BUCKET` | ChatHub R2 bucket name |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `CLOUDFLARE_API_TOKEN` | Token allowed to deploy Workers and apply D1 migrations |

The deploy workflow builds both outputs, applies D1 migrations, deploys the
Worker and publishes Pages. Set the frontend origin, API origin, worker name
and Pages base in the workflow if this copy moves to another repository.

Email/password, recovery codes and Passkey use the independent database.
The frontend authenticates API requests with a token kept in the current
browser tab session. Opening ChatHub in a fresh tab can require signing in
again. Passkeys bind to the Pages hostname. The Sites-only ChatGPT sign-in
option is hidden on the Pages frontend.

Test sign-in, Passkey, two-user chat, file preview and download, and expiring
transfer links after both URLs are serving HTTPS.

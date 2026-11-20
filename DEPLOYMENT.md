# ChatHub on GitHub Pages

This copy uses the ChatHub interface and API from source revision
`6ca49a235fb12ce6b0008c7edf76f6db604017e9`. The frontend is built for GitHub
Pages. Cloudflare Workers serves the API and the file-sharing URLs. Create a
fresh D1 database and a fresh R2 bucket for this deployment.

## Domain and access

Use two HTTPS hostnames on the same registrable domain, for example
`chat.example.com` and `chat-api.example.com`. This keeps the API session cookie
same-site when the browser contacts the Worker and lets Passkeys bind to the
frontend hostname. Point the frontend hostname at GitHub Pages using its
custom-domain setup. Keep the Worker hostname in a Cloudflare DNS zone that
the deploying account manages. Configure the GitHub Pages publishing source
as **GitHub Actions**.

Email/password, recovery codes and Passkey use the independent database.
ChatGPT Sites sign-in requires its original hosting integration. The standalone
frontend hides that option. Existing accounts, files and chats are outside this
deployment's database and bucket.

## Repository settings

Set the Actions variables below with the infrastructure created for this copy.

| Variable | Value |
| --- | --- |
| `CHATHUB_FRONTEND_HOST` | GitHub Pages custom hostname |
| `CHATHUB_API_HOST` | Worker custom hostname |
| `CHATHUB_D1_NAME` | New D1 database name |
| `CHATHUB_D1_ID` | New D1 database ID |
| `CHATHUB_R2_BUCKET` | New R2 bucket name |

Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` as Actions secrets.
The token needs access to deploy Workers, configure the Worker custom domain,
and apply migrations to the database. The workflow uses the Cloudflare
account's existing R2 bucket binding.

The workflow builds both outputs, applies the D1 schema, deploys the Worker
and publishes the frontend. Test registration, Passkey and recovery, two-user
chat, file preview/download, and expiring transfer links after both hostnames
are serving HTTPS.

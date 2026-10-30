# MCP authentication

Cloudflare Access handles OAuth for the endpoint declared in
[`infra/access.tf`](../infra/access.tf). The Worker accepts only Cloudflare's
verified `ctx.access` context with this application's audience and the configured
owner email. Caller-supplied Access headers cannot authenticate a request.
Cloudflare signs and verifies the identity before invoking the Worker; no custom
OAuth server or JWT decoder is involved. See the
[Workers Access contract](https://developers.cloudflare.com/workers/configuration/cloudflare-access/#read-authenticated-user-identity-with-ctxaccess).

This is authentication for the existing MCP tools, including write tools. The
plugin's skills choose a read-only workflow; OAuth does not add a read-only server
permission. Phone imports and Shortcuts continue to use `INGEST_SECRET`.

## Deploy and activate OAuth

1. Merge and deploy the companion change in
   [cloudflare-infrastructure](https://github.com/nicholls73/cloudflare-infrastructure).
   Its [MacroFactor configuration](https://github.com/nicholls73/cloudflare-infrastructure/blob/main/macrofactor-mcp.tf)
   owns the deployment permissions and publishes `WORKERS_SUBDOMAIN` and
   `ACCESS_OWNER_EMAIL` to this repository's `production` environment.
2. In the same Cloudflare account, confirm Zero Trust has a
   [Cloudflare identity provider](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/cloudflare/).
   New Zero Trust organizations include it by default. Reuse the existing provider;
   this app does not create, replace or change account login methods. If there is
   more than one Cloudflare provider, set the optional `ACCESS_CLOUDFLARE_IDP_ID`
   production variable to the intended provider's ID. Missing or ambiguous
   providers stop the application plan. The configured owner must be able to
   authenticate through that provider.
3. Merge this application's OAuth change and wait for its normal deployment to
   succeed. Terraform creates the Access application before binding its audience
   into the Worker. Only the OAuth path is protected, leaving phone endpoints and
   existing token clients available. Deployment configuration remains in
   [the workflow](../.github/workflows/deploy.yml).
4. Update the **existing private MacroFactor Data plugin** from
   [`plugins/macrofactor-data`](../plugins/macrofactor-data), preserving its plugin ID
   and audience. This repository's deployment does not publish account plugins.
   Publish the package only after the backend is deployed; update any generated
   compatibility manifests too. The new release uses OAuth client registration,
   with no embedded token or OAuth client secret.
5. Choose **Connect**, sign in as the allowed owner, and call `data_status` through
   Codex. Confirm actual counts and dates, including an empty dataset if applicable.
   Also check that another identity is denied and a normal phone update still
   succeeds. Local runtime tests simulate a verified Access identity; they do not
   establish that browser login, discovery, token refresh or Codex works live.

Cloudflare owns OAuth discovery, authorization, token exchange and refresh.
The callback allowlist and session lifetimes live in the Access resource; see
[Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
and [OpenAI's callback requirements](https://developers.openai.com/plugins/build/auth).
Do not add a broad bypass policy to make login work.

## Existing clients and recovery

During the transition, `/mcp` accepts `MCP_TOKEN` as an `Authorization: Bearer`
header, and `/mcp/<MCP_TOKEN>` supports existing URL-token clients. The complete
URL is a secret. Enter credentials only in private client settings. Neither token
method authenticates `/mcp/oauth`.

Keep the current `MCP_TOKEN` and previous plugin release until the real OAuth
read succeeds. If activation fails, continue using the existing token connection
while checking the failed layer: Access policy/login, OAuth discovery/callbacks,
or the Worker's audience and owner bindings. A public health response is not an
authentication check. Restoring the previous plugin package restores its token
connection without changing phone credentials or database contents.

Retiring the token is a follow-up after live verification: move every remaining
MCP client to OAuth, remove both legacy routes and their Terraform/workflow
bindings, then remove the obsolete GitHub secret. Deleting the secret first makes
deployment fail; deleting only the Worker binding would be restored by Terraform.
An absent token already fails closed in the Worker. Never remove `INGEST_SECRET`
as part of MCP token retirement.

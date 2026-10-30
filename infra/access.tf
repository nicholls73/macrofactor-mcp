# Reuse the account's Cloudflare login provider; account identity configuration
# belongs to Zero Trust, not to this application's lifecycle.
data "cloudflare_zero_trust_access_identity_providers" "account" {
  count      = var.access_cloudflare_idp_id == "" ? 1 : 0
  account_id = var.account_id
}

data "cloudflare_zero_trust_access_identity_provider" "selected" {
  count                = var.access_cloudflare_idp_id == "" ? 0 : 1
  account_id           = var.account_id
  identity_provider_id = var.access_cloudflare_idp_id
}

locals {
  access_idps        = var.access_cloudflare_idp_id == "" ? data.cloudflare_zero_trust_access_identity_providers.account[0].result : data.cloudflare_zero_trust_access_identity_provider.selected
  cloudflare_idp_ids = [for idp in local.access_idps : idp.id if idp.type == "cloudflare"]
  oauth_domain       = "${var.worker_name}.${var.workers_subdomain}.workers.dev/mcp/oauth"
}

resource "cloudflare_zero_trust_access_application" "mcp" {
  account_id                = var.account_id
  name                      = "${var.worker_name} OAuth"
  type                      = "self_hosted"
  domain                    = local.oauth_domain
  destinations              = [{ type = "public", uri = local.oauth_domain }]
  app_launcher_visible      = false
  auto_redirect_to_identity = true
  allowed_idps              = local.cloudflare_idp_ids
  session_duration          = "24h"

  policies = [{
    name       = "MacroFactor owner"
    decision   = "allow"
    precedence = 1
    include    = [{ email = { email = lower(var.access_owner_email) } }]
    require    = [for id in local.cloudflare_idp_ids : { login_method = { id = id } }]
  }]

  oauth_configuration = {
    enabled = true
    dynamic_client_registration = {
      enabled                = true
      allow_any_on_localhost = true
      allow_any_on_loopback  = true
      allowed_uris = [
        "https://chatgpt.com/connector_platform_oauth_redirect",
        "https://chatgpt.com/connector/oauth/*",
      ]
    }
    grant = {
      access_token_lifetime = "15m"
      session_duration      = "168h"
    }
  }

  lifecycle {
    precondition {
      condition     = length(local.cloudflare_idp_ids) == 1
      error_message = "Configure a Cloudflare identity provider in Zero Trust. If there are several, select one with access_cloudflare_idp_id. Existing identity providers are never created or replaced here."
    }
  }
}

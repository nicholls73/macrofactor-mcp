mock_provider "cloudflare" {
  mock_data "cloudflare_zero_trust_access_identity_provider" {
    defaults = { id = "11111111-1111-4111-8111-111111111111", type = "cloudflare" }
  }
}

variables {
  account_id               = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  ingest_secret            = "test-only-ingest-secret-0000000000"
  mcp_token                = "test-only-mcp-token-00000000000000"
  workers_subdomain        = "test-account"
  access_owner_email       = "owner@example.com"
  access_cloudflare_idp_id = "11111111-1111-4111-8111-111111111111"
}

run "migration_stage" {
  command = plan
  plan_options {
    target = [terraform_data.schema]
  }
  variables {
    bootstrap_durable_objects = true
  }
  assert {
    condition     = cloudflare_d1_database.data.name == var.database_name
    error_message = "The migration stage must include D1 creation for a new installation."
  }
}

run "normal_deployment" {
  command = plan
  assert {
    condition = alltrue([for source in ["migrations/0001_initial_schema.sql", "migrations/0002_food_log_nutrients.sql", "scripts/migrate.mjs", "package-lock.json"] :
      contains(slice(terraform_data.schema.triggers_replace, 1, length(terraform_data.schema.triggers_replace)), filesha256("${path.module}/../${source}"))
    ])
    error_message = "Changing SQL, the migration adapter or Wrangler's locked version must rerun migrations before the Worker update."
  }
  assert {
    condition     = try(cloudflare_d1_database.data.read_replication.mode == "disabled", false)
    error_message = "D1 updates require an explicit read replication object; the API rejects null."
  }
  assert {
    condition     = cloudflare_workers_script.mcp.migrations == null
    error_message = "Normal deployments must not replay Durable Object creation."
  }
  assert {
    condition     = length(cloudflare_workers_script.mcp.bindings) == 7
    error_message = "Bind D1, both Durable Objects, both secrets, and the Access audience and owner."
  }
  assert {
    condition     = cloudflare_workers_script_subdomain.mcp.enabled && !cloudflare_workers_script_subdomain.mcp.previews_enabled
    error_message = "Enable the main endpoint, not preview URLs."
  }
  assert {
    condition = cloudflare_zero_trust_access_application.mcp.domain == "macrofactor-mcp.test-account.workers.dev/mcp/oauth" && (
      length(cloudflare_zero_trust_access_application.mcp.destinations) == 1 &&
      one(cloudflare_zero_trust_access_application.mcp.destinations).type == "public" &&
      one(cloudflare_zero_trust_access_application.mcp.destinations).uri == "macrofactor-mcp.test-account.workers.dev/mcp/oauth"
    )
    error_message = "Access must cover only the OAuth endpoint, leaving token clients and iPhone routes available."
  }
  assert {
    condition = length(cloudflare_zero_trust_access_application.mcp.policies) == 1 && (
      cloudflare_zero_trust_access_application.mcp.policies[0].decision == "allow" &&
      one(cloudflare_zero_trust_access_application.mcp.policies[0].include).email.email == "owner@example.com" &&
      one(cloudflare_zero_trust_access_application.mcp.policies[0].require).login_method.id == "11111111-1111-4111-8111-111111111111" &&
      cloudflare_zero_trust_access_application.mcp.allowed_idps == toset(["11111111-1111-4111-8111-111111111111"])
    )
    error_message = "Only the selected owner's Cloudflare login may pass Access."
  }
  assert {
    condition = cloudflare_zero_trust_access_application.mcp.oauth_configuration.enabled && (
      cloudflare_zero_trust_access_application.mcp.oauth_configuration.dynamic_client_registration.enabled &&
      cloudflare_zero_trust_access_application.mcp.oauth_configuration.dynamic_client_registration.allow_any_on_localhost &&
      cloudflare_zero_trust_access_application.mcp.oauth_configuration.dynamic_client_registration.allow_any_on_loopback &&
      cloudflare_zero_trust_access_application.mcp.oauth_configuration.dynamic_client_registration.allowed_uris == tolist([
        "https://chatgpt.com/connector_platform_oauth_redirect", "https://chatgpt.com/connector/oauth/*"
      ])
    )
    error_message = "OAuth registration must support Codex loopback and the documented ChatGPT callbacks, without a wildcard host."
  }
}

run "initial_deployment" {
  command = plan
  variables {
    bootstrap_durable_objects = true
  }
  assert {
    condition     = toset(cloudflare_workers_script.mcp.migrations.new_sqlite_classes) == toset(["MyMCP", "ImportDO"])
    error_message = "Bootstrap must create both SQLite Durable Object classes."
  }
}

run "reject_empty_authentication" {
  command = plan
  variables {
    mcp_token = ""
  }
  expect_failures = [var.mcp_token]
}

run "reject_missing_cloudflare_idp" {
  command = plan
  variables {
    access_cloudflare_idp_id = ""
  }
  expect_failures = [cloudflare_zero_trust_access_application.mcp]
}

run "reject_non_cloudflare_idp" {
  command = plan
  override_data {
    target = data.cloudflare_zero_trust_access_identity_provider.selected[0]
    values = { id = "11111111-1111-4111-8111-111111111111", type = "google" }
  }
  expect_failures = [cloudflare_zero_trust_access_application.mcp]
}

run "reject_invalid_owner" {
  command = plan
  variables {
    access_owner_email = ""
  }
  expect_failures = [var.access_owner_email]
}

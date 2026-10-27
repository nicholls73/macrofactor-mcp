mock_provider "cloudflare" {}

variables {
  account_id    = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  ingest_secret = "test-only-ingest-secret-0000000000"
  mcp_token     = "test-only-mcp-token-00000000000000"
}

run "normal_deployment" {
  command = plan
  assert {
    condition     = try(cloudflare_d1_database.data.read_replication.mode == "disabled", false)
    error_message = "D1 updates require an explicit read replication object; the API rejects null."
  }
  assert {
    condition     = cloudflare_workers_script.mcp.migrations == null
    error_message = "Normal deployments must not replay Durable Object creation."
  }
  assert {
    condition     = length(cloudflare_workers_script.mcp.bindings) == 5
    error_message = "D1, both Durable Objects and both authentication secrets must be bound."
  }
  assert {
    condition     = cloudflare_workers_script_subdomain.mcp.enabled && !cloudflare_workers_script_subdomain.mcp.previews_enabled
    error_message = "Enable the main endpoint, not preview URLs."
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

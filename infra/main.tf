terraform {
  required_version = ">= 1.7, < 2.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.27.0"
    }
  }
}

# Authentication comes from CLOUDFLARE_API_TOKEN, including the schema helper.
provider "cloudflare" {}

resource "cloudflare_d1_database" "data" {
  account_id = var.account_id
  name       = var.database_name

  lifecycle {
    prevent_destroy = true
  }
}

resource "terraform_data" "schema" {
  triggers_replace = [
    cloudflare_d1_database.data.id,
    filesha256("${path.module}/../schema.sql"),
    filesha256("${path.module}/../scripts/schema.mjs"),
  ]

  provisioner "local-exec" {
    working_dir = "${path.module}/.."
    command     = "node scripts/schema.mjs"
    environment = {
      CF_ACCOUNT_ID  = var.account_id
      CF_DATABASE_ID = cloudflare_d1_database.data.id
    }
  }
}

resource "cloudflare_workers_script" "mcp" {
  account_id          = var.account_id
  script_name         = var.worker_name
  main_module         = "worker.js"
  content_file        = "${path.module}/../dist/worker.js"
  content_sha256      = filesha256("${path.module}/../dist/worker.js")
  compatibility_date  = local.runtime.compatibility_date
  compatibility_flags = local.runtime.compatibility_flags

  bindings = concat(
    [{ name = "DB", type = "d1", id = cloudflare_d1_database.data.id }],
    [for name, class_name in local.runtime.durable_objects : {
      name = name, type = "durable_object_namespace", class_name = class_name
    }],
    [for name, value in merge({
      INGEST_SECRET = var.ingest_secret
      MCP_TOKEN     = var.mcp_token
      }, var.pushcut_webhooks) : {
      name = name, type = "secret_text", text = value
    }],
  )

  # Creation migrations are a one-time operation, never part of normal code updates.
  migrations = var.bootstrap_durable_objects ? {
    new_tag            = "v2"
    new_sqlite_classes = values(local.runtime.durable_objects)
  } : null

  observability = { enabled = true }
  depends_on    = [terraform_data.schema]

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_workers_script_subdomain" "mcp" {
  account_id       = var.account_id
  script_name      = cloudflare_workers_script.mcp.script_name
  enabled          = true
  previews_enabled = false
}

resource "cloudflare_workers_cron_trigger" "prs" {
  account_id  = var.account_id
  script_name = cloudflare_workers_script.mcp.script_name
  schedules   = [{ cron = "0 8 * * *" }]
}

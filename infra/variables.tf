variable "account_id" {
  type        = string
  description = "Cloudflare account ID."
  validation {
    condition     = can(regex("^[a-f0-9]{32}$", var.account_id))
    error_message = "account_id must be a 32-character Cloudflare account ID."
  }
}

variable "worker_name" {
  type    = string
  default = "macrofactor-mcp"
}

variable "database_name" {
  type    = string
  default = "macrofactor"
}

variable "workers_subdomain" {
  type        = string
  description = "Existing account subdomain before .workers.dev; used to scope Access to the MCP OAuth endpoint."
  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?$", var.workers_subdomain))
    error_message = "workers_subdomain must be the account's workers.dev subdomain without a scheme, path or suffix."
  }
}

variable "access_owner_email" {
  type        = string
  description = "Only this Cloudflare sign-in identity can access MCP through OAuth."
  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.access_owner_email))
    error_message = "access_owner_email must be one email address, without whitespace."
  }
}

variable "access_cloudflare_idp_id" {
  type        = string
  default     = ""
  description = "Optional existing Cloudflare identity provider ID when auto-discovery would be ambiguous."
  validation {
    condition     = var.access_cloudflare_idp_id == "" || can(regex("^([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$", var.access_cloudflare_idp_id))
    error_message = "access_cloudflare_idp_id must be an existing provider ID, or empty for auto-discovery."
  }
}

variable "ingest_secret" {
  type        = string
  sensitive   = true
  description = "Shared secret for imports and iPhone Shortcuts."
  validation {
    condition     = length(trimspace(var.ingest_secret)) >= 32
    error_message = "Use a random INGEST_SECRET of at least 32 characters."
  }
}

variable "mcp_token" {
  type        = string
  sensitive   = true
  description = "Transition credential for existing MCP clients; retain until live OAuth verification succeeds."
  validation {
    condition     = can(regex("^[A-Za-z0-9_-]{32,}$", var.mcp_token))
    error_message = "Use a random URL-safe MCP_TOKEN of at least 32 characters."
  }
}

variable "pushcut_webhooks" {
  type        = map(string)
  sensitive   = true
  default     = {}
  description = "Optional Pushcut secret bindings for the iPhone actions."
  validation {
    condition = alltrue([for name, url in var.pushcut_webhooks :
      contains([
        "PUSHCUT_WEBHOOK_URL", "PUSHCUT_WATER_WEBHOOK_URL",
        "PUSHCUT_WEIGHT_WEBHOOK_URL", "PUSHCUT_BATCH_WEBHOOK_URL",
        "PUSHCUT_PR_WEBHOOK_URL"
      ], name) && startswith(url, "https://")
    ])
    error_message = "Only the five supported PUSHCUT_* webhook bindings with HTTPS URLs are accepted."
  }
}

variable "bootstrap_durable_objects" {
  type        = bool
  default     = false
  description = "Set true ONLY for the first deployment of a new Worker; omit on all subsequent plans/applies."
}

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
  description = "Required token protecting /mcp/<token>."
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

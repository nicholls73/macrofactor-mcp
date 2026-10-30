output "worker_name" {
  value = cloudflare_workers_script.mcp.script_name
}

output "database_id" {
  value = cloudflare_d1_database.data.id
}

output "oauth_mcp_url" {
  value = "https://${local.oauth_domain}"
}

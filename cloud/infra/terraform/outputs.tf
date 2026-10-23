output "name_servers" {
  description = "Add these as NS records for the 'cloud' host of trina.app at Gabia (delegation of var.domain)."
  value       = aws_route53_zone.cloud.name_servers
}

output "route53_zone_id" {
  value = aws_route53_zone.cloud.zone_id
}

output "control_public_ip" {
  value = aws_eip.control.public_ip
}

output "host_elastic_ips" {
  value = aws_eip.hosts[*].public_ip
}

output "ecr_repositories" {
  value = { for k, r in aws_ecr_repository.repo : k => r.repository_url }
}

output "backup_bucket" {
  value = aws_s3_bucket.backups.id
}

output "kms_key_alias" {
  value = aws_kms_alias.main.name
}

output "ses_dkim_records" {
  description = "Three CNAMEs to add at Gabia for SES DKIM on mail_domain."
  value = var.manage_ses_identity ? [
    for t in aws_sesv2_email_identity.mail[0].dkim_signing_attributes[0].tokens :
    "${t}._domainkey.${var.mail_domain}  CNAME  ${t}.dkim.amazonses.com"
  ] : []
}

output "control_env_template" {
  description = "Non-secret part of the control plane's env file. Add the secrets and store the whole file as the SecureString parameter named here (README, step 6)."
  value       = <<-EOT
    # aws ssm put-parameter --type SecureString --key-id ${aws_kms_alias.main.name} --name ${local.ssm_control_env} --value file://control.env --overwrite
    TDCLOUD_ENV=production
    TDCLOUD_DOMAIN=${var.domain}
    TDCLOUD_CONTROL_URL=https://${var.domain}
    TDCLOUD_DRIVER=aws
    TDCLOUD_IMAGE=${local.images.trina}
    TDCLOUD_HELPER_IMAGE=${local.images.control}
    TDCLOUD_CADDY_CONTAINER=tdc-caddy
    TDCLOUD_MAILER=ses
    TDCLOUD_MAIL_FROM=Trina Cloud <cloud@${var.mail_domain}>
    TDCLOUD_OPS_EMAIL=${var.acme_email}
    TDCLOUD_KMS_KEY_ID=${aws_kms_alias.main.name}
    TDCLOUD_BACKUP_TARGET=s3://${aws_s3_bucket.backups.id}
    TDCLOUD_BACKUP_KEEP=7
    TDCLOUD_MAX_TEAMS_PER_HOST=20
    TDCLOUD_ROUTE53_ZONE_ID=${aws_route53_zone.cloud.zone_id}
    TDCLOUD_SSM_PREFIX=/${var.name}
    AWS_REGION=${var.region}
    PADDLE_ENV=live
    PADDLE_CHECK_IP=1
    # secrets (fill in):
    TDCLOUD_CADDY_ASK_KEY=<same value as the ${local.ssm_ask_key} parameter>
    PADDLE_WEBHOOK_SECRET=<Paddle → Developer tools → Notifications → the control plane destination's secret>
    PADDLE_CLIENT_TOKEN=<Paddle client-side token (live_…)>
    PADDLE_PRICE_TEAM_MONTHLY=<pri_…>
    PADDLE_PRICE_TEAM_YEARLY=<pri_…>
    PADDLE_PRICE_BUSINESS_MONTHLY=<pri_…>
    PADDLE_PRICE_BUSINESS_YEARLY=<pri_…>
  EOT
}

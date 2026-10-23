# Mail from the control plane (email confirmation, the one-time setup link, billing notices) and from the teams (through
# each host's relay) through SES. With the mail domain inside the Route 53 zone (the default: mail_domain = domain) the
# DKIM CNAMEs are added here and the identity verifies itself once Gabia delegates the zone; another domain needs the
# CNAMEs from outputs.ses_dkim_records in its own DNS. Then request production access (SES starts in the sandbox: only
# verified recipients).
resource "aws_sesv2_email_identity" "mail" {
  count          = var.manage_ses_identity ? 1 : 0
  email_identity = local.mail_domain
}

resource "aws_route53_record" "dkim" {
  count   = var.manage_ses_identity && local.mail_in_zone ? 3 : 0
  zone_id = aws_route53_zone.cloud.zone_id
  name    = "${aws_sesv2_email_identity.mail[0].dkim_signing_attributes[0].tokens[count.index]}._domainkey.${local.mail_domain}"
  type    = "CNAME"
  ttl     = 1800
  records = ["${aws_sesv2_email_identity.mail[0].dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

# DMARC for the mail domain: DKIM (above) aligns; reports to the contact address
resource "aws_route53_record" "dmarc" {
  count   = var.manage_ses_identity && local.mail_in_zone ? 1 : 0
  zone_id = aws_route53_zone.cloud.zone_id
  name    = "_dmarc.${local.mail_domain}"
  type    = "TXT"
  ttl     = 3600
  records = ["v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:${var.acme_email}"]
}

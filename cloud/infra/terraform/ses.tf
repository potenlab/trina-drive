# Mail from the control plane (email confirmation, the one-time setup link, billing notices) through SES. trina.app's
# DNS is at Gabia: add the three DKIM CNAMEs from outputs.ses_dkim_records there, then request production access
# (SES starts in the sandbox: only verified recipients).
resource "aws_sesv2_email_identity" "mail" {
  count          = var.manage_ses_identity ? 1 : 0
  email_identity = var.mail_domain
}

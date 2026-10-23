# A zone of its own for the cloud domain (cloud.trina.app), delegated from trina.app at Gabia with four NS records
# (outputs.name_servers). The control plane adds one A record per team (→ its host's Elastic IP) as teams are created.
resource "aws_route53_zone" "cloud" {
  name    = var.domain
  comment = "Trina Cloud teams (records per team are managed by the control plane)"
}

resource "aws_route53_record" "control" {
  zone_id = aws_route53_zone.cloud.zone_id
  name    = var.domain
  type    = "A"
  ttl     = 300
  records = [aws_eip.control.public_ip]
}

# only Let's Encrypt may issue certificates for these names
resource "aws_route53_record" "caa" {
  zone_id = aws_route53_zone.cloud.zone_id
  name    = var.domain
  type    = "CAA"
  ttl     = 3600
  records = ["0 issue \"letsencrypt.org\"", "0 issuewild \"letsencrypt.org\"", "0 iodef \"mailto:${var.acme_email}\""]
}

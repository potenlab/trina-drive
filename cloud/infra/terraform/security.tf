# Only 80 and 443 are public. No SSH anywhere (operators use SSM Session Manager). The control plane's port 8790 is
# open only to the team hosts (Caddy's on-demand TLS `ask`).
resource "aws_security_group" "hosts" {
  name        = "${var.name}-hosts"
  description = "Trina Cloud team hosts: HTTPS (and HTTP for ACME / redirects) only"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.name}-hosts" }
}

resource "aws_security_group" "control" {
  name        = "${var.name}-control"
  description = "Trina Cloud control plane: HTTPS public, 8790 from the hosts only"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.name}-control" }
}

resource "aws_vpc_security_group_ingress_rule" "web" {
  for_each = {
    hosts-80    = { sg = aws_security_group.hosts.id, port = 80 }
    hosts-443   = { sg = aws_security_group.hosts.id, port = 443 }
    control-80  = { sg = aws_security_group.control.id, port = 80 }
    control-443 = { sg = aws_security_group.control.id, port = 443 }
  }
  security_group_id = each.value.sg
  ip_protocol       = "tcp"
  from_port         = each.value.port
  to_port           = each.value.port
  cidr_ipv4         = "0.0.0.0/0"
  description       = "public web"
}

resource "aws_vpc_security_group_ingress_rule" "ask" {
  security_group_id            = aws_security_group.control.id
  referenced_security_group_id = aws_security_group.hosts.id
  ip_protocol                  = "tcp"
  from_port                    = 8790
  to_port                      = 8790
  description                  = "Caddy on the hosts asks the control plane before issuing a certificate"
}

resource "aws_vpc_security_group_egress_rule" "all" {
  for_each          = { hosts = aws_security_group.hosts.id, control = aws_security_group.control.id }
  security_group_id = each.value
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
  description       = "updates, image pulls, AWS APIs, Let's Encrypt, OAuth client metadata"
}

# The control plane: one small instance (the control container + Caddy for https://<domain>). Its SQLite database is
# on the encrypted root volume and copied to the backup bucket every night. It is stateless enough to rebuild from
# that copy; a second instance is not needed at this size.
resource "aws_instance" "control" {
  ami                    = data.aws_ssm_parameter.ubuntu.value
  instance_type          = var.control_instance_type
  subnet_id              = aws_subnet.public[0].id
  vpc_security_group_ids = [aws_security_group.control.id]
  iam_instance_profile   = aws_iam_instance_profile.control.name

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_size = 30
    volume_type = "gp3"
    encrypted   = true
    kms_key_id  = aws_kms_key.main.arn
  }

  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    role               = "control"
    region             = var.region
    artifacts_bucket   = aws_s3_bucket.artifacts.id
    backup_bucket      = aws_s3_bucket.backups.id
    ecr_registry       = local.ecr_registry
    trina_image        = local.images.trina
    control_image      = local.images.control
    caddy_image        = local.images.caddy
    domain             = var.domain
    acme_email         = var.acme_email
    vpc_cidr           = var.vpc_cidr
    control_private_ip = ""
    control_env_param  = local.ssm_control_env
    ask_key_param      = local.ssm_ask_key
    team_mail_from     = local.team_mail_from
    mail_upstream      = var.mail_upstream
    mail_key_param     = local.ssm_control_mail_key
    team_subnets       = var.team_subnets
    front_proxies      = join(" ", var.front_proxies)
    office_cidrs       = join(" ", var.office_cidrs)
  })
  user_data_replace_on_change = false

  tags       = { Name = "${var.name}-control", "tdcloud:role" = "control" }
  depends_on = [aws_s3_object.artifacts]

  # user data runs on the first boot only: a change (e.g. a new control_image_tag) would just stop and start the
  # instance without running it again. A running instance gets new image tags in /etc/tdcloud/host.conf and a rerun
  # of /usr/local/sbin/tdcloud-bootstrap (README, Operations).
  lifecycle {
    ignore_changes = [ami, user_data]
  }
}

resource "aws_eip" "control" {
  domain   = "vpc"
  instance = aws_instance.control.id
  tags     = { Name = "${var.name}-control" }
}

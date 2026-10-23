# The team host pool: a launch template and an Auto Scaling group of fixed size (host_count). Hosts are long-lived
# (teams' data is on them): scale-in protection is on and the ASG only replaces a host that AWS reports dead. To add
# capacity raise host_count; the control plane puts new teams on the least-loaded host.
#
# Each host: Ubuntu 24.04 arm64, IMDSv2 only with hop limit 1 (containers on Docker bridges cannot reach the instance
# role), root and data volumes encrypted with the KMS key, the data volume kept if the instance is terminated.
resource "aws_eip" "hosts" {
  count  = var.host_count
  domain = "vpc"
  tags   = { Name = "${var.name}-host-${count.index}", "tdcloud:pool" = "hosts" }
}

resource "aws_launch_template" "host" {
  name_prefix            = "${var.name}-host-"
  image_id               = data.aws_ssm_parameter.ubuntu.value
  instance_type          = var.host_instance_type
  update_default_version = true
  vpc_security_group_ids = [aws_security_group.hosts.id]

  iam_instance_profile {
    arn = aws_iam_instance_profile.host.arn
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  block_device_mappings {
    device_name = "/dev/sda1"
    ebs {
      volume_size           = 30
      volume_type           = "gp3"
      encrypted             = true
      kms_key_id            = aws_kms_key.main.arn
      delete_on_termination = true
    }
  }

  # team data (XFS, project quotas): /srv/tdcloud
  block_device_mappings {
    device_name = "/dev/sdf"
    ebs {
      volume_size           = var.host_data_gb
      volume_type           = "gp3"
      encrypted             = true
      kms_key_id            = aws_kms_key.main.arn
      delete_on_termination = false
    }
  }

  user_data = base64encode(templatefile("${path.module}/user-data.sh.tftpl", {
    role               = "host"
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
    control_private_ip = aws_instance.control.private_ip
    control_env_param  = local.ssm_control_env
    ask_key_param      = local.ssm_ask_key
    team_mail_from     = local.team_mail_from
    team_subnets       = var.team_subnets
    front_proxies      = join(" ", var.front_proxies)
  }))

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${var.name}-host", "tdcloud:role" = "host" }
  }
  tag_specifications {
    resource_type = "volume"
    tags          = { Name = "${var.name}-host", "tdcloud:role" = "host" }
  }

  depends_on = [aws_s3_object.artifacts]
}

resource "aws_autoscaling_group" "hosts" {
  name                  = "${var.name}-hosts"
  min_size              = var.host_count
  max_size              = var.host_count
  desired_capacity      = var.host_count
  vpc_zone_identifier   = aws_subnet.public[*].id
  health_check_type     = "EC2"
  protect_from_scale_in = true

  launch_template {
    id      = aws_launch_template.host.id
    version = "$Latest"
  }

  tag {
    key                 = "tdcloud:role"
    value               = "host"
    propagate_at_launch = true
  }

  depends_on = [aws_iam_service_linked_role.autoscaling, aws_eip.hosts]
}

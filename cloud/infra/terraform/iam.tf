# Least privilege. Hosts: run what SSM tells them, pull images, read their boot files, read team env parameters, upload
# backups, take an Elastic IP from the pool. Control: send commands to hosts only, manage team parameters and DNS
# records, wrap keys, read/prune backups, send mail.
data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

locals {
  ecr_arns = [for r in aws_ecr_repository.repo : r.arn]
  param    = "arn:${local.partition}:ssm:${var.region}:${local.account}:parameter"
}

# ---------- hosts
resource "aws_iam_role" "host" {
  name               = "${var.name}-host"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "host_ssm" {
  role       = aws_iam_role.host.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "host" {
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid       = "EcrPull"
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
    resources = local.ecr_arns
  }
  statement {
    sid       = "BootFiles"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/*"]
  }
  statement {
    sid       = "ShipBackups"
    actions   = ["s3:PutObject", "s3:AbortMultipartUpload"]
    resources = ["${aws_s3_bucket.backups.arn}/teams/*"]
  }
  statement {
    sid       = "TeamEnv"
    actions   = ["ssm:GetParameter"]
    resources = ["${local.param}${local.ssm_teams}/*", "${local.param}${local.ssm_ask_key}"]
  }
  statement {
    sid       = "KeyViaServices"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.main.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${var.region}.amazonaws.com", "ssm.${var.region}.amazonaws.com", "ecr.${var.region}.amazonaws.com"]
    }
  }
  statement {
    sid       = "FindAddress"
    actions   = ["ec2:DescribeAddresses"]
    resources = ["*"]
  }
  statement {
    sid       = "TakePoolAddress"
    actions   = ["ec2:AssociateAddress"]
    resources = ["arn:${local.partition}:ec2:${var.region}:${local.account}:elastic-ip/*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/tdcloud:pool"
      values   = ["hosts"]
    }
  }
  statement {
    sid       = "ToHostInstances"
    actions   = ["ec2:AssociateAddress"]
    resources = ["arn:${local.partition}:ec2:${var.region}:${local.account}:instance/*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/tdcloud:role"
      values   = ["host"]
    }
  }
  statement {
    sid       = "AddressInterface"
    actions   = ["ec2:AssociateAddress"]
    resources = ["arn:${local.partition}:ec2:${var.region}:${local.account}:network-interface/*"]
  }
}

resource "aws_iam_role_policy" "host" {
  role   = aws_iam_role.host.id
  policy = data.aws_iam_policy_document.host.json
}

resource "aws_iam_instance_profile" "host" {
  name = "${var.name}-host"
  role = aws_iam_role.host.name
}

# ---------- control plane
resource "aws_iam_role" "control" {
  name               = "${var.name}-control"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "control_ssm" {
  role       = aws_iam_role.control.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "control" {
  statement {
    sid       = "RunOnHostsOnly"
    actions   = ["ssm:SendCommand"]
    resources = ["arn:${local.partition}:ec2:${var.region}:${local.account}:instance/*"]
    condition {
      test     = "StringEquals"
      variable = "ssm:resourceTag/tdcloud:role"
      values   = ["host"]
    }
  }
  statement {
    sid       = "ShellDocumentOnly"
    actions   = ["ssm:SendCommand"]
    resources = ["arn:${local.partition}:ssm:${var.region}::document/AWS-RunShellScript"]
  }
  statement {
    sid       = "CommandResults"
    actions   = ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations", "ssm:DescribeInstanceInformation"]
    resources = ["*"]
  }
  statement {
    sid       = "TeamParameters"
    actions   = ["ssm:PutParameter", "ssm:DeleteParameter", "ssm:GetParameter"]
    resources = ["${local.param}${local.ssm_teams}/*"]
  }
  statement {
    sid       = "OwnConfig"
    actions   = ["ssm:GetParameter"]
    resources = ["${local.param}${local.ssm_control_env}", "${local.param}${local.ssm_ask_key}"]
  }
  statement {
    sid       = "WrapKeys"
    actions   = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.main.arn]
  }
  statement {
    sid       = "TeamDns"
    actions   = ["route53:ChangeResourceRecordSets", "route53:ListResourceRecordSets"]
    resources = [aws_route53_zone.cloud.arn]
  }
  statement {
    sid       = "Backups"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.backups.arn}/*"]
  }
  statement {
    sid       = "BackupsList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.backups.arn]
  }
  statement {
    sid       = "Mail"
    actions   = ["ses:SendEmail"]
    resources = ["arn:${local.partition}:ses:${var.region}:${local.account}:identity/${var.mail_domain}"]
  }
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid       = "EcrPull"
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
    resources = local.ecr_arns
  }
  statement {
    sid       = "BootFiles"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/*"]
  }
}

resource "aws_iam_role_policy" "control" {
  role   = aws_iam_role.control.id
  policy = data.aws_iam_policy_document.control.json
}

resource "aws_iam_instance_profile" "control" {
  name = "${var.name}-control"
  role = aws_iam_role.control.name
}

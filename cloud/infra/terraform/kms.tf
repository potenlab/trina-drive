# One customer-managed key for everything at rest: EBS volumes, the backup and artifacts buckets, SSM SecureStrings,
# ECR, and the control plane's wrapping of each team's backup keys (encryption context = the team).
resource "aws_iam_service_linked_role" "autoscaling" {
  count            = var.create_autoscaling_service_linked_role ? 1 : 0
  aws_service_name = "autoscaling.amazonaws.com"
}

data "aws_iam_policy_document" "kms" {
  statement {
    sid       = "AccountAdmin"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account}:root"]
    }
  }
  # principals that administer the key through the key policy itself (KMS refuses a key policy its creator could not
  # change later: a deploy identity without kms:PutKeyPolicy in IAM must be listed here)
  dynamic "statement" {
    for_each = length(var.kms_admin_arns) > 0 ? [1] : []
    content {
      sid       = "KeyAdmins"
      actions   = ["kms:*"]
      resources = ["*"]
      principals {
        type        = "AWS"
        identifiers = var.kms_admin_arns
      }
    }
  }
  # the ASG launches instances with volumes encrypted under this key
  statement {
    sid       = "AutoScalingUse"
    actions   = ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:DescribeKey"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account}:role/aws-service-role/autoscaling.amazonaws.com/AWSServiceRoleForAutoScaling"]
    }
  }
  statement {
    sid       = "AutoScalingGrants"
    actions   = ["kms:CreateGrant"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account}:role/aws-service-role/autoscaling.amazonaws.com/AWSServiceRoleForAutoScaling"]
    }
    condition {
      test     = "Bool"
      variable = "kms:GrantIsForAWSResource"
      values   = ["true"]
    }
  }
}

resource "aws_kms_key" "main" {
  description             = "Trina Cloud: EBS, S3, SSM, ECR and team backup keys"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.kms.json
  depends_on              = [aws_iam_service_linked_role.autoscaling]
}

resource "aws_kms_alias" "main" {
  name          = "alias/${var.name}"
  target_key_id = aws_kms_key.main.key_id
}

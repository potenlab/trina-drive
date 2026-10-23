# Buckets: backups (team archives, already encrypted per team; versioned; SSE-KMS), artifacts (host scripts and the
# bwrap security profiles the hosts download at boot), logs (VPC flow logs, S3 access logs). All private, TLS only.
locals {
  buckets = {
    backups   = "${var.name}-backups-${local.account}"
    artifacts = "${var.name}-artifacts-${local.account}"
    logs      = "${var.name}-logs-${local.account}"
  }
}

resource "aws_s3_bucket" "backups" {
  bucket = local.buckets.backups
}
resource "aws_s3_bucket" "artifacts" {
  bucket = local.buckets.artifacts
}
resource "aws_s3_bucket" "logs" {
  bucket = local.buckets.logs
}

locals {
  bucket_ids = {
    backups   = aws_s3_bucket.backups.id
    artifacts = aws_s3_bucket.artifacts.id
    logs      = aws_s3_bucket.logs.id
  }
}

resource "aws_s3_bucket_public_access_block" "all" {
  for_each                = local.bucket_ids
  bucket                  = each.value
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "all" {
  for_each = local.bucket_ids
  bucket   = each.value
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "all" {
  for_each = local.bucket_ids
  bucket   = each.value
  versioning_configuration {
    status = each.key == "logs" ? "Suspended" : "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "kms" {
  for_each = { backups = aws_s3_bucket.backups.id, artifacts = aws_s3_bucket.artifacts.id }
  bucket   = each.value
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.main.arn
    }
    bucket_key_enabled = true
  }
}

# log delivery (VPC flow logs) cannot write to SSE-KMS buckets with a customer key without extra grants: SSE-S3 here
resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# The control plane keeps the newest TDCLOUD_BACKUP_KEEP (7) daily backups per team and deletes older ones; a deleted
# object stays as a noncurrent version for 7 more days (accidental or malicious deletion window), then goes.
resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    id     = "old-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 7
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    id     = "expire"
    status = "Enabled"
    filter {}
    expiration {
      days = 90
    }
  }
}

resource "aws_s3_bucket_logging" "backups" {
  bucket        = aws_s3_bucket.backups.id
  target_bucket = aws_s3_bucket.logs.id
  target_prefix = "s3-access/backups/"
}

data "aws_iam_policy_document" "tls_only" {
  for_each = local.bucket_ids
  statement {
    sid       = "TLSOnly"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = ["arn:${local.partition}:s3:::${local.buckets[each.key]}", "arn:${local.partition}:s3:::${local.buckets[each.key]}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
  dynamic "statement" {
    for_each = each.key == "logs" ? [1] : []
    content {
      sid       = "LogDelivery"
      actions   = ["s3:PutObject"]
      resources = ["arn:${local.partition}:s3:::${local.buckets.logs}/*"]
      principals {
        type        = "Service"
        identifiers = ["delivery.logs.amazonaws.com", "logging.s3.amazonaws.com"]
      }
      condition {
        test     = "StringEquals"
        variable = "aws:SourceAccount"
        values   = [local.account]
      }
    }
  }
}

resource "aws_s3_bucket_policy" "all" {
  for_each   = local.bucket_ids
  bucket     = each.value
  policy     = data.aws_iam_policy_document.tls_only[each.key].json
  depends_on = [aws_s3_bucket_public_access_block.all]
}

# what the hosts download at boot (cloud/host/bootstrap.sh)
resource "aws_s3_object" "artifacts" {
  for_each = {
    "host/bootstrap.sh"                 = "${path.module}/../../host/bootstrap.sh"
    "host/tdcloud-host"                 = "${path.module}/../../host/tdcloud-host"
    "docker/seccomp-bwrap.json"         = "${path.module}/../../../docker/seccomp-bwrap.json"
    "docker/apparmor-trina-drive-bwrap" = "${path.module}/../../../docker/apparmor-trina-drive-bwrap"
  }
  bucket     = aws_s3_bucket.artifacts.id
  key        = each.key
  source     = each.value
  etag       = filemd5(each.value)
  kms_key_id = aws_kms_key.main.arn
}

// Backup targets. Every object is already encrypted before it gets here (the product archive to the product's backup
// key, the files to the team's sealed-backup key), so a target only stores bytes. Production: S3 with versioning,
// SSE-KMS by bucket default and public access blocked (cloud/infra/terraform/s3.tf); on AWS the hosts upload directly
// and this class is used to read objects back (export) and to prune. Dev: a directory.
import fs from 'node:fs'
import path from 'node:path'
import type { CredentialProvider } from './aws'

export interface BackupTarget {
  readonly description: string
  /** the S3 bucket, when objects are uploaded by the hosts themselves */
  readonly bucket: string | null
  /** key prefix inside the target (s3://bucket/<prefix>/...) */
  readonly prefix: string
  put(key: string, localFile: string): Promise<void>
  /** to a local file */
  get(key: string, localFile: string): Promise<void>
  delete(key: string): Promise<void>
}

export class DirTarget implements BackupTarget {
  readonly bucket = null
  readonly prefix = ''
  constructor(readonly root: string) { fs.mkdirSync(root, { recursive: true, mode: 0o700 }) }
  get description() { return `dir:${this.root}` }
  private file(key: string) {
    const p = path.resolve(this.root, key)
    if (!p.startsWith(path.resolve(this.root) + path.sep)) throw new Error(`bad key ${key}`)
    return p
  }
  async put(key: string, localFile: string) {
    const p = this.file(key)
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 })
    fs.copyFileSync(localFile, p)
    fs.chmodSync(p, 0o600)
  }
  async get(key: string, localFile: string) { fs.copyFileSync(this.file(key), localFile) }
  async delete(key: string) { fs.rmSync(this.file(key), { force: true }) }
}

export class S3Target implements BackupTarget {
  constructor(readonly bucket: string, readonly prefix: string, private readonly region: string, private readonly creds: CredentialProvider) {}
  get description() { return `s3://${this.bucket}/${this.prefix}` }
  private async client() {
    const c = await this.creds.get()
    return new Bun.S3Client({ bucket: this.bucket, region: this.region, accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken })
  }
  private k(key: string) { return this.prefix ? `${this.prefix}/${key}` : key }
  async put(key: string, localFile: string) { await (await this.client()).write(this.k(key), Bun.file(localFile)) }
  async get(key: string, localFile: string) { await Bun.write(localFile, (await this.client()).file(this.k(key))) }
  async delete(key: string) { await (await this.client()).delete(this.k(key)) }
}

export function parseTarget(spec: string, region: string, creds: CredentialProvider): BackupTarget {
  if (spec.startsWith('dir:')) return new DirTarget(path.resolve(spec.slice(4)))
  const m = /^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])(?:\/(.*))?$/.exec(spec)
  if (m) return new S3Target(m[1]!, (m[2] ?? '').replace(/^\/+|\/+$/g, ''), region, creds)
  throw new Error(`TDCLOUD_BACKUP_TARGET must be dir:/path or s3://bucket/prefix (got ${spec})`)
}

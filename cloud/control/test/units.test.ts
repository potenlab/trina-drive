import { describe, expect, test } from 'bun:test'
import { AwsClient, CredentialProvider, signV4 } from '../src/aws'
import { names, securityArgs, type Runner } from '../src/drivers/docker'
import { SsmRunner } from '../src/drivers/aws'
import { localDockerDriver, writeEnvFile } from '../src/drivers/local'
import { DockerDriver, type HostLayout } from '../src/drivers/docker'
import { LocalKeyWrapper } from '../src/keys'
import { paddleHeader, verifyPaddle } from '../src/paddle'
import { PLANS } from '../src/plans'
import { generateTeamKey, seal, unseal } from '../src/seal'
import { slugProblem, suggestSlug } from '../src/slug'
import { loadConfig, ConfigError } from '../src/config'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const it = async function* (...parts: Uint8Array[]) { for (const p of parts) yield p }
async function sealBytes(data: Uint8Array, pub: string) { const out: Buffer[] = []; await seal(it(data), (b) => { out.push(Buffer.from(b)) }, pub); return Buffer.concat(out) }
async function unsealBytes(data: Uint8Array, sec: string) { const out: Buffer[] = []; await unseal(it(data), (b) => { out.push(Buffer.from(b)) }, sec); return Buffer.concat(out) }

describe('seal', () => {
  test('round trip, empty input, multi-record input', async () => {
    const k = generateTeamKey()
    for (const size of [0, 1, 1024 * 1024, 2 * 1024 * 1024 + 7]) {
      const data = crypto.randomBytes(size)
      expect((await unsealBytes(await sealBytes(data, k.publicKey), k.secretKey)).equals(data)).toBe(true)
    }
  })
  test('a wrong key, a flipped bit, a cut-off file and a dropped record all fail', async () => {
    const k = generateTeamKey(), other = generateTeamKey()
    const data = crypto.randomBytes(2 * 1024 * 1024 + 10)
    const ct = await sealBytes(data, k.publicKey)
    await expect(unsealBytes(ct, other.secretKey)).rejects.toThrow()
    const flipped = Buffer.from(ct); flipped[ct.length - 40]! ^= 1
    await expect(unsealBytes(flipped, k.secretKey)).rejects.toThrow()
    // cut at a record boundary: the last record is missing
    const firstLen = ct.readUInt32BE(46)
    await expect(unsealBytes(ct.subarray(0, 46 + 4 + firstLen), k.secretKey)).rejects.toThrow(/truncated/)
  })
})

describe('keys', () => {
  test('local wrapping binds the context', async () => {
    const w = new LocalKeyWrapper(crypto.randomBytes(32))
    const c = await w.wrap(new TextEncoder().encode('secret'), { team: 'a' })
    expect(new TextDecoder().decode(await w.unwrap(c, { team: 'a' }))).toBe('secret')
    await expect(w.unwrap(c, { team: 'b' })).rejects.toThrow()
  })
  test('the master key file is created 0600 and refused when readable by others', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdk-'))
    const f = path.join(dir, 'm.key')
    LocalKeyWrapper.fromFile(f)
    expect(fs.statSync(f).mode & 0o777).toBe(0o600)
    fs.chmodSync(f, 0o644)
    expect(() => LocalKeyWrapper.fromFile(f)).toThrow(/chmod 600/)
    fs.rmSync(dir, { recursive: true })
  })
})

describe('paddle signatures', () => {
  test('valid, wrong secret, stale, rotated secrets (two h1)', () => {
    const body = '{"event_id":"evt_1"}'
    const now = Math.floor(Date.now() / 1000)
    expect(verifyPaddle({ rawBody: body, header: paddleHeader('s', body, now), secret: 's' }).ok).toBe(true)
    expect(verifyPaddle({ rawBody: body, header: paddleHeader('x', body, now), secret: 's' }).ok).toBe(false)
    expect(verifyPaddle({ rawBody: body + ' ', header: paddleHeader('s', body, now), secret: 's' }).ok).toBe(false)
    expect(verifyPaddle({ rawBody: body, header: paddleHeader('s', body, now - 10), secret: 's' }).ok).toBe(false)
    const two = `${paddleHeader('old', body, now)};h1=${paddleHeader('s', body, now).split('h1=')[1]}`
    expect(verifyPaddle({ rawBody: body, header: two, secret: 's' }).ok).toBe(true)
    expect(verifyPaddle({ rawBody: body, header: null, secret: 's' }).ok).toBe(false)
  })
})

describe('slugs and config', () => {
  test('slug rules', () => {
    expect(slugProblem('acme')).toBeNull()
    expect(slugProblem('acme-2')).toBeNull()
    for (const s of ['ab', 'a'.repeat(33), 'Acme', 'acme-', 'a--b', 'admin', 'xn--p1ai', 'a_b']) expect(slugProblem(s)).not.toBeNull()
    expect(suggestSlug('Acme Co., Ltd.')).toBe('acme-co-ltd')
  })
  test('production refuses the dev-only pieces', () => {
    expect(() => loadConfig({ TDCLOUD_ENV: 'production', TDCLOUD_DOMAIN: 'cloud.trina.app' })).toThrow(ConfigError)
    const ok = loadConfig({ TDCLOUD_ENV: 'production', TDCLOUD_DOMAIN: 'cloud.trina.app', TDCLOUD_MAILER: 'ses', TDCLOUD_KMS_KEY_ID: 'alias/x', PADDLE_WEBHOOK_SECRET: 's', TDCLOUD_CADDY_ASK_KEY: 'k', TDCLOUD_DRIVER: 'aws' })
    expect(ok.controlUrl).toBe('https://cloud.trina.app')
    expect(() => loadConfig({ TDCLOUD_DOMAIN: 'bad domain' })).toThrow(ConfigError)
  })
})

describe('docker commands for a team', () => {
  class Rec implements Runner {
    calls: string[][] = []
    async run(_h: string, argv: string[]) {
      this.calls.push(argv)
      const a = argv.join(' ')
      if (a.includes('inspect -f {{.State.Running}}')) return { code: 1, stdout: '', stderr: 'No such object' }
      if (a.includes('inspect -f')) return { code: 0, stdout: 'running healthy', stderr: '' }
      if (argv.includes('init')) return { code: 0, stdout: 'web setup token (one use, 7 days; ...):\ntdrive_setup_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345\n', stderr: '' }
      if (argv.includes('keygen')) return { code: 0, stdout: 'tdrive_bksec1_xyz\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
  }
  const layout: HostLayout = {
    seccomp: '/etc/s.json', apparmor: 'trina-drive-bwrap',
    dataMount: (s, ro) => `type=volume,src=tdc-data-${s},dst=/data${ro ? ',readonly' : ''}`, stagingMount: (s) => `type=bind,src=/st/${s},dst=/backup`, envFile: (s) => `/st/${s}.env`,
    prepare: async () => {}, cleanup: async () => {}, ship: async () => [], publicIp: async () => '198.51.100.7',
  }
  test('the container gets its own uid, network, limits and the bwrap settings; no ports, no docker socket', async () => {
    const rec = new Rec()
    const d = new DockerDriver({ name: 't', runner: rec, layout, caddyContainer: 'tdc-caddy', helperImage: 'h', pickHost: async () => 'x' })
    const spec = { slug: 'acme', number: 3, uid: 20003, url: 'https://acme.cloud.example.com', plan: PLANS.team, image: 'trina-drive:1', env: {} }
    const r = await d.create('x', spec)
    expect(r.setupToken).toBe('tdrive_setup_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')
    expect(r.productBackupSecret).toBe('tdrive_bksec1_xyz')
    const create = rec.calls.find((c) => c[1] === 'create')!
    const a = create.join(' ')
    for (const want of ['--user 20003:20003', '--network tdc-net-acme', '--read-only', '--cap-drop ALL', 'no-new-privileges:true', 'seccomp=/etc/s.json',
      'apparmor=trina-drive-bwrap', 'systempaths=unconfined', '--cpus 1', '--memory 2048m', '--memory-swap 2048m', '--pids-limit 512', '--env-file /st/acme.env',
      '--allow-origin https://acme.cloud.example.com', '--public-url https://acme.cloud.example.com']) expect(a).toContain(want)
    for (const never of ['-p', '--publish', 'docker.sock', '--privileged', '--cap-add']) expect(create).not.toContain(never)
    expect(a).not.toContain('docker.sock')
    // every one-shot runs without a network
    for (const c of rec.calls.filter((c) => c[1] === 'run')) expect(c.slice(0, 5)).toContain('none')
    expect(rec.calls.some((c) => c.join(' ') === 'docker network create --driver bridge --opt com.docker.network.bridge.name=tdcb3 --label tdcloud.team=acme --label tdcloud.number=3 tdc-net-acme')).toBe(true)
    expect(rec.calls.some((c) => c.join(' ') === 'docker network connect tdc-net-acme tdc-caddy')).toBe(true)
    expect(r.publicIp).toBe('198.51.100.7')
  })
  test('names and security args', () => {
    expect(names('acme', 12)).toEqual({ container: 'tdc-acme', network: 'tdc-net-acme', volume: 'tdc-data-acme', bridge: 'tdcb12' })
    expect(securityArgs({ seccomp: 's', apparmor: '' }, PLANS.business).join(' ')).not.toContain('apparmor')
    expect(localDockerDriver({ stateDir: '/x', seccomp: 's', apparmor: '', caddyContainer: 'c', helperImage: 'h' }).name).toBe('local')
  })
  test('env files are 0600 and refuse newlines', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tde-')), 'env')
    writeEnvFile(f, { TZ: 'UTC' })
    expect(fs.statSync(f).mode & 0o777).toBe(0o600)
    expect(() => writeEnvFile(f, { X: 'a\nB=1' })).toThrow()
  })
})

describe('AWS client (no network: fake endpoints)', () => {
  test('SigV4 matches the AWS test suite (get-vanilla)', () => {
    const h = signV4({ method: 'GET', url: 'https://example.amazonaws.com/', service: 'service', region: 'us-east-1', date: new Date('2015-08-30T12:36:00Z'),
      creds: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' } })
    expect(h.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31')
  })

  test('SSM: a secret output comes back sealed to a one-time key and is opened here', async () => {
    const seen: { target: string; body: Record<string, unknown> }[] = []
    let script = ''
    const fake = async (url: string, init?: RequestInit) => {
      const target = String((init?.headers as Record<string, string>)['x-amz-target'])
      const body = JSON.parse(String(init?.body))
      seen.push({ target, body })
      if (!(init?.headers as Record<string, string>).authorization?.startsWith('AWS4-HMAC-SHA256 ')) return new Response('unsigned', { status: 403 })
      if (target === 'AmazonSSM.SendCommand') { script = body.Parameters.commands[0]; return Response.json({ Command: { CommandId: 'c-1' } }) }
      // the "host": run the pipeline's seal step with the recipient from the script
      const rcpt = /--recipient '([^']+)'/.exec(script.replace(/'\\''/g, "'"))![1]!
      const sealed = await sealBytes(new TextEncoder().encode('tdrive_setup_SECRETSECRETSECRETSECRET\n'), rcpt)
      return Response.json({ Status: 'Success', ResponseCode: 0, StandardOutputContent: sealed.toString('base64'), StandardErrorContent: '' })
    }
    const aws = new AwsClient('ap-northeast-2', new CredentialProvider({ AWS_ACCESS_KEY_ID: 'AKID', AWS_SECRET_ACCESS_KEY: 'x' }), fake as never)
    const r = await new SsmRunner(aws, 'tdcloud-control:1').run('i-123', ['docker', 'exec', 'tdc-acme', '/usr/local/bin/tdrive', 'init'], { secret: true, timeoutS: 30 })
    expect(r.stdout).toContain('tdrive_setup_SECRETSECRETSECRETSECRET')
    // the stored SSM output was ciphertext (base64 of a sealed file), and the command line holds no secret
    expect(script).toContain('seal --recipient')
    expect(script).toStartWith('bash -o pipefail -c ')
    expect(seen[0]!.body.InstanceIds).toEqual(['i-123'])
  }, 15_000)

  test('Route 53 change and KMS calls are signed requests to the right endpoints', async () => {
    const urls: string[] = []
    const fake = async (url: string, init?: RequestInit) => {
      urls.push(`${init?.method} ${url} ${String((init?.headers as Record<string, string>)['x-amz-target'] ?? '')}`)
      if (url.includes('route53')) { expect(String(init?.body)).toContain('<Name>acme.cloud.trina.app</Name>'); return new Response('<ok/>') }
      return Response.json({ CiphertextBlob: 'Y2lwaGVy' })
    }
    const aws = new AwsClient('ap-northeast-2', new CredentialProvider({ AWS_ACCESS_KEY_ID: 'AKID', AWS_SECRET_ACCESS_KEY: 'x' }), fake as never)
    await aws.changeA('Z123', 'UPSERT', 'acme.cloud.trina.app', '198.51.100.7')
    expect(await aws.kmsEncrypt('alias/tdcloud', new Uint8Array([1]), { team: 'a' })).toBe('Y2lwaGVy')
    expect(urls).toEqual([
      'POST https://route53.amazonaws.com/2013-04-01/hostedzone/Z123/rrset/ ',
      'POST https://kms.ap-northeast-2.amazonaws.com/ TrentService.Encrypt',
    ])
  })
})

#!/usr/bin/env bun
// One control-plane CLI command on the AWS control instance over SSM Run Command, the way cloud/scripts/aws-smoke.ts
// reaches it: `bun cloud/dev/e2e/ops-ssm.ts teams show <slug>` → `docker exec tdc-control bun /app/src/main.ts …` there.
// Profile E2E_AWS_PROFILE (default tdcloud), region E2E_AWS_REGION (default ap-northeast-2). The command text lands in
// SSM's history: never pass a secret here. Prints the command's stdout/stderr, exits with its code.
const profile = process.env.E2E_AWS_PROFILE || 'tdcloud', region = process.env.E2E_AWS_REGION || 'ap-northeast-2'
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
function aws(args: string[]) {
  const r = Bun.spawnSync(['aws', ...args, '--profile', profile, '--region', region, '--output', 'json'], { stdout: 'pipe', stderr: 'pipe' })
  return { code: r.exitCode ?? 1, out: r.stdout.toString(), err: r.stderr.toString() }
}
const args = process.argv.slice(2)
if (!args.length) { console.error('usage: ops-ssm.ts <control CLI args…>'); process.exit(2) }
const ids = aws(['ec2', 'describe-instances', '--filters', 'Name=tag:tdcloud:role,Values=control', 'Name=instance-state-name,Values=running', '--query', 'Reservations[].Instances[].InstanceId'])
const id = ids.code === 0 ? (JSON.parse(ids.out) as string[])[0] : undefined
if (!id) { console.error(`no running control instance (tag tdcloud:role=control): ${ids.err.trim()}`); process.exit(1) }
const cmd = `docker exec tdc-control bun /app/src/main.ts ${args.map(shq).join(' ')}`
const send = aws(['ssm', 'send-command', '--instance-ids', id, '--document-name', 'AWS-RunShellScript', '--comment', 'tdcloud e2e',
  '--parameters', JSON.stringify({ commands: [cmd], executionTimeout: ['900'] }), '--query', 'Command.CommandId'])
if (send.code !== 0) { console.error(`ssm send-command: ${send.err.trim()}`); process.exit(1) }
const cid = JSON.parse(send.out) as string
const deadline = Date.now() + 960_000
for (;;) {
  Bun.sleepSync(2000)
  const g = aws(['ssm', 'get-command-invocation', '--command-id', cid, '--instance-id', id])
  if (g.code === 0) {
    const j = JSON.parse(g.out) as { Status: string; ResponseCode: number; StandardOutputContent: string; StandardErrorContent: string }
    if (!['Pending', 'InProgress', 'Delayed'].includes(j.Status)) { process.stdout.write(j.StandardOutputContent); process.stderr.write(j.StandardErrorContent); process.exit(j.ResponseCode) }
  } else if (!/InvocationDoesNotExist/.test(g.err)) { console.error(g.err.trim()); process.exit(1) }
  if (Date.now() > deadline) { console.error(`ssm command ${cid} did not finish`); process.exit(1) }
}

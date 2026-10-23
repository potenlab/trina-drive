// S33 — hosts: the fixture team runs on a host the scaler launched; hosts list and the control audit show the
// scale-out. The full scale-out → limit → waiting → scale-in story runs in the legacy suite (cloud/dev/e2e.ts §9),
// which this checks has left its marks; on AWS this is the first real scale-out, observed with E2E_OPS.
import type { Scenario } from '../lib/ctx'

export default {
  id: 'S33', title: 'hosts: the team sits on a scaler-launched host; scale-out/in recorded (full story: legacy §9)', phase: 1, targets: ['local', 'aws'], needs: ['ops'], uses: 'OPS',
  async run(t) {
    const ops = t.target.ops!
    const show = ops('teams', 'show', t.fx.slug)
    const team = show.code === 0 ? JSON.parse(show.out) as { host?: string; status?: string; plan?: string; sub_status?: string } : {}
    t.check(`${t.fx.slug}: active on host ${team.host}`, team.status === 'active' && !!team.host, show.out.slice(0, 300))
    t.check('a complimentary Team (operator-created, as the dogfood team)', team.plan === 'team' && team.sub_status === 'complimentary', team)
    const hosts = ops('hosts', 'list')
    const line = hosts.out.split('\n').find((l) => l.startsWith(`${team.host} `)) ?? ''
    t.check(`hosts list: ${team.host} ready and holds the team`, / ready /.test(line) && line.includes(t.fx.slug), hosts.out)
    const log = ops('audit', 'list', '--limit', '1000').out
    for (const a of ['hosts.scale_out', 'host.ready', 'team.host_assigned']) t.check(`control audit has ${a}`, log.includes(a))
    if (t.target.kind === 'local') {
      if (log.includes('hosts.scale_in') && log.includes('team.waiting_for_host')) t.check('the legacy suite\'s limit + scale-in story ran on this stack', true)
      else t.skipPart('limit + waiting + scale-in', 'run cloud/dev/up.sh (the legacy suite) on this stack: it covers that part')
    }
  },
} satisfies Scenario

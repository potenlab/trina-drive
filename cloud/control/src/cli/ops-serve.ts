// The member sync's traffic hold (workstream G1 for D1's gate, sync.ts, review finding 5): when a woken, resumed or
// remade team has to apply the current membership before anyone may use it, Caddy leaves the team's network (requests
// get the paused page, 503) until the sync is done. If the sync fails, the gate stops the container again and the next
// start joins Caddy back. Registered once (main.ts loads cli/index.ts → ops-commands.ts, which imports this file).
import { serveHooks, type ServeHook } from '../sync'

export const caddyHold: ServeHook = {
  hold: async (cloud, t) => { if (t.host && cloud.driver.holdTraffic) await cloud.driver.holdTraffic(t.host, cloud.spec(t)) },
  release: async (cloud, t) => { if (t.host && cloud.driver.serveTraffic) await cloud.driver.serveTraffic(t.host, cloud.spec(t)) },
}

export function registerCaddyHold(list: ServeHook[] = serveHooks) {
  if (!list.includes(caddyHold)) list.push(caddyHold)
}
registerCaddyHold()

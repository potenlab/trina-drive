// The control plane's route registry (W0 seams), imported once by web.ts. A module adds routes to its own list:
//   ./console.ts   consoleRoutes   the console (workstream D1); console-http.ts holds its cookie, CSP and Origin rules
// A new module list is added here by the integrator (one line).
import { consoleRoutes } from './console'
import type { ControlRoute } from './types'

export const CONTROL_ROUTES: ControlRoute[] = [...consoleRoutes]

/** The first registered route for this method and path, with its match. */
export function findRoute(method: string, path: string, list: ControlRoute[] = CONTROL_ROUTES): { route: ControlRoute; match: RegExpExecArray } | null {
  for (const route of list) {
    if (route.method !== '*' && route.method !== method && !(route.method === 'GET' && method === 'HEAD')) continue
    if (typeof route.path === 'string') {
      if (route.path === path) { const m = [path] as unknown as RegExpExecArray; return { route, match: m } }
    } else {
      const m = route.path.exec(path)
      if (m) return { route, match: m }
    }
  }
  return null
}

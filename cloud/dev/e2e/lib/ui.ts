// The browser flows (e2e/ui, playwright-core in its own package): loaded by path at run time so that nothing here
// needs playwright-core to typecheck or to run the HTTP scenarios.
import path from 'node:path'
import { UI_DIR } from './features'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function ui(): Promise<any> {
  const p = path.join(UI_DIR, 'flows.ts')
  return import(p)
}

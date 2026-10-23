#!/usr/bin/env bun
// The browser (H2) scenarios alone: the same runner as cloud/dev/e2e/run.ts, limited to the scenarios with a browser
// part. Screenshots land in e2e/ui/.out (and in $E2E_SHOTS_DIR when set).
//   bun e2e/ui/run.ts [--target aws]      (UI1 = C1's web/e2e suite)
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ids = 'S01,S02,S04,S10,S12,S37,S48,UI1'
const p = Bun.spawnSync(['bun', path.join(here, '../../cloud/dev/e2e/run.ts'), '--only', ids, ...process.argv.slice(2)], { stdout: 'inherit', stderr: 'inherit' })
process.exit(p.exitCode ?? 1)

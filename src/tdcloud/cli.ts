// CLI commands of Trina Cloud mode (workstream B1), registered through src/cli-registry.ts, e.g.
//   { name: 'cloud sync-members', help: '  cloud sync-members --json B64 | --stdin   …', run: ({ db, args, out }) => … }
// The member-sync payload and its output are fixed by docs/SSO-CONTRACT.md (test/fixtures/sso-v1.json).
import type { CliCommand } from '../cli-registry'

export const cloudCommands: CliCommand[] = []

// Product CLI commands contributed by modules (src/cli-registry.ts): found by their words, listed in help, and never
// named like a built-in command of src/cli.ts (the built-in would win and the module's would be dead).
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { CLI_COMMANDS, findCommand, registeredHelp, type CliCommand } from '../src/cli-registry'

const builtins = [...fs.readFileSync(path.join(import.meta.dir, '..', 'src', 'cli.ts'), 'utf8').matchAll(/case '([^']+)'/g)].map((m) => m[1]!)

describe('CLI registry', () => {
  test('no registered command shadows a built-in or another registered command', () => {
    const names = CLI_COMMANDS.map((c) => c.name)
    expect(names.filter((n) => builtins.includes(n))).toEqual([])
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([])
  })

  test('finds two-word commands before one-word ones and hands over the rest', () => {
    const list: CliCommand[] = [{ name: 'cloud', help: '  cloud', run: () => 0 }, { name: 'cloud sync-members', help: '  cloud sync-members', run: () => 0 }]
    expect(findCommand(['cloud', 'sync-members', '--json', 'e30'], list)).toEqual({ command: list[1]!, rest: ['--json', 'e30'] })
    expect(findCommand(['cloud', 'usage'], list)).toEqual({ command: list[0]!, rest: ['usage'] })
    expect(findCommand(['person', 'add'], list)).toBeNull()
    expect(registeredHelp([])).toBe('')
    expect(registeredHelp(list)).toContain('cloud sync-members')
  })
})

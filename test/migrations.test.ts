// Modules' schema changes (src/migrations.ts) run in their phase, are idempotent, and have unique ids.
import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { addColumns, MIGRATIONS, runMigrations, type Migration } from '../src/migrations'

describe('migrations registry', () => {
  test('ids are unique', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids.filter((x, i) => ids.indexOf(x) !== i)).toEqual([])
  })

  test('each phase runs its own migrations; running again changes nothing', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    const list: Migration[] = [
      { id: 'x.core', phase: 'core', up: (d) => addColumns(d, 't', [['a', 'TEXT'], ['b', 'INTEGER NOT NULL DEFAULT 0']]) },
      { id: 'x.web', phase: 'web', up: (d) => d.exec('CREATE TABLE IF NOT EXISTS w (id INTEGER PRIMARY KEY)') },
    ]
    runMigrations(db, 'core', list)
    runMigrations(db, 'core', list)
    expect(db.query<{ name: string }, []>('PRAGMA table_info(t)').all().map((c) => c.name)).toEqual(['id', 'a', 'b'])
    expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'w'").get()).toBeNull()
    runMigrations(db, 'web', list)
    expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'w'").get()).not.toBeNull()
    expect(() => addColumns(db, 't; DROP', [['c', 'TEXT']])).toThrow()
  })
})

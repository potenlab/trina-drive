// Where things live inside a data directory. One place for the installer (scripts/install-macos.sh), the backup module
// and (once wired) the server.
//
// "installed" is what scripts/install-macos.sh creates under /Library/Application Support/<name>/:
//   db/store.db          SQLite (metadata, drafts index, versions, trash, audit chain); also backup.json
//   drafts/              draft version contents, content-addressed (<aa>/<sha256>)
//   mirror/              extracted text cache (rebuilt on demand, never backed up)
//   backup-staging/      short-lived plaintext snapshot of the DB while a backup runs
//   logs/                launchd stdout/stderr of the daemons
//   config/              root-owned: backup-recipient (public key), server.json
// "flat" is the development layout the prototype uses today (~/.<name>/store.db, blobs/, mirror/).
import fs from 'node:fs'
import path from 'node:path'

export type LayoutKind = 'installed' | 'flat'

export interface Layout {
  kind: LayoutKind
  dataDir: string
  dbFile: string
  draftsDir: string
  mirrorDir: string
  stagingDir: string
  logsDir: string
  /** backup target and retention (written by `backup target set`, server-owned) */
  backupConfig: string
  /** the backup public key (recipient); root-owned in the installed layout */
  backupRecipient: string
}

export function layoutFor(dataDir: string, kind: LayoutKind): Layout {
  const d = path.resolve(dataDir)
  if (kind === 'installed') {
    return {
      kind, dataDir: d,
      dbFile: path.join(d, 'db', 'store.db'),
      draftsDir: path.join(d, 'drafts'),
      mirrorDir: path.join(d, 'mirror'),
      stagingDir: path.join(d, 'backup-staging'),
      logsDir: path.join(d, 'logs'),
      backupConfig: path.join(d, 'db', 'backup.json'),
      backupRecipient: path.join(d, 'config', 'backup-recipient'),
    }
  }
  return {
    kind, dataDir: d,
    dbFile: path.join(d, 'store.db'),
    draftsDir: path.join(d, 'blobs'),
    mirrorDir: path.join(d, 'mirror'),
    stagingDir: path.join(d, 'backup-staging'),
    logsDir: path.join(d, 'logs'),
    backupConfig: path.join(d, 'backup.json'),
    backupRecipient: path.join(d, 'backup-recipient'),
  }
}

/** The layout a data directory uses: TDRIVE_LAYOUT if set, else installed when it has db/ (the installer creates it), else flat. */
export function detectLayout(dataDir: string): Layout {
  const d = path.resolve(dataDir)
  const forced = process.env.TDRIVE_LAYOUT
  const installed = forced ? forced === 'installed' : fs.existsSync(path.join(d, 'db'))
  return layoutFor(d, installed ? 'installed' : 'flat')
}

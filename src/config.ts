// Names come from src/brand.ts (one place to rename the product); the version from package.json.
import pkg from '../package.json'
import os from 'node:os'
import path from 'node:path'
import { ENV_PREFIX, NAME } from './brand'

export { CLI, ENV_PREFIX, NAME, PRODUCT, SECRET_TAG, TOKEN_PREFIX } from './brand'
export const VERSION: string = pkg.version

/** Data directory: --data, then $TDRIVE_HOME, then ~/.trina-drive (src/brand.ts). Never inside a registered folder. */
export const defaultDataDir = () => process.env[`${ENV_PREFIX}_HOME`] || path.join(os.homedir(), `.${NAME}`)

const envBytes = (k: string, dflt: number): number => {
  const v = Number(process.env[`${ENV_PREFIX}_${k}`])
  return process.env[`${ENV_PREFIX}_${k}`] && Number.isFinite(v) && v >= 0 ? Math.floor(v) : dflt
}

export const LIMITS = {
  /** provenance window (R3) */
  windowMs: 8 * 3600_000,
  /** wall clock for one bash tool call */
  commandMs: 20_000,
  /** ripgrep run inside one command */
  rgMs: 10_000,
  /** what one tool call may return */
  stdoutBytes: 256 * 1024,
  stderrBytes: 32 * 1024,
  /** audit keeps the command line up to this many bytes, plus the hash of the whole */
  auditCommandBytes: 4096,
  auditFiles: 500,
  /** bytes read from an original file */
  fileBytes: 64 * 1024 * 1024,
  draftBytes: 8 * 1024 * 1024,
  /** one MCP request body (a draft as JSON, with room for escapes) */
  requestBytes: 24 * 1024 * 1024,
  draftVersionsKept: 20,
  /** document extraction in an isolated worker (src/extract/run.ts): deadline and memory of one document */
  extractMs: 20_000,
  extractRssBytes: 512 * 1024 * 1024,
  /** content one call may read (shell, read tool): each file at most fileBytes, all files together at most this */
  callReadBytes: 128 * 1024 * 1024,
  /** draft quota: live drafts (latest version) per token and per person; env <PREFIX>_DRAFT_MAX_FILES / _MAX_BYTES / _PERSON_MAX_BYTES */
  draftFilesPerToken: envBytes('DRAFT_MAX_FILES', 500),
  draftBytesPerToken: envBytes('DRAFT_MAX_BYTES', 200 * 1024 * 1024),
  draftBytesPerPerson: envBytes('DRAFT_PERSON_MAX_BYTES', 1024 * 1024 * 1024),
}

/** "modern" MCP (2026-07-28 on): no handshake; every request carries its version and client capabilities in _meta, and
 * server/discover tells a client what the server speaks */
export const MODERN_PROTOCOL_VERSIONS = ['2026-07-28'] as const
/** "legacy" MCP: an initialize handshake picks the version (answered here, never with a modern version) */
export const LEGACY_PROTOCOL_VERSIONS = ['2025-11-25'] as const
export const SUPPORTED_PROTOCOL_VERSIONS = [...MODERN_PROTOCOL_VERSIONS, ...LEGACY_PROTOCOL_VERSIONS] as const
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

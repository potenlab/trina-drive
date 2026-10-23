// Google Drive import: the operator's settings. The feature exists only when the Google client is configured
// (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET for the server's OAuth flow, GOOGLE_API_KEY for the Picker in the browser)
// and the server keeps managed storage (imports are writes into team folders). Otherwise every endpoint answers 404
// and the app shows nothing.
//
// Scope: `drive.file` (non-sensitive: no Google verification, no user cap). The app sees only the files a person picks
// in the Google Picker. `<PREFIX>_GDRIVE_READONLY=1` adds `drive.readonly` (restricted: an unverified app shows
// Google's warning screen and is capped at 100 users for the project's lifetime) so a picked folder can be imported
// with everything in it. Use it for design partners on a separate Google Cloud project; default off.
import { ENV_PREFIX } from '../config'

export const SCOPE_FILE = 'https://www.googleapis.com/auth/drive.file'
export const SCOPE_READONLY = 'https://www.googleapis.com/auth/drive.readonly'

export interface GoogleConfig {
  clientId: string
  clientSecret: string
  /** browser key for the Picker (restrict it to the Picker API and this site's address in the Cloud console) */
  apiKey: string
  /** Cloud project number (the Picker's app id: drive.file grants picked files to this app); from the client id when unset */
  appId: string
  /** drive.readonly as well: whole folders, recursively */
  readonly: boolean
}

const truthy = (v: string | undefined) => !!v && /^(1|true|yes|on)$/i.test(v.trim())

export function googleConfigFromEnv(env: Record<string, string | undefined> = process.env): GoogleConfig | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim(), clientSecret = env.GOOGLE_CLIENT_SECRET?.trim(), apiKey = env.GOOGLE_API_KEY?.trim()
  if (!clientId || !clientSecret || !apiKey) return null
  return { clientId, clientSecret, apiKey, appId: env.GOOGLE_APP_ID?.trim() || /^(\d+)-/.exec(clientId)?.[1] || '', readonly: truthy(env[`${ENV_PREFIX}_GDRIVE_READONLY`]) }
}

export const scopesOf = (c: GoogleConfig) => ['openid', 'email', SCOPE_FILE, ...(c.readonly ? [SCOPE_READONLY] : [])]

export const GDRIVE_LIMITS = {
  /** items picked in one import */
  pickedItems: 500,
  /** files one import may bring in (folders expanded, readonly mode) */
  jobFiles: 5000,
  /** folder depth followed in readonly mode */
  depth: 20,
  /** imports running at once per person */
  jobsPerPerson: 3,
  /** finished jobs kept for the progress view */
  jobsKept: 20,
  /** an OAuth state (the round trip through Google's consent screen) */
  stateTtlMs: 10 * 60_000,
  /** retries of one Google call that answered "slow down" */
  retries: 3,
}

/** Google file types that are exported (they have no bytes of their own); everything else is downloaded as it is. */
export const EXPORTS: Record<string, { mime: string; ext: string }> = {
  'application/vnd.google-apps.document': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' },
  'application/vnd.google-apps.spreadsheet': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' },
  'application/vnd.google-apps.presentation': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx' },
  'application/vnd.google-apps.drawing': { mime: 'application/pdf', ext: 'pdf' },
}
export const FOLDER_MIME = 'application/vnd.google-apps.folder'

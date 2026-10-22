// Every name the product goes by, in one place. To rename the product, change this file, then "name" and "bin" in
// package.json and NAME/CLI/LABEL in scripts/macos/common.sh (test/brand.test.ts and scripts/build.ts check that they
// agree). Docker, AppArmor and docs spell the names out; `git grep -i <old name>` finds them.
// No imports: the web app (web/) imports this file too.

/** What people read: page titles, email subjects, the consent screen, passkey and authenticator labels. */
export const PRODUCT = 'Trina Drive'
/** The machine name: package, data directory (~/.trina-drive), MCP entry and OAuth/MCP server name, Docker image,
 *  macOS data folder, backup and anchor file names, Keychain service. */
export const NAME = 'trina-drive'
/** The command people type. Also the tag of every secret the product makes (tdrive_pat_…, tdrive_setup_…), so secret
 *  scanners and the redactor can recognize them, and the prefix of every environment variable (TDRIVE_…). */
export const CLI = 'tdrive'
/** Environment variable prefix: TDRIVE_HOME, TDRIVE_SHELL, … */
export const ENV_PREFIX = CLI.toUpperCase().replace(/[^A-Z0-9]/g, '_')
/** Tag of secrets: `${SECRET_TAG}_pat_…`, `${SECRET_TAG}_setup_…`, `${SECRET_TAG}_oat_…`, the session cookie. */
export const SECRET_TAG = CLI.toLowerCase().replace(/[^a-z0-9]/g, '')
/** Personal access token prefix. */
export const TOKEN_PREFIX = `${SECRET_TAG}_pat_`
/** Reverse-DNS prefix of the macOS LaunchDaemons: <LABEL>.server, <LABEL>.backup, <LABEL>.worker. */
export const LAUNCHD_LABEL = 'app.trina.drive'
export const COMPANY = 'Trina Inc.'
export const SITE = 'https://drive.trina.app'
export const REPO = 'https://github.com/potenlab/trina-drive'

// Preloaded for every test file (bunfig.toml [test] preload). bun 1.3 has no bunfig key for the per-test timeout (only the
// --timeout flag), so it is set here: shell commands run in isolated worker processes by default, and suites that run
// many of them need more than bun's 5 s default.
import { setDefaultTimeout } from 'bun:test'

setDefaultTimeout(30_000)

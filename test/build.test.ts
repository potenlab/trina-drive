import { afterAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { vendorMacho, writeChecksums } from '../scripts/build'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'build-test-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('SHA256SUMS is what shasum -c expects, and catches a change', async () => {
  const d = path.join(tmp, 'rel')
  fs.mkdirSync(path.join(d, 'a b'), { recursive: true })
  fs.writeFileSync(path.join(d, 'a b', 'x.txt'), 'hello')
  fs.writeFileSync(path.join(d, 'release.json'), '{}')
  await writeChecksums(d)
  expect(Bun.spawnSync(['/usr/bin/shasum', '-a', '256', '-c', 'SHA256SUMS'], { cwd: d }).exitCode).toBe(0)
  fs.writeFileSync(path.join(d, 'a b', 'x.txt'), 'hellO')
  expect(Bun.spawnSync(['/usr/bin/shasum', '-a', '256', '-c', 'SHA256SUMS'], { cwd: d, stderr: 'pipe', stdout: 'pipe' }).exitCode).not.toBe(0)
})

// Vendoring needs Homebrew's poppler on this build host (scripts/tools.json); skipped elsewhere.
const brew = process.arch === 'arm64' ? '/opt/homebrew' : '/usr/local'
const cellar = path.join(brew, 'Cellar', 'poppler')
const version = fs.existsSync(cellar) ? fs.readdirSync(cellar).sort().at(-1) : undefined
test.skipIf(process.platform !== 'darwin' || !version)('vendored pdftotext runs without Homebrew paths', () => {
  const tools = path.join(tmp, 'tools')
  fs.mkdirSync(path.join(tools, 'bin'), { recursive: true })
  vendorMacho(path.join(cellar, version!, 'bin', 'pdftotext'), brew, tools)
  const pdf = '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n' +
    '4 0 obj << /Length 44 >> stream\nBT /F1 12 Tf 10 50 Td (vendored ok) Tj ET\nendstream endobj\n' +
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n'
  const p = Bun.spawnSync([path.join(tools, 'bin', 'pdftotext'), '-enc', 'UTF-8', '-', '-'], {
    stdin: new TextEncoder().encode(pdf), stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin', DYLD_PRINT_LIBRARIES: '1' },
  })
  expect(p.stdout.toString()).toContain('vendored ok')
  // every library came from tools/lib, none from Homebrew
  expect(p.stderr.toString()).not.toContain(brew + '/')
  expect(p.stderr.toString()).toContain(path.join(tools, 'lib'))
}, 120_000)

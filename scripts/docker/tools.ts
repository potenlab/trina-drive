#!/usr/bin/env bun
// Docker image build step: puts the pinned downloadable tools of scripts/tools.json (ripgrep) for one Linux target into
// <out>/tools/bin, their license files into <out>/tools/licenses/<package>/, and a manifest <out>/tools.json (package,
// version, origin URL + pinned SHA-256, SHA-256 of each installed file), the same format as a macOS release's.
// A download is accepted only with the pinned SHA-256 (scripts/build.ts vendorDownload).
//
//   bun scripts/docker/tools.ts <linux-arm64|linux-x64> <out>
import fs from 'node:fs'
import path from 'node:path'
import { vendorDownload, type ToolEntry } from '../build'

const [target, out] = process.argv.slice(2)
if (!target || !/^linux-(arm64|x64)$/.test(target) || !out) {
  console.error('usage: bun scripts/docker/tools.ts <linux-arm64|linux-x64> <out>')
  process.exit(2)
}
const pins = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '..', 'tools.json'), 'utf8')).tools as Parameters<typeof vendorDownload>[0][]
fs.mkdirSync(path.join(out, 'tools', 'bin'), { recursive: true })
const tools: ToolEntry[] = []
for (const pin of pins) {
  const t = (pin.targets as Record<string, Parameters<typeof vendorDownload>[1] | undefined>)[target]
  if (!t) throw new Error(`${pin.package}: no pin for ${target} in scripts/tools.json`)
  if (pin.source !== 'download') { console.log(`${pin.package}: from the distribution (${JSON.stringify(t)})`); continue }
  tools.push(await vendorDownload(pin, t, out, path.join(out, '.cache')))
  console.log(`${pin.package} ${pin.version} for ${target}: ${tools.at(-1)!.files.map((f) => `${f.path} ${f.sha256}`).join(', ')}`)
}
fs.rmSync(path.join(out, '.cache'), { recursive: true, force: true })
fs.writeFileSync(path.join(out, 'tools.json'), JSON.stringify({ target, tools }, null, 2) + '\n')

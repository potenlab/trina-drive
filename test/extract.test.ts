import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { readCfb, writeCfb } from '../src/extract/cfb'
import { extractText, TOOLS } from '../src/extract'
import { readZip, writeZip } from '../src/extract/zip'
import { sampleDocx, sampleHwp, sampleHwpx, samplePdf, sampleXlsx } from '../src/samples'

describe('text extraction', () => {
  test.skipIf(!TOOLS.pdftotext)('pdf (pdftotext -layout)', async () => {
    expect(await extractText('a.pdf', samplePdf(['Board memo', 'Revenue 12.4B']))).toStartWith('Board memo\nRevenue 12.4B\n')
  })
  test('docx, xlsx, hwpx, hwp', async () => {
    expect(await extractText('a.docx', sampleDocx(['사양서', '납기 & 범위']))).toBe('사양서\n납기 & 범위\n')
    expect(await extractText('a.xlsx', sampleXlsx('손익', [['항목', '금액'], ['매출', 12]]))).toBe('# sheet: 손익 (tab-separated)\n항목\t금액\n매출\t12\n')
    expect(await extractText('a.hwpx', sampleHwpx(['일정', '착수']))).toBe('일정\n착수\n')
    expect(await extractText('a.hwp', sampleHwp(['한글 본문', '둘째']))).toBe('한글 본문\n둘째\n')
  })
  test('damaged files give a clear error', async () => {
    await expect(extractText('a.docx', new TextEncoder().encode('not a zip'))).rejects.toThrow('cannot extract text')
    await expect(extractText('a.hwp', new Uint8Array(600))).rejects.toThrow('cannot extract text')
  })
  test('zip and cfb round trips', () => {
    const z = readZip(writeZip({ 'a.txt': 'hi', 'dir/b.txt': new Uint8Array([1, 2, 3]) }))
    expect(new TextDecoder().decode(z.get('a.txt')!())).toBe('hi')
    expect([...z.get('dir/b.txt')!()]).toEqual([1, 2, 3])
    const big = new Uint8Array(5000).fill(7)
    const c = readCfb(writeCfb({ 'S/x': big, y: new Uint8Array(4096).fill(1) }))
    expect(c.get('S/x')!.length).toBe(5000)
    expect(c.get('y')![4095]).toBe(1)
  })
  // a real Hangul-made file exercises the CFB mini stream: SHELF_TEST_HWP=/path/to/file.hwp bun test
  const real = process.env.SHELF_TEST_HWP ?? ''
  test.skipIf(!fs.existsSync(real))('a real .hwp file', async () => {
    expect((await extractText('x.hwp', fs.readFileSync(real))).length).toBeGreaterThan(100)
  })
})

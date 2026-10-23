// Writes the small English sample company used for the README demo GIF and screenshots.
// Usage: bun docs/assets/src/sample-files.ts <dir>   (fictional people, companies and numbers)
import fs from 'node:fs'
import path from 'node:path'
import { sampleDocx, samplePdf, sampleXlsx } from '../../../src/samples'

const FILES: Record<string, string | Uint8Array> = {
  'contracts/acme-supply-2026.pdf': samplePdf(['Acme Supply Co. - Supply Agreement 2026', '12.3 Termination fee: USD 36,000 (three months of fees)', 'Renewal date: 31 March 2027']),
  'contracts/northwind-msa.docx': sampleDocx(['Northwind Traders - Master Services Agreement', '9.2 Termination fee: 10% of the remaining contract value', 'Notice period: 60 days']),
  'contracts/globex-services.pdf': samplePdf(['Globex Services Agreement', '14.1 Termination fee: USD 12,000 flat', 'Governing law: Delaware']),
  'contracts/lumen-coffee-sow.docx': sampleDocx(['Statement of Work - Lumen Coffee brand refresh', 'Fixed fee USD 60,000, 12 weeks', '8.1 Either party may end this SOW with 30 days notice']),
  'finance/2026-Q3-close.xlsx': sampleXlsx('Q3', [['', 'Q3', 'Q2'], ['Revenue', 1420000, 1310000], ['Costs', 1060000, 1020000], ['Operating margin', '25.4%', '22.1%']]),
  'finance/board-memo-Q3.pdf': samplePdf(['Board memo - 2026 Q3', 'Revenue USD 1.42M (+8.4% on Q2)', 'Driver: two new retainer clients from August', 'Confidential: finance and leadership only']),
  'sales/proposals/globex-2026-07.docx': sampleDocx(['Proposal - Globex website rebuild', 'Scope: three phases', 'Timeline: 8 weeks, review at week 4']),
  'sales/proposals/northwind-2026-05.docx': sampleDocx(['Proposal - Northwind brand system', 'Fixed fee plus monthly support']),
  'sales/rate-card.csv': 'role,day rate (USD)\ndesign lead,1400\ndesigner,1000\ndeveloper,1100\n',
  'hr/handbook.pdf': samplePdf(['Employee handbook 2026', '4.3 Remote work equipment: up to USD 1,500 every two years', '4.4 Working abroad: up to 4 weeks a year, tell Operations first']),
  'hr/expense-policy.md': '# Expense policy\n\n- Coworking spaces while travelling: up to USD 40 a day\n- Keep receipts; submit by the 5th of the next month\n',
  'shared/announcements.md': '# Announcements\n\n- Office closed on 27 November\n- New printer on the 2nd floor\n',
  'shared/brand/logo-usage.md': '# Logo usage\n\nKeep 16 px of clear space around the mark.\n',
  'payroll/salaries-2026.csv': 'name,base\nSam Lee,98000\nMina Park,91000\nJordan Kim,88000\n',
}

const root = process.argv[2]
if (!root) throw new Error('usage: bun docs/assets/src/sample-files.ts <dir>')
for (const [rel, content] of Object.entries(FILES)) {
  const p = path.join(root, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}
console.log(`wrote ${Object.keys(FILES).length} files under ${root}`)

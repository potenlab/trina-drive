#!/usr/bin/env bash
# A small English sample company, set up only with the public `tdrive` admin CLI.
# Usage: docs/assets/src/seed.sh <data-dir>     prints MINA=…, SAM=… tokens and the web setup token
set -euo pipefail
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
data="$1"; files="$data/company"
td() { bun run "$repo/src/cli.ts" --data "$data" "$@"; }

bun "$repo/docs/assets/src/sample-files.ts" "$files" >/dev/null
td init | tail -1 > "$data/setup-token.txt"
td person add alex --admin >/dev/null          # the web admin signs up as alex with the setup token
for p in sam mina jordan; do td person add $p >/dev/null; done
for g in everyone finance sales ops; do td group add $g >/dev/null; done
for p in alex sam mina jordan; do td group member everyone $p >/dev/null; done
td group member finance sam >/dev/null; td group member finance alex >/dev/null
td group member sales mina >/dev/null; td group member ops jordan >/dev/null

td folder register "$files/finance"   --nas-readers sam,alex >/dev/null
td folder register "$files/contracts" --nas-readers all >/dev/null
td folder register "$files/sales"     --nas-readers all >/dev/null
td folder register "$files/hr"        --nas-readers all >/dev/null
td folder register "$files/shared"    --nas-readers all >/dev/null
td folder register "$files/payroll"   --nas-readers sam >/dev/null
td rule set "$files/finance"   @finance  read  >/dev/null
td rule set "$files/contracts" @everyone read  >/dev/null
td rule set "$files/sales"     @everyone read  >/dev/null
td rule set "$files/sales"     @sales    write >/dev/null
td rule set "$files/hr"        @everyone read  >/dev/null
td rule set "$files/shared"    @everyone write >/dev/null   # drafts may be promoted here (approval if widening)
td rule set "$files/payroll"   @finance  read  >/dev/null
td folder flag "$files/payroll" no-ai >/dev/null   # people may open it on the web; no AI ever sees it
td manage grant "$files/finance" alex >/dev/null   # alex may approve drafts made from finance
td manage grant "$files/shared"  alex >/dev/null

echo "MINA=$(td token create mina --name mina-laptop 2>/dev/null)"
echo "SAM=$(td token create sam --name sam-laptop 2>/dev/null)"
echo "SETUP=$(cat "$data/setup-token.txt")"

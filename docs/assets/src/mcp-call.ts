// Calls one Trina Drive MCP tool the way an AI client does (JSON-RPC tools/call over HTTP) and prints its text.
// Usage: bun docs/assets/src/mcp-call.ts <server> <token> <tool> '<json arguments>'
const [server, token, tool, args = '{}'] = process.argv.slice(2)
if (!server || !token || !tool) throw new Error('usage: mcp-call.ts <server> <token> <tool> <json-args>')
const res = await fetch(new URL('/mcp', server), {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: JSON.parse(args) } }),
})
const msg = await res.json() as { result?: { content: { text: string }[]; isError?: boolean }; error?: { message: string } }
if (msg.error) { console.error(msg.error.message); process.exit(1) }
for (const c of msg.result!.content) console.log(c.text)
if (msg.result!.isError) process.exitCode = 1

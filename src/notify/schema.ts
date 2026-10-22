// Tables of the notify stream (events, inbox, outgoing deliveries, connections, bulk-read log, audit anchors).
// Additive: CREATE IF NOT EXISTS only, no change to the core schema in db.ts. Idempotent, safe to call on every open.
import type { DB } from '../db'

export const NOTIFY_SCHEMA_VERSION = 1

const SCHEMA = `
-- every event the bus saw; detail is only for the logged-in screen (R7 filter there), never for a channel payload
CREATE TABLE IF NOT EXISTS notify_events (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL,
  subject_person_id INTEGER, token_id INTEGER, folder_id INTEGER, detail TEXT);
-- where a person is reached besides the in-app inbox
CREATE TABLE IF NOT EXISTS notify_contacts (
  person_id INTEGER PRIMARY KEY REFERENCES people(id), email TEXT, slack_webhook TEXT, lang TEXT);
-- in-app inbox: one unread row per (person, kind, level), counts coalesce until it is read
CREATE TABLE IF NOT EXISTS notify_inbox (
  id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL, kind TEXT NOT NULL, level TEXT NOT NULL, count INTEGER NOT NULL,
  link TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, read_at INTEGER);
CREATE INDEX IF NOT EXISTS notify_inbox_person ON notify_inbox (person_id, read_at);
-- one row per (event, recipient, channel); flushed in coalesced groups
CREATE TABLE IF NOT EXISTS notify_deliveries (
  id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL, person_id INTEGER, channel TEXT NOT NULL, dest TEXT NOT NULL,
  kind TEXT NOT NULL, level TEXT NOT NULL, count INTEGER NOT NULL, lang TEXT NOT NULL, digest INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  message_id INTEGER, error TEXT);
CREATE INDEX IF NOT EXISTS notify_deliveries_due ON notify_deliveries (status, due_at);
-- what actually went out (rate limit counts these)
CREATE TABLE IF NOT EXISTS notify_messages (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, channel TEXT NOT NULL, dest TEXT NOT NULL, kind TEXT NOT NULL,
  count INTEGER NOT NULL, ok INTEGER NOT NULL, error TEXT);
CREATE INDEX IF NOT EXISTS notify_messages_dest ON notify_messages (channel, dest, at);
-- MCP clients seen per token (new_client detection, connections list)
CREATE TABLE IF NOT EXISTS notify_connections (
  id INTEGER PRIMARY KEY, token_id INTEGER NOT NULL, client_name TEXT NOT NULL DEFAULT '', client_version TEXT,
  ua_product TEXT NOT NULL, user_agent TEXT, ip TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS notify_connections_token ON notify_connections (token_id, ua_product, ip);
-- per committed call: how much content a token got out (bulk-read alarm)
CREATE TABLE IF NOT EXISTS notify_reads (
  id INTEGER PRIMARY KEY, token_id INTEGER NOT NULL, at INTEGER NOT NULL, files INTEGER NOT NULL, bytes INTEGER NOT NULL,
  folders TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS notify_reads_token ON notify_reads (token_id, at);
CREATE TABLE IF NOT EXISTS notify_bulk_alarms (token_id INTEGER NOT NULL, at INTEGER NOT NULL);
-- signed audit chain heads (plan principle 6); the copies that matter are the ones sent out
CREATE TABLE IF NOT EXISTS audit_anchors (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, count INTEGER NOT NULL, head TEXT NOT NULL, key TEXT NOT NULL,
  signature TEXT NOT NULL, file TEXT);
`

const done = new WeakSet<DB>()

export function ensureNotifySchema(db: DB) {
  if (done.has(db)) return
  db.exec(SCHEMA)
  db.query("INSERT INTO meta (key, value) VALUES ('notify_schema', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(NOTIFY_SCHEMA_VERSION))
  done.add(db)
}

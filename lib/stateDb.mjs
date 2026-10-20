/**
 * Read-only access to Cursor's global `state.vscdb` (SQLite) using node:sqlite.
 *
 * Layout we rely on:
 *   cursorDiskKV(key, value)   key = `composerData:<composerId>` -> chat header JSON
 *                              key = `bubbleId:<composerId>:<bubbleId>` -> one step JSON
 *   composerHeaders(...)       newer builds; carries a `value` JSON with `name`
 *
 * Everything here is a point lookup or a bounded `IN (...)` — never a table scan
 * over cursorDiskKV, which can be tens of GB.
 */
import fs from 'node:fs'
import sqlite from 'node:sqlite'
import { cursorPaths } from './cursorPaths.mjs'

const IN_CHUNK = 400 // SQLite caps bound params near 999

function safeJson(text, fallback = null) {
  if (typeof text !== 'string') return fallback
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/** Open state.vscdb read-only. Returns `{ db: null }` when the file is absent. */
export function openGlobalStateDb() {
  const dbPath = cursorPaths().globalStateDb
  if (!fs.existsSync(dbPath)) return { db: null, dbPath, close: () => {} }

  const raw = new sqlite.DatabaseSync(dbPath, { readOnly: true })
  try {
    raw.exec('PRAGMA busy_timeout = 5000')
  } catch {
    /* ignore */
  }
  const db = {
    path: dbPath,
    tableExists(name) {
      try {
        return !!raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name)
      } catch {
        return false
      }
    },
    all(sql, params = []) {
      return raw.prepare(sql).all(...params)
    },
    get(sql, params = []) {
      return raw.prepare(sql).get(...params)
    },
    close() {
      raw.close()
    },
  }
  return { db, dbPath, close: () => db.close() }
}

/** Parsed `composerData:<id>` row, or null. */
export function readComposerData(db, composerId) {
  if (!db || !composerId) return null
  const row = db.get('SELECT value FROM cursorDiskKV WHERE key = ?', [`composerData:${composerId}`])
  return row ? safeJson(row.value) : null
}

/** Chat name from composerHeaders (newer Cursor builds), or null. */
export function readComposerHeaderName(db, composerId) {
  if (!db || !composerId || !db.tableExists('composerHeaders')) return null
  const row = db.get('SELECT value FROM composerHeaders WHERE composerId = ?', [composerId])
  return safeJson(row?.value)?.name?.trim() || null
}

/** @returns {Map<string, object>} bubbleId -> parsed bubble */
export function readBubbles(db, composerId, bubbleIds) {
  const out = new Map()
  if (!db || !bubbleIds?.length) return out
  const prefix = `bubbleId:${composerId}:`
  for (let i = 0; i < bubbleIds.length; i += IN_CHUNK) {
    const keys = bubbleIds.slice(i, i + IN_CHUNK).map((id) => `${prefix}${id}`)
    const placeholders = keys.map(() => '?').join(',')
    const rows = db.all(`SELECT key, value FROM cursorDiskKV WHERE key IN (${placeholders})`, keys)
    for (const row of rows) {
      const parsed = safeJson(row.value)
      if (parsed) out.set(row.key.slice(prefix.length), parsed)
    }
  }
  return out
}

export function readBubble(db, composerId, bubbleId) {
  if (!db) return null
  const row = db.get('SELECT value FROM cursorDiskKV WHERE key = ?', [`bubbleId:${composerId}:${bubbleId}`])
  return row ? safeJson(row.value) : null
}

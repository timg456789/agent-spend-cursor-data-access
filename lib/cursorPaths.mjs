/**
 * Where Cursor keeps its data on this machine. Read-only; every path is a
 * candidate and callers must check existence before reading.
 *
 *   User tree (SQLite stores):
 *     win32   %APPDATA%\Cursor\User
 *     darwin  ~/Library/Application Support/Cursor/User
 *     linux   $XDG_CONFIG_HOME/Cursor/User  (default ~/.config)
 *
 *   Home tree (agent transcripts):
 *     all     ~/.cursor
 *
 * Overrides (useful for tests or a copied data dir):
 *   AGENT_SPEND_CURSOR_USER_DIR   -> replaces the User tree
 *   AGENT_SPEND_CURSOR_HOME_DIR   -> replaces ~/.cursor
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

export const HOME_DIR = os.homedir()

function appDataRoot() {
  switch (process.platform) {
    case 'win32':
      return process.env.APPDATA || path.join(HOME_DIR, 'AppData', 'Roaming')
    case 'darwin':
      return path.join(HOME_DIR, 'Library', 'Application Support')
    default:
      return process.env.XDG_CONFIG_HOME || path.join(HOME_DIR, '.config')
  }
}

/** First existing Cursor "User" directory (stable first, then Nightly). */
export function cursorUserDir() {
  if (process.env.AGENT_SPEND_CURSOR_USER_DIR) return process.env.AGENT_SPEND_CURSOR_USER_DIR
  const root = appDataRoot()
  for (const app of ['Cursor', 'Cursor Nightly']) {
    const dir = path.join(root, app, 'User')
    if (fs.existsSync(dir)) return dir
  }
  return path.join(root, 'Cursor', 'User')
}

export function cursorHomeDir() {
  return process.env.AGENT_SPEND_CURSOR_HOME_DIR || path.join(HOME_DIR, '.cursor')
}

/** All the paths Agent Spend reads. */
export function cursorPaths() {
  const userDir = cursorUserDir()
  return {
    userDir,
    globalStateDb: path.join(userDir, 'globalStorage', 'state.vscdb'),
    workspaceStorage: path.join(userDir, 'workspaceStorage'),
    projectsDir: path.join(cursorHomeDir(), 'projects'),
  }
}

/**
 * Agent-chat discovery from `~/.cursor/projects/<slug>/agent-transcripts/**.jsonl`
 * plus slug ⇄ folder-path resolution via Cursor's workspaceStorage.
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { HOME_DIR } from './cursorPaths.mjs'

export { cursorPaths } from './cursorPaths.mjs'

/** workspaceStorage hash -> decoded folder path */
export function loadWorkspaceFolders(workspaceStorageDir) {
  const map = new Map()
  if (!workspaceStorageDir || !fs.existsSync(workspaceStorageDir)) return map
  for (const ent of fs.readdirSync(workspaceStorageDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue
    const wj = path.join(workspaceStorageDir, ent.name, 'workspace.json')
    if (!fs.existsSync(wj)) continue
    try {
      const j = JSON.parse(fs.readFileSync(wj, 'utf8'))
      const raw = j.folder || j.workspace || ''
      map.set(ent.name.slice(0, 8), decodeFolderUri(raw))
    } catch {
      /* skip */
    }
  }
  return map
}

function decodeFolderUri(uri) {
  if (!uri || typeof uri !== 'string') return uri || ''
  if (!uri.startsWith('file://')) return uri
  try {
    let s = decodeURIComponent(uri.replace(/^file:\/\//, ''))
    // file:///d%3A/projects → /d:/projects → d:/projects
    if (/^\/[a-zA-Z]:/.test(s)) s = s.slice(1)
    else if (/^\/[a-zA-Z]\//.test(s)) s = `${s[1]}:${s.slice(2)}`
    return path.normalize(s)
  } catch {
    return uri
  }
}

function humanize(s) {
  if (!s?.trim()) return s
  return s
    .replace(/[-_+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Short title for UI (folder basename, or a slug heuristic when the folder is gone). */
export function projectDisplayName(folderPath, slug) {
  const resolved = folderPath || slugToPathHeuristic(slug)
  if (resolved) {
    let base = path.basename(resolved)
    if (/\.code-workspace$/i.test(base)) base = base.replace(/\.code-workspace$/i, '')
    if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(base)) return base // looks like a domain; keep as-is
    return humanize(base)
  }
  let tail = slug
  const homeSlug = encodePathToSlug(HOME_DIR)
  if (homeSlug && tail.toLowerCase().startsWith(homeSlug.toLowerCase() + '-')) {
    tail = tail.slice(homeSlug.length + 1).replace(/^Desktop-/i, '')
  }
  const tokens = tail.split('-').filter(Boolean)
  return humanize(tokens.slice(-3).join(' ') || slug)
}

/** One path segment the way Cursor encodes it inside a slug. */
function encodeSegment(name) {
  return name
    .replace(/\./g, '-')
    .replace(/\s+-\s+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
}

/** Cursor-style encoding of an absolute path → `.cursor/projects/<slug>` folder name. */
export function encodePathToSlug(absPath) {
  if (!absPath) return ''
  let p = path.normalize(absPath).replace(/\\/g, '/')
  p = p.replace(/^([A-Za-z]):[/\\]?/, (_, d) => `${d.toLowerCase()}-`)
  return encodeSegment(p.replace(/\//g, '-'))
}

function formatFolderPath(absPath) {
  if (!absPath) return absPath
  const n = path.normalize(absPath)
  return n.replace(/^([a-z]):/, (_, d) => `${d.toUpperCase()}:`)
}

/**
 * Best-effort inverse of encodePathToSlug by walking the filesystem: at each
 * directory, take the child whose encoded name matches the longest run of the
 * remaining slug tokens. That recovers hyphens and dots inside folder names
 * (`budget-sidekick`, `admin.example.com`) that a plain split cannot.
 */
export function slugToPathHeuristic(slug) {
  if (!slug) return null
  let cur
  let rest
  const drive = slug.match(/^([a-zA-Z])-(.*)$/)
  if (process.platform === 'win32' && drive) {
    cur = `${drive[1].toUpperCase()}:\\`
    rest = drive[2]
  } else {
    cur = path.sep
    rest = slug.replace(/^-/, '')
  }
  const tokens = rest.split('-').filter(Boolean)
  if (!tokens.length) return null

  let i = 0
  while (i < tokens.length) {
    let entries
    try {
      entries = fs.readdirSync(/*turbopackIgnore: true*/ cur, { withFileTypes: true }).filter((d) => d.isDirectory())
    } catch {
      return null
    }
    let best = null
    let bestLen = 0
    for (const ent of entries) {
      const enc = encodeSegment(ent.name).split('-').filter(Boolean)
      if (!enc.length || enc.length > tokens.length - i || enc.length <= bestLen) continue
      let match = true
      for (let k = 0; k < enc.length; k += 1) {
        if (enc[k].toLowerCase() !== tokens[i + k].toLowerCase()) {
          match = false
          break
        }
      }
      if (match) {
        best = ent.name
        bestLen = enc.length
      }
    }
    if (!best) return null
    cur = path.join(/*turbopackIgnore: true*/ cur, best)
    i += bestLen
  }
  return cur
}

/** Map transcript slug → normalized folder path (workspace.json first, then heuristic). */
export function buildSlugToFolderPathMap(workspaceStorageDir, projectsDir) {
  const map = new Map()
  const workspaceFolders = []

  if (workspaceStorageDir && fs.existsSync(workspaceStorageDir)) {
    for (const ent of fs.readdirSync(workspaceStorageDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      const wj = path.join(workspaceStorageDir, ent.name, 'workspace.json')
      if (!fs.existsSync(wj)) continue
      try {
        const j = JSON.parse(fs.readFileSync(wj, 'utf8'))
        const folder = decodeFolderUri(j.folder || j.workspace || '')
        if (!folder || folder.startsWith('file://')) continue
        const normalized = path.normalize(folder)
        if (normalized.includes(`${path.sep}.cursor${path.sep}projects${path.sep}`)) continue
        if (/\.code-workspace$/i.test(normalized)) continue
        workspaceFolders.push(normalized)
        const slugKey = encodePathToSlug(normalized)
        if (!map.has(slugKey)) map.set(slugKey, formatFolderPath(normalized))
      } catch {
        /* skip */
      }
    }
  }

  if (projectsDir && fs.existsSync(projectsDir)) {
    for (const ent of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      const slug = ent.name
      if (map.has(slug)) continue
      const fromWorkspace = workspaceFolders.find((folder) => encodePathToSlug(folder) === slug)
      if (fromWorkspace) {
        map.set(slug, formatFolderPath(fromWorkspace))
        continue
      }
      const guessed = slugToPathHeuristic(slug)
      if (guessed && fs.existsSync(/*turbopackIgnore: true*/ guessed)) map.set(slug, formatFolderPath(guessed))
    }
  }

  return map
}

export function resolveProjectFolderPath(slug, pathMap) {
  if (pathMap?.has(slug)) return pathMap.get(slug)
  const guessed = slugToPathHeuristic(slug)
  if (guessed && fs.existsSync(/*turbopackIgnore: true*/ guessed)) return formatFolderPath(guessed)
  return null
}

function passesFilter(slug, displayName, folderPath, workspaceFilter) {
  if (!workspaceFilter) return true
  const f = workspaceFilter.toLowerCase()
  const hay = [slug, displayName, folderPath].filter(Boolean).join(' ').toLowerCase()
  return hay.includes(f)
}

/** Stat-only rollups per `.cursor/projects/<slug>` — no agent-chat list. */
export function scanProjectsIndex(projectsDir, { workspaceFilter = null, workspaceStorageDir = null } = {}) {
  const projects = []
  if (!fs.existsSync(projectsDir)) return projects

  const pathMap = buildSlugToFolderPathMap(workspaceStorageDir, projectsDir)

  for (const root of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!root.isDirectory()) continue
    const slug = root.name
    const folderPath = resolveProjectFolderPath(slug, pathMap)
    const displayName = projectDisplayName(folderPath, slug)
    if (!passesFilter(slug, displayName, folderPath, workspaceFilter)) continue
    const transcriptsDir = path.join(projectsDir, slug, 'agent-transcripts')
    if (!fs.existsSync(transcriptsDir)) continue
    const agg = aggregateJsonlTree(transcriptsDir)
    if (agg.agentChats === 0) continue
    projects.push({
      slug,
      displayName,
      folderPath: folderPath ?? null,
      /** @deprecated use displayName */
      label: displayName,
      transcriptsDir,
      ...agg,
    })
  }

  projects.sort((a, b) => b.bytes - a.bytes)
  return projects
}

function aggregateJsonlTree(transcriptsDir) {
  let agentChats = 0
  let subagents = 0
  let bytes = 0
  let oldestMtimeMs = Infinity
  let newestMtimeMs = 0
  let parentAgentChats = 0

  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        walk(full)
        continue
      }
      if (!ent.name.endsWith('.jsonl')) continue
      const st = fs.statSync(full)
      agentChats += 1
      bytes += st.size
      if (st.mtimeMs < oldestMtimeMs) oldestMtimeMs = st.mtimeMs
      if (st.mtimeMs > newestMtimeMs) newestMtimeMs = st.mtimeMs
      if (full.includes(`${path.sep}subagents${path.sep}`)) subagents += 1
      else parentAgentChats += 1
    }
  }

  walk(transcriptsDir)
  return {
    agentChats,
    parentAgentChats,
    subagents,
    bytes,
    oldestMtimeMs: agentChats ? oldestMtimeMs : null,
    newestMtimeMs: agentChats ? newestMtimeMs : null,
  }
}

export async function scanTranscriptFiles(
  projectsDir,
  { workspaceFilter = null, projectSlug = null, maxFiles = 5000, workspaceStorageDir = null } = {}
) {
  const agentChats = []
  if (!fs.existsSync(projectsDir)) return agentChats

  const pathMap = buildSlugToFolderPathMap(workspaceStorageDir, projectsDir)

  const roots = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory())
  for (const root of roots) {
    const slug = root.name
    if (projectSlug && slug !== projectSlug) continue
    const folderPath = resolveProjectFolderPath(slug, pathMap)
    const displayName = projectDisplayName(folderPath, slug)
    if (!passesFilter(slug, displayName, folderPath, workspaceFilter)) continue
    const transcriptsDir = path.join(projectsDir, slug, 'agent-transcripts')
    if (!fs.existsSync(transcriptsDir)) continue
    walkJsonl(transcriptsDir, slug, displayName, folderPath ?? null, agentChats, maxFiles - agentChats.length)
    if (agentChats.length >= maxFiles) break
    if (projectSlug) break
  }

  const deduped = dedupeAgentChatsByComposerId(agentChats)
  deduped.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return deduped
}

/** Same composer id can appear as a top-level chat and again under another chat’s subagents/ folder. */
function transcriptEntryRank(entry) {
  let score = 0
  if (!entry.isSubagent) score += 4
  const norm = entry.path.replace(/\\/g, '/')
  if (norm.includes(`/agent-transcripts/${entry.id}/${entry.id}.jsonl`)) score += 2
  return score
}

export function dedupeAgentChatsByComposerId(chats) {
  const byId = new Map()
  for (const c of chats) {
    const prev = byId.get(c.id)
    if (!prev || transcriptEntryRank(c) > transcriptEntryRank(prev)) byId.set(c.id, c)
  }
  return [...byId.values()]
}

function walkJsonl(dir, projectSlug, projectDisplayName, projectFolderPath, out, budget) {
  if (budget <= 0) return
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (budget <= 0) return
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      walkJsonl(full, projectSlug, projectDisplayName, projectFolderPath, out, budget)
      continue
    }
    if (!ent.name.endsWith('.jsonl')) continue
    const st = fs.statSync(full)
    const rel = path.relative(path.join(dir, '..', '..'), full).replace(/\\/g, '/')
    const isSubagent = rel.includes('/subagents/')
    const id = ent.name.replace(/\.jsonl$/, '')
    let parentId = null
    if (isSubagent) {
      const parts = full.split(path.sep)
      const idx = parts.indexOf('agent-transcripts')
      if (idx >= 0 && parts[idx + 1]) parentId = parts[idx + 1]
    }
    out.push({
      id,
      parentId,
      isSubagent,
      projectSlug,
      projectDisplayName,
      projectFolderPath,
      /** @deprecated use projectDisplayName */
      projectLabel: projectDisplayName,
      path: full,
      sizeBytes: st.size,
      mtimeMs: st.mtimeMs,
      mtime: st.mtime.toISOString(),
    })
    budget -= 1
  }
}

/** Raw user text from one transcript JSONL row (agent transcript format). */
export function userPromptTextFromTranscriptRow(row, { singleLine = false } = {}) {
  if (row?.role !== 'user') return ''
  const parts = row?.message?.content
  let text = ''
  if (typeof parts === 'string') text = parts
  else if (Array.isArray(parts)) {
    text = parts
      .filter((p) => p?.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n')
  }
  if (!text.trim()) return ''
  text = text
    .replace(/<timestamp>[\s\S]*?<\/timestamp>\s*/gi, '')
    .replace(/<\/?user_query>/gi, '')
    .trim()
  if (singleLine) text = text.replace(/\s+/g, ' ').trim()
  return text
}

/** First user message as a display title when composerData.name is missing. */
export function titleFromTranscriptSync(filePath, maxLen = 72) {
  if (!filePath || !fs.existsSync(filePath)) return null
  let fd
  try {
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(96 * 1024)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    const chunk = buf.subarray(0, n).toString('utf8')
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      const text = userPromptTextFromTranscriptRow(row, { singleLine: true })
      if (!text) continue
      if (text.length > maxLen) return text.slice(0, maxLen - 1).trimEnd() + '…'
      return text
    }
  } catch {
    return null
  } finally {
    if (fd != null) fs.closeSync(fd)
  }
  return null
}

/** All user prompts in an agent chat transcript (not assistant/tool bubbles). */
export async function listUserPromptsFromTranscript(filePath, { maxPrompts = 500 } = {}) {
  const prompts = []
  if (!filePath || !fs.existsSync(filePath)) return prompts
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of rl) {
    if (prompts.length >= maxPrompts) break
    if (!line.trim()) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const text = userPromptTextFromTranscriptRow(row)
    if (!text) continue
    prompts.push({ n: prompts.length + 1, text })
  }
  return prompts
}

/** Count lines + tool_use names — only when user opens an agent chat. */
export async function summarizeTranscript(filePath) {
  let lineCount = 0
  let toolCalls = 0
  const tools = new Map()
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.trim()) continue
    lineCount += 1
    try {
      const row = JSON.parse(line)
      const content = row?.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block?.type === 'tool_use' || block?.name) {
          toolCalls += 1
          const name = block.name || block.toolName || 'tool'
          tools.set(name, (tools.get(name) || 0) + 1)
        }
      }
    } catch {
      /* non-json line */
    }
  }
  return { lineCount, toolCalls, tools: Object.fromEntries(tools) }
}

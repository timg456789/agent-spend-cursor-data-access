function monthKey(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function dayKey(ms) {
  const d = new Date(ms)
  return `${monthKey(ms)}-${String(d.getDate()).padStart(2, '0')}`
}

function monthLabel(key) {
  const [y, m] = key.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleString(undefined, { month: 'long', year: 'numeric' })
}

function dayLabel(key) {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

/** Sum raw model rows by exact model id (no family bunching). */
function mergeRawModelRows(rows) {
  const map = new Map()
  for (const row of rows || []) {
    const key = row.model || 'unknown'
    const cur = map.get(key) || {
      model: key,
      inputTokens: 0,
      outputTokens: 0,
      tokenTotal: 0,
      usd: 0,
      priced: false,
    }
    cur.inputTokens += row.inputTokens || 0
    cur.outputTokens += row.outputTokens || 0
    cur.usd += row.usd || 0
    cur.priced = cur.priced || !!row.priced
    map.set(key, cur)
  }
  for (const cur of map.values()) {
    cur.tokenTotal = cur.inputTokens + cur.outputTokens
    cur.usd = Math.round(cur.usd * 10000) / 10000
  }
  return [...map.values()].sort((a, b) => b.usd - a.usd || b.tokenTotal - a.tokenTotal)
}

function modelRowsFromRun(r) {
  return [{ model: r.model || 'unknown', inputTokens: r.input || 0, outputTokens: r.output || 0, usd: r.usd || 0, priced: r.priced }]
}

/** Month/day rollups from per-run timestamps (preferred). */
function buildFromRunUsage(runUsage, agentChatMeta, byAgentChat) {
  const metaById = new Map(agentChatMeta.map((s) => [s.id, s]))
  const nameById = new Map((byAgentChat || []).map((r) => [r.id, r.name?.trim() || null]))
  const agentChatRunTotals = new Map((byAgentChat || []).map((r) => [r.id, r.runCount || 0]))
  const monthsMap = new Map()
  const daysMap = new Map()

  for (const r of runUsage) {
    let dk = r.dayKey
    if (!dk && r.atMs) dk = dayKey(r.atMs)
    if (!dk) {
      const fallback = metaById.get(r.composerId)?.mtimeMs
      if (fallback) dk = dayKey(fallback)
    }
    if (!dk) continue

    const mk = dk.slice(0, 7)
    for (const [map, key] of [
      [monthsMap, mk],
      [daysMap, dk],
    ]) {
      let bucket = map.get(key)
      if (!bucket) {
        bucket = {
          key,
          costUsd: 0,
          runCount: 0,
          chatIds: new Set(),
          byModelRows: [],
          chats: new Map(),
        }
        map.set(key, bucket)
      }
      bucket.costUsd += r.usd || 0
      bucket.runCount += 1
      bucket.chatIds.add(r.composerId)
      bucket.byModelRows.push(...modelRowsFromRun(r))
      let chat = bucket.chats.get(r.composerId)
      if (!chat) {
        chat = {
          composerId: r.composerId,
          name: nameById.get(r.composerId) || null,
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          bubblesOnDay: 0,
          tokens: 0,
          byModelRows: [],
          bubblesOnDayList: [],
          isSubagent: !!metaById.get(r.composerId)?.isSubagent,
        }
        bucket.chats.set(r.composerId, chat)
      }
      chat.costUsd += r.usd || 0
      chat.inputTokens += r.input || 0
      chat.outputTokens += r.output || 0
      chat.bubblesOnDay += 1
      chat.tokens += (r.input || 0) + (r.output || 0)
      chat.byModelRows.push(...modelRowsFromRun(r))
      chat.bubblesOnDayList.push(r)
    }
  }

  function mapRunRow(x) {
    return {
      composerId: x.composerId,
      runId: x.runId,
      atMs: x.atMs,
      role: x.role,
      model: x.model,
      usd: x.usd,
      tokens: (x.input || 0) + (x.output || 0),
    }
  }

  function finalizeBucket(b, isDay, agentChatRunTotals) {
    const chats = [...b.chats.values()]
      .map((c) => {
        const bubblesOnDayList = c.bubblesOnDayList
          .sort((a, x) => (x.atMs || 0) - (a.atMs || 0))
          .map(mapRunRow)
        const bubblesTotalInAgentChat = agentChatRunTotals.get(c.composerId) ?? c.bubblesOnDay
        return {
          composerId: c.composerId,
          name: c.name || nameById.get(c.composerId) || null,
          costUsd: Math.round(c.costUsd * 10000) / 10000,
          inputTokens: c.inputTokens || 0,
          outputTokens: c.outputTokens || 0,
          bubblesOnDay: c.bubblesOnDay,
          bubblesTotalInAgentChat,
          tokens: c.tokens,
          isSubagent: c.isSubagent,
          byModel: mergeRawModelRows(c.byModelRows),
          bubblesOnDayList,
        }
      })
      .sort((a, x) => x.costUsd - a.costUsd)

    return {
      key: b.key,
      label: isDay ? dayLabel(b.key) : monthLabel(b.key),
      monthKey: isDay ? b.key.slice(0, 7) : b.key,
      costUsd: Math.round(b.costUsd * 10000) / 10000,
      bubbleCount: b.runCount,
      agentChatCount: b.chatIds.size,
      byModel: mergeRawModelRows(b.byModelRows),
      agentChats: chats,
    }
  }

  const months = [...monthsMap.values()]
    .map((b) => finalizeBucket(b, false, agentChatRunTotals))
    .sort((a, x) => x.key.localeCompare(a.key))

  const days = [...daysMap.values()]
    .map((b) => finalizeBucket(b, true, agentChatRunTotals))
    .sort((a, x) => x.key.localeCompare(a.key))

  const agentChatUsage = (byAgentChat || []).map((row) => {
    const meta = metaById.get(row.id)
    const ms = meta?.mtimeMs
    return {
      id: row.id,
      mtimeMs: ms,
      monthKey: ms ? monthKey(ms) : null,
      dayKey: ms ? dayKey(ms) : null,
      isSubagent: !!meta?.isSubagent,
      costUsd: row.costUsd,
      bubbles: row.runCount || 0,
      tokens: row.total || 0,
      note: 'Whole agent-chat totals; day drill-down uses bubble timestamps.',
    }
  })

  return {
    months,
    days,
    agentChatUsage,
    attribution: 'bubble-timestamp',
    bubblesWithTime: runUsage.filter((r) => r.atMs).length,
    bubblesTotal: runUsage.length,
  }
}

/** Fallback when run timestamps were not collected. */
function buildFromAgentChatMtime(agentChatMeta, byAgentChat) {
  const metaById = new Map(agentChatMeta.map((s) => [s.id, s]))
  const monthsMap = new Map()
  const daysMap = new Map()

  for (const row of byAgentChat) {
    const meta = metaById.get(row.id)
    const ms = meta?.mtimeMs
    if (!ms) continue
    const dk = dayKey(ms)
    const mk = monthKey(ms)
    const byModel = mergeRawModelRows(row.byModel || [])
    const costUsd = byModel.reduce((a, m) => a + (m.usd || 0), 0) || row.costUsd || 0
    const chatRow = {
      composerId: row.id,
      name: row.name?.trim() || null,
      costUsd,
      inputTokens: row.input || 0,
      outputTokens: row.output || 0,
      bubbles: row.runCount || 0,
      tokens: row.total || 0,
      isSubagent: !!meta?.isSubagent,
      byModel,
    }

    for (const [map, key] of [
      [monthsMap, mk],
      [daysMap, dk],
    ]) {
      let b = map.get(key)
      if (!b) {
        b = { key, costUsd: 0, runCount: 0, agentChatCount: 0, byModelRows: [], agentChats: [] }
        map.set(key, b)
      }
      b.costUsd += costUsd
      b.runCount += chatRow.bubbles
      b.agentChatCount += 1
      for (const m of row.byModel || []) b.byModelRows.push(m)
      b.agentChats.push(chatRow)
    }
  }

  const months = [...monthsMap.values()]
    .map((b) => ({
      key: b.key,
      label: monthLabel(b.key),
      monthKey: b.key,
      costUsd: Math.round(b.costUsd * 10000) / 10000,
      bubbleCount: b.runCount,
      agentChatCount: b.agentChatCount,
      byModel: mergeRawModelRows(b.byModelRows),
      agentChats: b.agentChats.sort((a, x) => x.costUsd - a.costUsd),
      bubbles: [],
    }))
    .sort((a, x) => x.key.localeCompare(a.key))

  const days = [...daysMap.values()]
    .map((b) => ({
      key: b.key,
      label: dayLabel(b.key),
      monthKey: b.key.slice(0, 7),
      costUsd: Math.round(b.costUsd * 10000) / 10000,
      bubbleCount: b.runCount,
      agentChatCount: b.agentChatCount,
      byModel: mergeRawModelRows(b.byModelRows),
      agentChats: b.agentChats.sort((a, x) => x.costUsd - a.costUsd),
      bubbles: [],
    }))
    .sort((a, x) => x.key.localeCompare(a.key))

  return {
    months,
    days,
    agentChatUsage: [],
    attribution: 'transcript-file-mtime',
    bubblesWithTime: 0,
    bubblesTotal: 0,
  }
}

export function buildUsageTimeline(agentChatMeta, byAgentChat, runUsage = null) {
  if (runUsage?.length) return buildFromRunUsage(runUsage, agentChatMeta, byAgentChat)
  return buildFromAgentChatMtime(agentChatMeta, byAgentChat)
}

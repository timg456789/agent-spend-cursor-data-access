/**
 * Token + spend rollups for agent chats, read from Cursor's local state.vscdb.
 */
import fs from 'node:fs'
import { readComposerData, readComposerHeaderName, readBubbles, readBubble } from './stateDb.mjs'
import { estimateUsd, applyPricingToByModel } from './pricingMath.mjs'
import { assertPricingTable } from './pricingTable.mjs'
import { normalizeBubble, aggregateTokenTotals, addBubbleToTokenTotals } from './bubbleTokens.mjs'
import { buildUsageTimeline } from './usageTimeline.mjs'
import { titleFromTranscriptSync } from './scan.mjs'

export { openGlobalStateDb } from './stateDb.mjs'
export { estimateUsd, applyPricingToByModel, resolveModelPricing } from './pricingMath.mjs'

const yieldEventLoop = () => new Promise((resolve) => setImmediate(resolve))

/** Drop per-bubble rows from timeline before sending to the browser (large projects). */
export function slimTimelineForClient(timeline) {
  if (!timeline) return timeline
  const slimBucket = (b) => ({
    ...b,
    agentChats: (b.agentChats || []).map(({ bubblesOnDayList: _drop, ...chat }) => chat),
  })
  return {
    ...timeline,
    months: (timeline.months || []).map(slimBucket),
    days: (timeline.days || []).map(slimBucket),
  }
}

function charsToTokens(len) {
  if (!len) return 0
  return Math.max(1, Math.round(len / 4))
}

/** Rough tokens from agent-transcript JSONL (no billing accuracy). */
export function estimateTokensFromJsonlLine(row) {
  const role = row?.role
  const content = row?.message?.content
  if (!Array.isArray(content)) return { input: 0, output: 0 }

  let chars = 0
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') chars += block.text.length
    if (block?.type === 'tool_use' || block?.name) {
      chars += JSON.stringify(block.input ?? block).length
    }
  }
  if (role === 'user') return { input: charsToTokens(chars), output: 0 }
  if (role === 'assistant') return { input: 0, output: charsToTokens(chars) }
  return { input: 0, output: 0 }
}

/** Default model per composer (indexed point lookups), yielding so the HTTP server stays responsive. */
export async function composerModelsBatchAsync(db, composerIds) {
  const map = new Map()
  if (!db || !composerIds?.length) return map
  for (let i = 0; i < composerIds.length; i += 1) {
    const id = composerIds[i]
    const cd = readComposerData(db, id)
    map.set(id, cd?.modelConfig?.modelName || cd?.model || null)
    if (i > 0 && i % 20 === 0) await yieldEventLoop()
  }
  return map
}

/** Display title from composerData / composerHeaders (no transcript read). */
export function composerDisplayNameFromDb(db, composerId) {
  if (!db || !composerId) return null
  const cd = readComposerData(db, composerId)
  return cd?.name?.trim() || readComposerHeaderName(db, composerId) || null
}

/** id → title for all agent chats (DB first, then first user line in transcript). */
export async function composerDisplayNamesBatchAsync(db, agentChats) {
  const names = {}
  if (!db || !agentChats?.length) return names
  for (let i = 0; i < agentChats.length; i += 1) {
    const { id, path: filePath } = agentChats[i]
    let n = composerDisplayNameFromDb(db, id)
    if (!n && filePath) n = titleFromTranscriptSync(filePath)?.trim() || null
    if (n) names[id] = n
    if (i > 0 && i % 25 === 0) await yieldEventLoop()
  }
  return names
}

function emptyComposerTokenResult(composerId, chatName, composerDataMs) {
  return {
    composerId,
    name: chatName,
    runCount: 0,
    tokens: { input: 0, output: 0, total: 0, measured: 0, estimated: 0 },
    cost: { usd: 0, source: 'unpriced', unpricedTokens: 0, byModel: [] },
    found: false,
    timing: { composerDataMs, bubbleFetchMs: 0, bubbleProcessMs: 0, sqliteMs: composerDataMs },
  }
}

function runAtMs(header, raw) {
  const v = header?.startedAtMs ?? header?.completedAtMs ?? raw?.createdAt ?? null
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function mergeModelTokens(into, rows) {
  for (const row of rows) {
    const key = row.model || 'unknown'
    const cur = into.get(key) || { model: key, inputTokens: 0, outputTokens: 0 }
    cur.inputTokens += row.inputTokens
    cur.outputTokens += row.outputTokens
    into.set(key, cur)
  }
}

/** Measured + char-estimated tokens for one composer (agent chat) id. */
export function tokensFromComposerDb(db, composerId, { pricingTable } = {}) {
  assertPricingTable(pricingTable)
  const t0 = performance.now()
  const cd = readComposerData(db, composerId)
  const composerDataMs = performance.now() - t0
  const headers = cd?.fullConversationHeadersOnly || []
  const headerRunIds = headers.map((h) => h.bubbleId).filter(Boolean)
  const chatName = cd?.name?.trim() || readComposerHeaderName(db, composerId) || null
  if (headerRunIds.length === 0) {
    return emptyComposerTokenResult(composerId, chatName, composerDataMs)
  }

  const defaultModel = cd?.modelConfig?.modelName || cd?.model || null
  const tFetch = performance.now()
  const runRows = readBubbles(db, composerId, headerRunIds)
  const bubbleFetchMs = performance.now() - tFetch

  const runUsage = []
  const chatByModel = new Map()
  const tokens = {
    input: 0,
    output: 0,
    total: 0,
    measured: 0,
    estimated: 0,
    fromCursor: 0,
    fromContentEstimate: 0,
    emptyBubbles: 0,
  }
  let bubblesMissing = 0
  let hydrated = 0
  const tProcess = performance.now()
  for (let i = 0; i < headers.length; i += 1) {
    const h = headers[i]
    const raw = runRows.get(h.bubbleId)
    if (!raw) {
      bubblesMissing += 1
      continue
    }
    const msg = normalizeBubble(raw, { index: i, composerId, defaultModel })
    hydrated += 1
    addBubbleToTokenTotals(tokens, msg)
    mergeModelTokens(chatByModel, [
      { model: msg.model || 'unknown', inputTokens: msg.tokens.input, outputTokens: msg.tokens.output },
    ])

    const runPrice = estimateUsd(msg.model, msg.tokens.input, msg.tokens.output, pricingTable)
    runUsage.push({
      composerId,
      runId: h.bubbleId,
      index: i,
      atMs: runAtMs(h, raw),
      role: msg.role,
      model: msg.model,
      input: msg.tokens.input,
      output: msg.tokens.output,
      usd: runPrice.usd,
      priced: runPrice.priced,
    })
  }

  const bubbleProcessMs = performance.now() - tProcess
  const pricedChat = applyPricingToByModel(chatByModel, pricingTable)
  const cost = {
    usd: pricedChat.costUsd,
    byModel: pricedChat.byModel,
    source: pricedChat.costUsd ? 'priced' : 'unpriced',
    unpricedTokens: pricedChat.unpricedTokens,
  }
  const sqliteMs = composerDataMs + bubbleFetchMs + bubbleProcessMs
  return {
    composerId,
    name: chatName,
    agentChatDefaultModel: defaultModel,
    runCount: headerRunIds.length,
    hydrated,
    bubblesMissing,
    tokens,
    cost,
    runUsage,
    found: true,
    timing: { composerDataMs, bubbleFetchMs, bubbleProcessMs, sqliteMs },
  }
}

/** Redacted run + why model/tokens look the way they do (for UI debug). */
export function inspectComposerRun(db, composerId, runId = null) {
  const cd = readComposerData(db, composerId)
  if (!cd) return { error: 'composerData not found', composerId }

  const defaultModel = cd?.modelConfig?.modelName || cd?.model || null
  const headers = cd.fullConversationHeadersOnly || []
  let pickId = runId
  if (!pickId) {
    const assistant = headers.find((h) => h.type === 2)
    pickId = assistant?.bubbleId || headers[0]?.bubbleId
  }
  if (!pickId) return { error: 'no runs in agent chat', composerId, agentChatDefaultModel: defaultModel }

  const raw = readBubble(db, composerId, pickId)
  if (!raw) return { error: 'run row missing in cursorDiskKV', composerId, runId: pickId, agentChatDefaultModel: defaultModel }

  const idx = headers.findIndex((h) => h.bubbleId === pickId)
  const msg = normalizeBubble(raw, { index: idx >= 0 ? idx : 0, composerId, defaultModel })

  const tool = raw.toolFormerData
  return {
    composerId,
    runId: pickId,
    headerIndex: idx,
    agentChatDefaultModel: defaultModel,
    modelConfig: cd.modelConfig || null,
    runSummary: {
      type: raw.type,
      role: msg.role,
      tokenCount: raw.tokenCount || null,
      modelInfo: raw.modelInfo ?? null,
      capabilityType: raw.capabilityType ?? null,
      textLength: (raw.text || '').length,
      textPreview: (raw.text || '').slice(0, 500),
      hasToolFormerData: !!tool,
      toolName: tool?.name ?? tool?.toolName ?? null,
      thinkingLength: (raw.thinking?.text || '').length,
      topLevelKeys: Object.keys(raw).sort(),
    },
    normalizedTokens: msg.tokens,
    normalizedModel: msg.model,
    normalizedModelSource: msg.modelSource,
    note: 'Per-run modelInfo is often empty; default model comes from composerData.modelConfig.',
  }
}

export async function estimateProjectTokensFromJsonl(agentChatRows) {
  const readline = await import('node:readline')
  const byAgentChat = []
  const totals = { input: 0, output: 0, total: 0, files: agentChatRows.length, source: 'jsonl-estimate' }

  for (const row of agentChatRows) {
    let input = 0
    let output = 0
    const stream = fs.createReadStream(row.path, { encoding: 'utf8' })
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line.trim()) continue
      try {
        const t = estimateTokensFromJsonlLine(JSON.parse(line))
        input += t.input
        output += t.output
      } catch {
        /* skip */
      }
    }
    const total = input + output
    totals.input += input
    totals.output += output
    totals.total += total
    byAgentChat.push({ id: row.id, isSubagent: row.isSubagent, sizeBytes: row.sizeBytes, input, output, total })
  }

  byAgentChat.sort((a, b) => b.total - a.total)
  return { totals, byAgentChat }
}

export function expectedRunCount(db, composerId) {
  const cd = readComposerData(db, composerId)
  return cd?.fullConversationHeadersOnly?.length ?? 0
}

async function emitProgress(onProgress, timing, ev) {
  if (!onProgress) return
  const t = performance.now()
  const r = onProgress(ev)
  if (r && typeof r.then === 'function') await r
  timing.progressEmitMs += performance.now() - t
}

async function yieldForProgress(maybeYield, timing) {
  const t = performance.now()
  await maybeYield()
  timing.yieldMs += performance.now() - t
}

/** @param {{ onProgress?: (ev: object) => void | Promise<void>, yieldProgress?: boolean, progressEvery?: number }} [opts] */
export async function tokensFromComposerDbBatch(db, composerIds, opts = {}) {
  const { onProgress, yieldProgress = false, progressEvery = 1, pricingTable } = opts
  assertPricingTable(pricingTable)
  const progressStride = Math.max(1, progressEvery)
  const maybeYield = yieldProgress ? yieldEventLoop : async () => {}

  const byAgentChat = []
  const byModelMap = new Map()
  const totals = {
    input: 0,
    output: 0,
    total: 0,
    measured: 0,
    estimated: 0,
    bubblesListed: 0,
    bubblesLoaded: 0,
    bubblesMissing: 0,
    emptyBubbles: 0,
    source: 'cursor-db',
  }
  const uniqueComposerIds = [...new Set(composerIds)]
  totals.files = uniqueComposerIds.length
  const totalAgentChats = uniqueComposerIds.length

  const timing = {
    composerDataMs: 0,
    bubbleFetchMs: 0,
    bubbleProcessMs: 0,
    sqliteMs: 0,
    progressEmitMs: 0,
    yieldMs: 0,
    batchRollupMs: 0,
  }

  await emitProgress(onProgress, timing, {
    phase: 'start',
    totalAgentChats,
    message: 'Reading usage from Cursor’s local database · ' + totalAgentChats.toLocaleString() + ' agent chats…',
  })
  await yieldForProgress(maybeYield, timing)

  let agentChatsDone = 0
  let runsDone = 0
  const runUsage = []
  let cachedRunningPrice = { costUsd: 0, inputCostUsd: 0, outputCostUsd: 0 }

  async function emitAgentChatProgress(extra, o = {}) {
    if (!onProgress) return
    const lightweight = o.lightweight ?? !!extra.working
    if (!lightweight) cachedRunningPrice = applyPricingToByModel(byModelMap, pricingTable)
    await emitProgress(onProgress, timing, {
      phase: 'agentChat',
      agentChatsDone,
      totalAgentChats,
      bubblesDone: runsDone,
      runningInput: totals.input,
      runningOutput: totals.output,
      runningTokens: totals.total,
      runningMeasured: totals.measured,
      runningEstimated: totals.estimated,
      runningCostUsd: cachedRunningPrice.costUsd,
      runningInputCostUsd: cachedRunningPrice.inputCostUsd,
      runningOutputCostUsd: cachedRunningPrice.outputCostUsd,
      ...extra,
    })
    if (!lightweight) await yieldForProgress(maybeYield, timing)
  }

  for (const composerId of uniqueComposerIds) {
    const r = tokensFromComposerDb(db, composerId, { pricingTable })

    if (r.timing) {
      timing.composerDataMs += r.timing.composerDataMs
      timing.bubbleFetchMs += r.timing.bubbleFetchMs
      timing.bubbleProcessMs += r.timing.bubbleProcessMs
      timing.sqliteMs += r.timing.sqliteMs
    }
    agentChatsDone += 1
    runsDone += r.runCount
    if (r.runUsage?.length) {
      for (let ri = 0; ri < r.runUsage.length; ri += 1) runUsage.push(r.runUsage[ri])
    }
    totals.bubblesListed += r.runCount || 0
    totals.bubblesLoaded += r.hydrated || 0
    totals.bubblesMissing += r.bubblesMissing || 0
    totals.emptyBubbles += r.tokens.emptyBubbles || 0
    totals.input += r.tokens.input
    totals.output += r.tokens.output
    totals.total += r.tokens.total
    totals.measured += r.tokens.measured
    totals.estimated += r.tokens.estimated
    mergeModelTokens(byModelMap, r.cost.byModel)
    byAgentChat.push({
      id: composerId,
      name: r.name ?? null,
      runCount: r.runCount,
      hydrated: r.hydrated,
      found: r.found,
      input: r.tokens.input,
      output: r.tokens.output,
      total: r.tokens.total,
      measured: r.tokens.measured,
      estimated: r.tokens.estimated,
      costUsd: r.cost.usd,
      byModel: r.cost.byModel || [],
    })
    const reportProgress =
      agentChatsDone === 1 || agentChatsDone % progressStride === 0 || agentChatsDone === totalAgentChats
    if (reportProgress) {
      await emitAgentChatProgress(
        { composerId, composerStepTotal: r.runCount || 0, composerStepDone: r.runCount || 0, working: false },
        { lightweight: false }
      )
    }
  }

  const tRollup = performance.now()
  byAgentChat.sort((a, b) => b.total - a.total)
  const priced = applyPricingToByModel(byModelMap, pricingTable)
  timing.batchRollupMs += performance.now() - tRollup

  return {
    totals,
    byAgentChat,
    runUsage,
    timing,
    byModel: priced.byModel,
    costUsd: priced.costUsd,
    inputCostUsd: priced.inputCostUsd,
    outputCostUsd: priced.outputCostUsd,
    unpricedTokens: priced.unpricedTokens,
    pricingNote: pricingTable?.note ?? null,
    pricingCurrency: pricingTable?.currency ?? null,
  }
}

export function assembleScanTiming({ diskScanMs, dbOpenMs, batchTiming, payloadBuildMs, timelineBuildMs, responseDoneEmitMs = 0 }) {
  const sqlite = batchTiming || {}
  const st = {
    diskScanMs: Math.round(diskScanMs ?? 0),
    dbOpenMs: Math.round(dbOpenMs ?? 0),
    sqliteMs: Math.round(sqlite.sqliteMs ?? 0),
    sqliteComposerDataMs: Math.round(sqlite.composerDataMs ?? 0),
    sqliteBubbleFetchMs: Math.round(sqlite.bubbleFetchMs ?? 0),
    sqliteBubbleProcessMs: Math.round(sqlite.bubbleProcessMs ?? 0),
    sseProgressEmitMs: Math.round(sqlite.progressEmitMs ?? 0),
    sseProgressYieldMs: Math.round(sqlite.yieldMs ?? 0),
    sqliteBatchRollupMs: Math.round(sqlite.batchRollupMs ?? 0),
    payloadBuildMs: Math.round(payloadBuildMs ?? 0),
    timelineBuildMs: Math.round(timelineBuildMs ?? 0),
    responseDoneEmitMs: Math.round(responseDoneEmitMs ?? 0),
  }
  st.totalMs =
    st.diskScanMs +
    st.dbOpenMs +
    st.sqliteMs +
    st.sseProgressEmitMs +
    st.sseProgressYieldMs +
    st.sqliteBatchRollupMs +
    st.payloadBuildMs +
    st.responseDoneEmitMs
  return st
}

export function buildProjectUsagePayload(slug, agentChats, tokenRollup, scanTimingParts = {}) {
  const { pricingTable } = scanTimingParts
  assertPricingTable(pricingTable)
  const tt = tokenRollup.totals || {}
  const bubblesListed = tt.bubblesListed ?? 0
  const bubblesLoaded = tt.bubblesLoaded ?? 0
  const bubblesMissing = tt.bubblesMissing ?? 0
  const tTimeline = performance.now()
  const timelineFull = buildUsageTimeline(agentChats, tokenRollup.byAgentChat, tokenRollup.runUsage)
  const timeline = slimTimelineForClient(timelineFull)
  const timelineBuildMs = Math.round(performance.now() - tTimeline)
  const agentChatNames = {}
  const chatMetaById = new Map(agentChats.map((c) => [c.id, c]))
  for (const row of tokenRollup.byAgentChat || []) {
    let n = row.name?.trim()
    if (!n) n = titleFromTranscriptSync(chatMetaById.get(row.id)?.path)?.trim() || null
    if (n) agentChatNames[row.id] = n
  }
  for (const chat of agentChats) {
    if (agentChatNames[chat.id]?.trim()) continue
    const t = titleFromTranscriptSync(chat.path)?.trim()
    if (t) agentChatNames[chat.id] = t
  }

  const totalsByChatId = new Map(
    (tokenRollup.byAgentChat || []).map((r) => [
      r.id,
      { name: r.name?.trim() || agentChatNames[r.id] || null, input: r.input || 0, output: r.output || 0 },
    ])
  )

  function tokensFromByModel(byModel) {
    if (!byModel?.length) return { input: 0, output: 0 }
    return byModel.reduce(
      (acc, m) => {
        acc.input += m.inputTokens || 0
        acc.output += m.outputTokens || 0
        return acc
      },
      { input: 0, output: 0 }
    )
  }

  function enrichTimelineChat(c) {
    const id = c.composerId || c.id
    const totals = totalsByChatId.get(id)
    const name = (c.name || agentChatNames[id] || totals?.name || '').trim() || null
    if (name) agentChatNames[id] = name
    let inputTokens = c.inputTokens ?? c.input
    let outputTokens = c.outputTokens ?? c.output
    if (!(inputTokens || outputTokens) && c.byModel?.length) {
      const fromModels = tokensFromByModel(c.byModel)
      inputTokens = fromModels.input
      outputTokens = fromModels.output
    }
    // Never substitute whole-chat totals — day/month rows must stay slice-accurate.
    return { ...c, composerId: id, name, inputTokens: inputTokens || 0, outputTokens: outputTokens || 0 }
  }

  for (const bucket of [...(timeline.months || []), ...(timeline.days || [])]) {
    if (bucket.agentChats?.length) bucket.agentChats = bucket.agentChats.map(enrichTimelineChat)
  }

  const dayAgentChats = {}
  for (const day of timeline.days || []) {
    dayAgentChats[day.key] = (day.agentChats || []).map((c) => ({
      composerId: c.composerId,
      name: c.name,
      inputTokens: c.inputTokens,
      outputTokens: c.outputTokens,
      costUsd: c.costUsd,
    }))
  }

  const tModels = performance.now()
  /** Per agent-chat models from runs (not just composer modelConfig). */
  const modelsByAgentChat = {}
  for (const row of tokenRollup.byAgentChat) {
    const priced = applyPricingToByModel(
      new Map(
        (row.byModel || []).map((m) => [
          m.model || 'unknown',
          { model: m.model || 'unknown', inputTokens: m.inputTokens || 0, outputTokens: m.outputTokens || 0 },
        ])
      ),
      pricingTable
    ).byModel
    modelsByAgentChat[row.id] = priced.map((m) => ({ model: m.model, tokenTotal: m.tokenTotal, usd: m.usd, priced: m.priced }))
  }
  const modelsBuildMs = Math.round(performance.now() - tModels)
  const payloadBuildMs = modelsBuildMs + timelineBuildMs

  const scanTiming = assembleScanTiming({
    diskScanMs: scanTimingParts.diskScanMs,
    dbOpenMs: scanTimingParts.dbOpenMs,
    batchTiming: tokenRollup.timing,
    payloadBuildMs,
    timelineBuildMs,
    responseDoneEmitMs: scanTimingParts.responseDoneEmitMs ?? 0,
  })
  if (scanTimingParts.wallMs != null) {
    scanTiming.wallMs = Math.round(scanTimingParts.wallMs)
    scanTiming.unaccountedMs = scanTiming.wallMs - scanTiming.totalMs
  }

  return {
    slug,
    displayName: agentChats[0]?.projectDisplayName ?? agentChats[0]?.projectLabel,
    folderPath: agentChats[0]?.projectFolderPath ?? null,
    label: agentChats[0]?.projectDisplayName ?? agentChats[0]?.projectLabel,
    scannedMs: scanTiming.totalMs,
    scanTiming,
    scannedAt: new Date().toISOString(),
    method: 'all-bubbles-per-agent-chat-in-project',
    agentChatCount: agentChats.length,
    parentAgentChats: agentChats.filter((s) => !s.isSubagent).length,
    workers: agentChats.filter((s) => s.isSubagent).length,
    bubblesTotal: bubblesListed,
    bubblesListed,
    bubblesLoaded,
    bubblesMissing,
    emptyBubbles: tt.emptyBubbles ?? 0,
    tokens: tokenRollup.totals,
    costUsd: tokenRollup.costUsd ?? 0,
    inputCostUsd: tokenRollup.inputCostUsd ?? 0,
    outputCostUsd: tokenRollup.outputCostUsd ?? 0,
    unpricedTokens: tokenRollup.unpricedTokens ?? 0,
    modelsMissingPricing: (tokenRollup.byModel ?? [])
      .filter((m) => !m.priced && (m.tokenTotal || 0) > 0)
      .map((m) => ({
        model: m.model || 'unknown',
        inputTokens: m.inputTokens || 0,
        outputTokens: m.outputTokens || 0,
        tokenTotal: m.tokenTotal || 0,
      }))
      .sort((a, b) => b.tokenTotal - a.tokenTotal),
    byModel: tokenRollup.byModel ?? [],
    modelsByAgentChat,
    timeline,
    dayAgentChats,
    agentChatNames,
    agentChatRollup: (tokenRollup.byAgentChat || [])
      .map((r) => ({
        id: r.id,
        name: agentChatNames[r.id] || r.name?.trim() || null,
        input: r.input || 0,
        output: r.output || 0,
        costUsd: Math.round((r.costUsd || 0) * 10000) / 10000,
        runCount: r.runCount || 0,
      }))
      .sort((a, b) => b.costUsd - a.costUsd || b.output - a.output),
    topAgentChats: tokenRollup.byAgentChat.slice(0, 15).map((s) => {
      const meta = agentChats.find((x) => x.id === s.id)
      return { ...s, isSubagent: meta?.isSubagent ?? false }
    }),
    pricingNote: tokenRollup.pricingNote,
    pricingCurrency: tokenRollup.pricingCurrency ?? 'USD',
  }
}

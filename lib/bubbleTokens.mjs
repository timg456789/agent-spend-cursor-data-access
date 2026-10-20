/**
 * Per-step ("bubble") token counts from Cursor's local store.
 *
 * Each bubble JSON in state.vscdb may include `tokenCount`. When Cursor did not
 * store counts (most agent/tool turns), we estimate from stored text and tool payload.
 */

export const CHARS_PER_TOKEN = 4

export function estimateTokensFromChars(len) {
  if (!len) return 0
  return Math.max(1, Math.round(len / CHARS_PER_TOKEN))
}

function toolFormerCharLen(raw) {
  const tf = raw?.toolFormerData
  if (!tf) return 0
  let n = 0
  for (const part of [tf.params, tf.rawArgs, tf.result, tf.additionalData]) {
    if (part == null) continue
    n += typeof part === 'string' ? part.length : JSON.stringify(part).length
  }
  return n
}

/**
 * @returns {{ input: number, output: number, source: 'cursor' | 'content-estimate' | 'none' }}
 * - cursor: bubble JSON has tokenCount with input or output > 0 (Cursor wrote it locally).
 * - content-estimate: no usable tokenCount; guessed from bubble body (~4 chars/token).
 * - none: bubble loaded but no tokenCount and nothing to estimate (counts as 0).
 */
export function tokensFromBubbleRaw(raw) {
  const tc = raw?.tokenCount || {}
  const rawInput = tc.inputTokens || 0
  const rawOutput = tc.outputTokens || 0
  if (rawInput > 0 || rawOutput > 0) {
    return { input: rawInput, output: rawOutput, source: 'cursor' }
  }

  const isUser = raw?.type === 1
  const textLen = (raw?.text || '').length
  const thinkingLen = (raw?.thinking?.text || '').length
  const codeLen = (raw?.codeBlocks || []).reduce((n, b) => n + (b.content?.length || 0), 0)
  const toolLen = toolFormerCharLen(raw)
  const contentLen = isUser ? textLen : textLen + thinkingLen + codeLen + toolLen

  if (contentLen <= 0) return { input: 0, output: 0, source: 'none' }
  if (isUser) return { input: estimateTokensFromChars(contentLen), output: 0, source: 'content-estimate' }
  return { input: 0, output: estimateTokensFromChars(contentLen), source: 'content-estimate' }
}

/**
 * The small, stable shape the rest of the server works with. Raw bubbles carry
 * far more (tool args, diffs, thinking text); none of it is needed for spend.
 */
export function normalizeBubble(raw, { index, composerId, defaultModel = null } = {}) {
  const reported = raw?.modelInfo?.modelName || null
  return {
    id: raw?.bubbleId ?? null,
    composerId,
    index,
    role: raw?.type === 1 ? 'user' : 'assistant',
    createdAt: raw?.createdAt || null,
    model: reported || defaultModel,
    modelSource: reported ? 'bubble' : defaultModel ? 'composer-default' : null,
    tokens: tokensFromBubbleRaw(raw),
  }
}

/** Sum normalized bubbles into the totals the UI shows. */
export function aggregateTokenTotals(messages) {
  const totals = {
    input: 0,
    output: 0,
    total: 0,
    measured: 0,
    estimated: 0,
    fromCursor: 0,
    fromContentEstimate: 0,
    emptyBubbles: 0,
  }
  for (const m of messages) addBubbleToTokenTotals(totals, m)
  return totals
}

export function addBubbleToTokenTotals(totals, msg) {
  totals.input += msg.tokens.input
  totals.output += msg.tokens.output
  const sum = msg.tokens.input + msg.tokens.output
  if (msg.tokens.source === 'cursor') {
    totals.measured += sum
    totals.fromCursor += sum
  } else if (msg.tokens.source === 'content-estimate') {
    totals.estimated += sum
    totals.fromContentEstimate += sum
  } else if (msg.tokens.source === 'none') {
    totals.emptyBubbles += 1
  }
  totals.total = totals.input + totals.output
}

/**
 * Pure pricing math — no file I/O. Pass a table shaped like pricing.json
 * ({ models: { [id]: { input, output } }, note?, currency? }).
 */

function normalizeModelKey(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function resolveModelPricing(modelName, table) {
  if (!modelName || !table?.models) return null
  const models = table.models
  if (models[modelName]) return models[modelName]

  const key = normalizeModelKey(modelName)
  for (const [name, entry] of Object.entries(models)) {
    if (key === normalizeModelKey(name)) return entry
  }
  return null
}

function isPriced(rate) {
  return !!(rate && (rate.input != null || rate.output != null))
}

export function estimateUsd(model, input, output, table) {
  const rate = resolveModelPricing(model, table)
  if (!isPriced(rate)) return { usd: 0, priced: false }
  const usd = ((input || 0) * (rate.input || 0) + (output || 0) * (rate.output || 0)) / 1_000_000
  return { usd, priced: true }
}

const round4 = (n) => Math.round(n * 10000) / 10000

/** @param {Map} byModelMap @param {object} table pricing.json shape (injected by host) */
export function applyPricingToByModel(byModelMap, table) {
  let costUsd = 0
  let inputCostUsd = 0
  let outputCostUsd = 0
  let unpricedTokens = 0

  const byModel = [...byModelMap.values()]
    .map((m) => {
      const rate = table ? resolveModelPricing(m.model, table) : null
      const priced = isPriced(rate)
      let inputUsd = 0
      let outputUsd = 0
      if (priced) {
        inputUsd = (m.inputTokens * (rate.input || 0)) / 1_000_000
        outputUsd = (m.outputTokens * (rate.output || 0)) / 1_000_000
        costUsd += inputUsd + outputUsd
        inputCostUsd += inputUsd
        outputCostUsd += outputUsd
      } else {
        unpricedTokens += m.inputTokens + m.outputTokens
      }
      return {
        ...m,
        tokenTotal: m.inputTokens + m.outputTokens,
        usd: round4(inputUsd + outputUsd),
        priced,
      }
    })
    .sort((a, b) => b.usd - a.usd || b.tokenTotal - a.tokenTotal)

  return {
    byModel,
    costUsd: round4(costUsd),
    inputCostUsd: round4(inputCostUsd),
    outputCostUsd: round4(outputCostUsd),
    unpricedTokens,
  }
}

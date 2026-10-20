/** Shown when scan APIs are called without pricingTable. */
export const PRICING_INJECT_HINT =
  'Pass pricingTable ({ models: { … } }). Optional helper: loadDefaultPricingTable() in this package.'

/** @param {unknown} pricingTable */
export function assertPricingTable(pricingTable) {
  if (!pricingTable || typeof pricingTable !== 'object') {
    throw new TypeError(`pricingTable is required. ${PRICING_INJECT_HINT}`)
  }
  if (!pricingTable.models || typeof pricingTable.models !== 'object') {
    throw new TypeError(`pricingTable.models is required. ${PRICING_INJECT_HINT}`)
  }
  return pricingTable
}

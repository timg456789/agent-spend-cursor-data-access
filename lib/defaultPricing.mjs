/**
 * Helpers for the bundled pricing.json (also exported as agent-spend-cursor-data-access/pricing.json).
 * Scan APIs do not call this — the host loads a table and passes pricingTable.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Absolute path to this package’s default pricing.json */
export const defaultPricingPath = path.join(__dirname, '..', 'pricing.json')

let cached = null

export function loadDefaultPricingTable() {
  if (cached) return cached
  cached = JSON.parse(fs.readFileSync(defaultPricingPath, 'utf8'))
  return cached
}

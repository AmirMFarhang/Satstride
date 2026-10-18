// Monte Carlo: probability a BTC-backed loan hits the liquidation LTV during the term,
// and the lender's expected shortfall if the liquidation executes with a lag.
// Model: GBM, zero drift, annualised vol sigma, hourly steps, term in days.
// Liquidation triggers when LTV >= 80% (price <= debt/(0.8*collateral)).
// Execution lag: the pre-signed liquidation is broadcast after `lagHours` of the breach
// (cure window + platform attestation + confirmation). Loss = max(0, debt - collateral*priceAtExecution).
// The lender receives exactly the debt at execution price (issue #6, no penalty): if the
// price keeps falling during the lag, the collateral may be worth less than the debt.

function run({ ltv, sigma, days, lagHours, paths = 20000, liqLtv = 0.8 }) {
  const debt = 1
  const collateral = 1 / ltv // in BTC, price0 = 1
  const liqPrice = debt / (liqLtv * collateral)
  const dt = 1 / (365 * 24)
  const steps = days * 24
  let hits = 0, lossSum = 0, lossCount = 0
  for (let p = 0; p < paths; p++) {
    let price = 1, hit = -1
    for (let s = 0; s < steps; s++) {
      // Box-Muller
      const u1 = Math.random() || 1e-12, u2 = Math.random()
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
      price *= Math.exp(-0.5 * sigma * sigma * dt + sigma * Math.sqrt(dt) * z)
      if (hit < 0 && price <= liqPrice) hit = s
      if (hit >= 0 && s === Math.min(steps - 1, hit + lagHours)) {
        const value = collateral * price
        const loss = Math.max(0, debt - value)
        lossSum += loss; if (loss > 0) lossCount++
        break
      }
    }
    if (hit >= 0) hits++
  }
  return { ltv, sigma, days, lagHours, pHit: hits / paths, pLoss: lossCount / paths, expectedLossBps: (lossSum / paths) * 10000 }
}

const rows = []
for (const sigma of [0.45, 0.65, 0.90]) for (const ltv of [0.50, 0.55, 0.60, 0.65]) for (const days of [30, 90]) rows.push(run({ ltv, sigma, days, lagHours: 12 }))
console.table(rows.map((r) => ({ ...r, pHit: (r.pHit * 100).toFixed(1) + '%', pLoss: (r.pLoss * 100).toFixed(2) + '%', expectedLossBps: r.expectedLossBps.toFixed(1) })))
// Lag sensitivity at the top of the ladder in a bad regime
const lag = []
for (const lagHours of [2, 12, 24, 72]) lag.push(run({ ltv: 0.65, sigma: 0.9, days: 90, lagHours }))
console.table(lag.map((r) => ({ ...r, pHit: (r.pHit * 100).toFixed(1) + '%', pLoss: (r.pLoss * 100).toFixed(2) + '%', expectedLossBps: r.expectedLossBps.toFixed(1) })))

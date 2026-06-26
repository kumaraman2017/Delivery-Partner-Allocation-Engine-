# B6 — Allocation Engine Design Spec
**Date:** 2026-06-26  
**Status:** Approved  
**Scope:** `allocationEngine.js` + supporting model/generator/route changes

---

## 1. What This Phase Does

Implements the deterministic weighted scoring function that picks the best rider for a given order. Also exposes a manual trigger endpoint (for testing before B8 simulation exists) and a config weights API.

---

## 2. Files Changed

| File | Change |
|---|---|
| `src/services/allocationEngine.js` | New — core allocation function |
| `src/routes/allocation.js` | New — `POST /allocate-order`, `GET /allocation-history` |
| `src/routes/configRoutes.js` | New — `GET /config/weights`, `PUT /config/weights` |
| `src/routes/index.js` | Mount new routes |

---

## 3. `allocationEngine.js`

### Interface

```js
export function allocateOrder(order, h3Buckets, riderState, weights)
// Returns: { winner, score, breakdown } | null
```

### Pipeline

```
1.  restaurantH3   = latLngToCell(order.restaurantLat, order.restaurantLng, H3_RESOLUTION)
                     // latLngToCell is pure bit manipulation — O(1), no schema field needed
2.  candidateCells = getCandidateCells(restaurantH3)  // cached gridDisk
3.  candidates     = union h3Buckets[cell] for each candidateCell
                     → map to rider objects from riderState
                     → filter: availabilityStatus === 'ONLINE'
                               AND nextOrderId === null
4.  if candidates.length === 0 → return null     // early exit
5.  if candidates.length === 1 → skip normalization, score directly, return
6.  For each candidate compute ETAR:
      IDLE:      etar = haversine(rider, restaurant) / RIDER_SPEED_KMH * 3600
      ACCEPTED:  progress = min(1, (now - activeOrder.legStartedAt) / leg1Duration_ms)
                 etar = (1-progress)*leg1Duration_s + leg2Duration_s
                        + haversine(rider, restaurant) / RIDER_SPEED_KMH * 3600
      PICKED_UP: progress = min(1, (now - activeOrder.legStartedAt) / leg2Duration_ms)
                 etar = (1-progress)*leg2Duration_s
                        + haversine(rider, restaurant) / RIDER_SPEED_KMH * 3600
7.  Compute recentLoad per candidate:
      load = rider.deliveryTimestamps.filter(t => t > now - LOAD_WINDOW_MS).length
8.  Find maxETAR, maxLoad across all candidates
9.  Normalize:
      ETARScore   = maxETAR === 0 ? 1.0 : 1 - (etar / maxETAR)
      RatingScore = rider.rating / 5
      LoadScore   = maxLoad  === 0 ? 1.0 : 1 - (load / maxLoad)
10. finalScore = w.etar*ETARScore + w.rating*RatingScore + w.load*LoadScore
11. Pick candidate with highest finalScore (first on tie)
12. Return { winner, score: finalScore, breakdown: { etarScore, ratingScore, loadScore, rawEtar_s, distanceToRestaurant_km } }
```

### Optimization 1 — gridDisk cache

```js
const diskCache = new Map()  // module-level, lives for server lifetime

function getCandidateCells(restaurantH3) {
  if (!diskCache.has(restaurantH3))
    diskCache.set(restaurantH3, new Set(h3.gridDisk(restaurantH3, H3_CANDIDATE_K)))
  return diskCache.get(restaurantH3)
}
```

Fills once per unique restaurant hex, never invalidates (restaurant positions are fixed). Eliminates repeated `gridDisk` computation across the lifetime of the server.

### Optimization 2 — Early exits

```js
// After filter:
if (candidates.length === 0) return null

// Single candidate — skip normalization entirely:
if (candidates.length === 1) {
  const r = candidates[0]
  const load = r.deliveryTimestamps.filter(t => t > now - LOAD_WINDOW_MS).length
  const score = weights.etar * 1.0
              + weights.rating * (r.rating / 5)
              + weights.load * 1.0
  return { winner: r, score, breakdown: { etarScore: 1, ratingScore: r.rating/5, loadScore: 1, rawEtar_s: etar } }
}
```

Sparse zone edges produce zero or single-candidate results frequently at city scale — skipping all normalization math here is meaningful.

---

## 4. Routes

### `POST /allocate-order` (admin only)

Manual trigger — used to test B6 in isolation before B8 simulation is wired.

**Body:** `{ orderId: string }`  
**Flow:**
1. Load order by ID — 404 if not found
2. Call `allocateOrder(order, h3Buckets, riderState, getWeights())`
3. If winner: write `AllocationHistory` record, return `{ winner, score, breakdown }`
4. If null: return `{ winner: null, reason: 'No eligible riders in zone' }`

**Note:** `h3Buckets` and `riderState` are passed in from `simulation.js` — the route module imports them via the simulation's exported getters.

### `GET /allocation-history`

Returns all `AllocationHistory` records sorted `createdAt DESC`. No pagination for MVP.

### `GET /config/weights`

Returns `getWeights()` — current live weights object.

### `PUT /config/weights`

**Body:** `{ etar: number, rating: number, load: number }`  
**Validation:** all three present, all numbers, all > 0  
**Action:** calls `setWeights({ etar, rating, load })` which normalizes to sum=1 before storing  
**Returns:** normalized weights

---

## 5. Edge Cases

| Case | Behaviour |
|---|---|
| No ONLINE riders with `nextOrderId === null` in k=2 ring | Return `null` — order stays in `pendingQueue`, retried next tick |
| Single candidate in zone | Skip normalization, score directly with ETARScore=1.0 and LoadScore=1.0 |
| All candidates have same ETAR (maxETAR=0) | ETARScore = 1.0 for all — ETAR contributes nothing, rating and load decide |
| All candidates have zero recent load (maxLoad=0) | LoadScore = 1.0 for all — no load differentiation |
| Tie on finalScore | First candidate in iteration order wins (deterministic) |
| Weights sum to zero (bad PUT /config/weights) | Reject with 400 before calling setWeights |
| ACCEPTED/PICKED_UP rider whose order has no legStartedAt | Treat progress as 0 — conservative (overestimates ETAR, rider less likely to win) |

---

## 6. `AllocationHistory` Record Written on Assignment

```js
{
  orderId,
  winnerId: winner._id,
  winnerName: winner.name,
  allocationScore: score,
  breakdown: { etarScore, ratingScore, loadScore, rawEtar_s, distanceToRestaurant_km },
  candidateCount: candidates.length,
  weights: getWeights(),
  reason: generateReason(winner, breakdown),  // deterministic template
}
```

`generateReason` template:
```
"${name} selected: ~${km}km away, ~${mins}min ETAR, rated ${rating}/5, ${load} recent deliveries."
```

---

## 7. What This Does NOT Do

- No AI explanation (Gemini) — template reason is sufficient for MVP
- No MongoDB query on the hot path — all data comes from `h3Buckets` and `riderState`
- No batching of `AllocationHistory` writes — one write per allocation, real-time

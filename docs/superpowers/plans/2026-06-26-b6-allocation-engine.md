# B6 — Allocation Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the deterministic weighted rider scoring function, a simulation state stub, and admin routes for manual testing and weight configuration.

**Architecture:** `allocateOrder` is a pure function — it reads only from in-memory Maps (`h3Buckets`, `riderState`), never touches MongoDB on the hot path. A thin `simulation.js` stub provides those Maps during B6; B8 populates them for real. Routes wrap the function for manual trigger testing and live weight configuration.

**Tech Stack:** Node.js ESM, h3-js ^4.4.0, Mongoose, Express, Vitest

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/services/allocationEngine.js` | Create | Pure scoring function + reason template |
| `src/services/simulation.js` | Create (stub) | Exports empty Maps; B8 replaces with full impl |
| `src/routes/allocation.js` | Create | `POST /allocate-order`, `GET /allocation-history` |
| `src/routes/configRoutes.js` | Create | `GET /config/weights`, `PUT /config/weights` |
| `src/routes/index.js` | Modify | Mount two new route files |
| `src/tests/allocationEngine.test.js` | Create | Unit tests for pure allocation logic |
| `package.json` | Modify | Add vitest + `test` script |

> **`restaurantH3` is NOT stored on the Order.** `latLngToCell` is pure bit manipulation — essentially free. The allocation engine calls it inline; the diskCache then handles the expensive `gridDisk` computation. No schema change needed.

---

## Task 1: Install Vitest

**Files:**
- Modify: `backend/package.json`

- [ ] **Step 1: Install vitest**

Run from `backend/`:
```bash
npm install --save-dev vitest
```

- [ ] **Step 2: Add test script to package.json**

Open `backend/package.json`. The `scripts` block currently has `start`, `dev`, `seed`. Add `test`:

```json
"scripts": {
  "start": "node src/server.js",
  "dev": "nodemon src/server.js",
  "seed": "node seed.js",
  "test": "vitest run",
  "test:watch": "vitest"
},
```

No `vitest.config.js` needed — vitest detects ESM from `"type": "module"` in package.json automatically.

- [ ] **Step 3: Verify vitest runs**

```bash
npm test
```

Expected output:
```
No test files found, exiting with code 1
```
That exit code is expected — no tests exist yet. Vitest itself loaded correctly.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add vitest for backend unit testing"
```

---

## Task 2: Create simulation.js stub

**Files:**
- Create: `src/services/simulation.js`

This stub gives B6 routes a valid import target. B8 replaces it with the full implementation while keeping the same exported interface.

- [ ] **Step 1: Create the stub**

Create `src/services/simulation.js`:

```js
// Stub — in-memory Maps populated by B8 (simulation tick engine).
// Routes and allocationEngine import from here; B8 replaces this file
// with the full implementation while keeping the same export names.
const h3Buckets = new Map()  // h3Cell (string) → Set<riderId (string)>
const riderState = new Map() // riderId (string) → rider object

export const getH3Buckets = () => h3Buckets
export const getRiderState = () => riderState
```

- [ ] **Step 2: Verify it imports cleanly**

```bash
node --input-type=module <<'EOF'
import { getH3Buckets, getRiderState } from './src/services/simulation.js'
console.log(getH3Buckets().size, getRiderState().size)
EOF
```

Expected: `0 0`

- [ ] **Step 3: Commit**

```bash
git add src/services/simulation.js
git commit -m "feat: add simulation state stub (populated in B8)"
```

---

## Task 3: Implement `allocationEngine.js`

**Files:**
- Create: `src/services/allocationEngine.js`
- Create: `src/tests/allocationEngine.test.js`

- [ ] **Step 1: Write the failing tests first**

Create `src/tests/allocationEngine.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { latLngToCell } from 'h3-js'
import { allocateOrder, generateReason } from '../services/allocationEngine.js'

// Fixed Ranchi restaurant coords
const R_LAT = 23.35
const R_LNG = 85.33
const restaurantH3 = latLngToCell(R_LAT, R_LNG, 7)

const weights = { etar: 0.50, rating: 0.30, load: 0.20 }

// Rider factory — coords must be within ~4km of restaurant to land in k=2 ring
function makeRider(id, overrides = {}) {
  return {
    _id: id,
    name: `Rider ${id}`,
    latitude: 23.358,   // ~0.9km north of restaurant — inside k=2 ring
    longitude: 85.33,
    h3Index: latLngToCell(23.358, 85.33, 7),
    status: 'IDLE',
    availabilityStatus: 'ONLINE',
    nextOrderId: null,
    rating: 4.0,
    deliveryTimestamps: [],
    currentOrderId: null,
    activeOrderData: null,
    ...overrides,
  }
}

function makeOrder(overrides = {}) {
  return {
    _id: 'order1',
    restaurantH3,
    restaurantLat: R_LAT,
    restaurantLng: R_LNG,
    ...overrides,
  }
}

// Build h3Buckets and riderState Maps from an array of rider objects
function buildMaps(riders) {
  const riderState = new Map()
  const h3Buckets = new Map()
  for (const r of riders) {
    riderState.set(r._id, r)
    if (!h3Buckets.has(r.h3Index)) h3Buckets.set(r.h3Index, new Set())
    h3Buckets.get(r.h3Index).add(r._id)
  }
  return { riderState, h3Buckets }
}

// ─── No candidates ────────────────────────────────────────────────────────────

describe('allocateOrder — no candidates', () => {
  it('returns null when h3Buckets is empty', () => {
    const { riderState, h3Buckets } = buildMaps([])
    expect(allocateOrder(makeOrder(), h3Buckets, riderState, weights)).toBeNull()
  })

  it('returns null when all riders in zone are OFFLINE', () => {
    const rider = makeRider('r1', { availabilityStatus: 'OFFLINE' })
    const { riderState, h3Buckets } = buildMaps([rider])
    expect(allocateOrder(makeOrder(), h3Buckets, riderState, weights)).toBeNull()
  })

  it('returns null when all riders in zone have nextOrderId set', () => {
    const rider = makeRider('r1', { nextOrderId: 'some-order-id' })
    const { riderState, h3Buckets } = buildMaps([rider])
    expect(allocateOrder(makeOrder(), h3Buckets, riderState, weights)).toBeNull()
  })
})

// ─── Single candidate ─────────────────────────────────────────────────────────

describe('allocateOrder — single candidate', () => {
  it('returns that rider with ETARScore=1 and LoadScore=1', () => {
    const rider = makeRider('r1', { rating: 4.5 })
    const { riderState, h3Buckets } = buildMaps([rider])
    const result = allocateOrder(makeOrder(), h3Buckets, riderState, weights)

    expect(result).not.toBeNull()
    expect(result.winner._id).toBe('r1')
    expect(result.breakdown.etarScore).toBe(1)
    expect(result.breakdown.loadScore).toBe(1)
    expect(result.breakdown.ratingScore).toBeCloseTo(4.5 / 5, 5)
    // score = 0.5*1 + 0.3*(4.5/5) + 0.2*1
    expect(result.score).toBeCloseTo(0.5 + 0.3 * (4.5 / 5) + 0.2, 5)
  })
})

// ─── Multiple candidates ──────────────────────────────────────────────────────

describe('allocateOrder — multiple candidates', () => {
  it('closer idle rider beats farther idle rider on ETAR', () => {
    const farRider  = makeRider('far',  { latitude: 23.368, h3Index: latLngToCell(23.368, 85.33, 7), rating: 4.8 })
    const nearRider = makeRider('near', { latitude: 23.352, h3Index: latLngToCell(23.352, 85.33, 7), rating: 4.0 })
    const { riderState, h3Buckets } = buildMaps([farRider, nearRider])
    const result = allocateOrder(makeOrder(), h3Buckets, riderState, weights)
    // near rider has lower ETAR → higher ETARScore → wins despite lower rating
    expect(result.winner._id).toBe('near')
  })

  it('rider with nextOrderId is excluded from candidates', () => {
    const taken = makeRider('taken', { nextOrderId: 'existing-order' })
    const free  = makeRider('free',  { latitude: 23.368, h3Index: latLngToCell(23.368, 85.33, 7) })
    const { riderState, h3Buckets } = buildMaps([taken, free])
    const result = allocateOrder(makeOrder(), h3Buckets, riderState, weights)
    expect(result.winner._id).toBe('free')
  })

  it('ACCEPTED rider with low ETAR beats idle rider far away', () => {
    // Accepted rider: 0.2km from restaurant, 90% done with leg1 (5s remaining)
    const legStartedAt = new Date(Date.now() - 0.9 * 60_000) // 90% of 60s leg1
    const accepted = makeRider('acc', {
      latitude: 23.352,
      longitude: 85.33,
      h3Index: latLngToCell(23.352, 85.33, 7),
      status: 'ACCEPTED',
      rating: 4.2,
      activeOrderData: {
        leg1Duration_s: 60,
        leg2Duration_s: 120,
        legStartedAt,
      },
    })
    // Idle rider 2.5km away — ETAR = (2.5/40)*3600 = 225s
    const farIdle = makeRider('idle', {
      latitude: 23.372,
      h3Index: latLngToCell(23.372, 85.33, 7),
      rating: 4.8,
    })
    const { riderState, h3Buckets } = buildMaps([accepted, farIdle])
    const result = allocateOrder(makeOrder(), h3Buckets, riderState, weights)
    expect(result.winner._id).toBe('acc')
  })

  it('when maxETAR is 0, all ETARScores are 1.0', () => {
    // Two riders at exactly restaurant coords → ETAR = 0 for both
    const r1 = makeRider('r1', { latitude: R_LAT, longitude: R_LNG, h3Index: latLngToCell(R_LAT, R_LNG, 7), rating: 5.0 })
    const r2 = makeRider('r2', { latitude: R_LAT, longitude: R_LNG, h3Index: latLngToCell(R_LAT, R_LNG, 7), rating: 3.0 })
    const { riderState, h3Buckets } = buildMaps([r1, r2])
    const result = allocateOrder(makeOrder(), h3Buckets, riderState, weights)
    // With maxETAR=0, ETARScore=1 for both. Higher rating wins.
    expect(result.winner._id).toBe('r1')
  })

  it('when maxLoad is 0, all LoadScores are 1.0', () => {
    const r1 = makeRider('r1', { rating: 5.0, deliveryTimestamps: [] })
    const r2 = makeRider('r2', {
      rating: 3.0,
      latitude: 23.352,
      h3Index: latLngToCell(23.352, 85.33, 7),
      deliveryTimestamps: [],
    })
    const { riderState, h3Buckets } = buildMaps([r1, r2])
    const result = allocateOrder(makeOrder(), h3Buckets, riderState, weights)
    // Both have loadScore=1. r2 is closer so wins on ETAR.
    expect(result.winner._id).toBe('r2')
  })

  it('breakdown contains all required fields', () => {
    const r1 = makeRider('r1')
    const r2 = makeRider('r2', { latitude: 23.352, h3Index: latLngToCell(23.352, 85.33, 7) })
    const { riderState, h3Buckets } = buildMaps([r1, r2])
    const result = allocateOrder(makeOrder(), h3Buckets, riderState, weights)
    expect(result.breakdown).toMatchObject({
      etarScore: expect.any(Number),
      ratingScore: expect.any(Number),
      loadScore: expect.any(Number),
      rawEtar_s: expect.any(Number),
      distanceToRestaurant_km: expect.any(Number),
    })
  })
})

// ─── generateReason ──────────────────────────────────────────────────────────

describe('generateReason', () => {
  it('returns a non-empty string with rider name', () => {
    const rider = makeRider('r1', { name: 'Rahul Kumar' })
    const breakdown = { rawEtar_s: 180, distanceToRestaurant_km: 2.0 }
    const reason = generateReason(rider, breakdown)
    expect(typeof reason).toBe('string')
    expect(reason).toContain('Rahul Kumar')
    expect(reason.length).toBeGreaterThan(10)
  })
})
```

- [ ] **Step 2: Run tests — confirm they all fail**

```bash
npm test
```

Expected: multiple failures with `Cannot find module '../services/allocationEngine.js'`. This confirms the tests are wired correctly.

- [ ] **Step 3: Create `src/services/allocationEngine.js`**

```js
import { latLngToCell, gridDisk } from 'h3-js'
import { haversine } from '../utils/haversine.js'
import {
  H3_RESOLUTION,
  H3_CANDIDATE_K,
  RIDER_SPEED_KMH,
  LOAD_WINDOW_MINUTES,
} from '../config/constants.js'

const LOAD_WINDOW_MS = LOAD_WINDOW_MINUTES * 60_000

// ─── gridDisk cache ───────────────────────────────────────────────────────────
// Restaurant positions are fixed. Cache the 19-cell k=2 ring per hex so
// repeated orders from the same restaurant skip the gridDisk computation.
const diskCache = new Map()

function getCandidateCells(restaurantH3) {
  if (!diskCache.has(restaurantH3))
    diskCache.set(restaurantH3, new Set(gridDisk(restaurantH3, H3_CANDIDATE_K)))
  return diskCache.get(restaurantH3)
}

// ─── ETAR ─────────────────────────────────────────────────────────────────────
// Estimated Time to Arrive at Restaurant in seconds.
// For ACCEPTED/PICKED_UP riders, reads activeOrderData embedded on the rider
// object in riderState (set by simulation.js at assignment time).
function computeEtar(rider, restaurantLat, restaurantLng) {
  const distKm = haversine(
    { lat: rider.latitude, lng: rider.longitude },
    { lat: restaurantLat, lng: restaurantLng },
  )
  const travelTime_s = (distKm / RIDER_SPEED_KMH) * 3600

  if (rider.status === 'IDLE') return travelTime_s

  const od = rider.activeOrderData
  if (!od?.legStartedAt) return travelTime_s // defensive: treat as IDLE if no data

  if (rider.status === 'ACCEPTED') {
    const progress = Math.min(
      1,
      (Date.now() - new Date(od.legStartedAt)) / (od.leg1Duration_s * 1000),
    )
    return (1 - progress) * od.leg1Duration_s + od.leg2Duration_s + travelTime_s
  }

  if (rider.status === 'PICKED_UP') {
    const progress = Math.min(
      1,
      (Date.now() - new Date(od.legStartedAt)) / (od.leg2Duration_s * 1000),
    )
    return (1 - progress) * od.leg2Duration_s + travelTime_s
  }

  return travelTime_s
}

// ─── Main allocation function ─────────────────────────────────────────────────
export function allocateOrder(order, h3Buckets, riderState, weights) {
  const restaurantH3 = latLngToCell(order.restaurantLat, order.restaurantLng, H3_RESOLUTION)
  const candidateCells = getCandidateCells(restaurantH3)  // diskCache handles gridDisk

  // Gather unique rider IDs from all 19 cells
  const candidateIds = new Set()
  for (const cell of candidateCells) {
    const bucket = h3Buckets.get(cell)
    if (bucket) for (const id of bucket) candidateIds.add(id)
  }

  // Filter: ONLINE and not already pre-assigned
  const candidates = []
  for (const id of candidateIds) {
    const rider = riderState.get(id)
    if (rider?.availabilityStatus === 'ONLINE' && rider.nextOrderId == null)
      candidates.push(rider)
  }

  // ── Early exit: no candidates ────────────────────────────────────────────
  if (candidates.length === 0) return null

  const { restaurantLat, restaurantLng } = order

  // ── Early exit: single candidate — skip normalization ────────────────────
  if (candidates.length === 1) {
    const r = candidates[0]
    const etar = computeEtar(r, restaurantLat, restaurantLng)
    const distKm = haversine(
      { lat: r.latitude, lng: r.longitude },
      { lat: restaurantLat, lng: restaurantLng },
    )
    const ratingScore = r.rating / 5
    const score = weights.etar * 1.0 + weights.rating * ratingScore + weights.load * 1.0
    return {
      winner: r,
      score,
      breakdown: {
        etarScore: 1,
        ratingScore,
        loadScore: 1,
        rawEtar_s: etar,
        distanceToRestaurant_km: distKm,
      },
    }
  }

  // ── Full scoring path ─────────────────────────────────────────────────────
  const now = Date.now()

  const raw = candidates.map((r) => {
    const etar = computeEtar(r, restaurantLat, restaurantLng)
    const distKm = haversine(
      { lat: r.latitude, lng: r.longitude },
      { lat: restaurantLat, lng: restaurantLng },
    )
    const load = r.deliveryTimestamps.filter((t) => t > now - LOAD_WINDOW_MS).length
    return { rider: r, etar, distKm, load }
  })

  const maxETAR = Math.max(...raw.map((s) => s.etar))
  const maxLoad = Math.max(...raw.map((s) => s.load))

  let result = null
  let topScore = -Infinity

  for (const s of raw) {
    const etarScore   = maxETAR === 0 ? 1 : 1 - s.etar / maxETAR
    const ratingScore = s.rider.rating / 5
    const loadScore   = maxLoad  === 0 ? 1 : 1 - s.load / maxLoad
    const finalScore  =
      weights.etar * etarScore +
      weights.rating * ratingScore +
      weights.load * loadScore

    if (finalScore > topScore) {
      topScore = finalScore
      result = {
        winner: s.rider,
        score: finalScore,
        breakdown: {
          etarScore,
          ratingScore,
          loadScore,
          rawEtar_s: s.etar,
          distanceToRestaurant_km: s.distKm,
        },
      }
    }
  }

  return result
}

// ─── Reason template ──────────────────────────────────────────────────────────
export function generateReason(winner, breakdown) {
  const km   = breakdown.distanceToRestaurant_km.toFixed(1)
  const mins = Math.max(1, Math.ceil(breakdown.rawEtar_s / 60))
  const rating = winner.rating.toFixed(1)
  const load = (winner.deliveryTimestamps ?? [])
    .filter((t) => t > Date.now() - LOAD_WINDOW_MS).length
  const unit = load === 1 ? 'delivery' : 'deliveries'
  return `${winner.name} selected: ~${km}km away, ~${mins}min ETAR, rated ${rating}/5, ${load} recent ${unit}.`
}
```

- [ ] **Step 4: Run tests — all must pass**

```bash
npm test
```

Expected output:
```
✓ src/tests/allocationEngine.test.js (10 tests)
Test Files  1 passed (1)
Tests       10 passed (10)
```

Fix any failures before continuing.

- [ ] **Step 5: Commit**

```bash
git add src/services/allocationEngine.js src/tests/allocationEngine.test.js
git commit -m "feat: implement allocation engine with gridDisk cache and early-exit optimizations"
```

---

## Task 4: Create allocation routes

**Files:**
- Create: `src/routes/allocation.js`

`AllocationHistory` schema has: `orderId`, `riderId`, `allocationScore`, `breakdown` (Mixed), `candidatesConsidered`. Extra fields (`winnerName`, `weights`, `reason`) are stored inside `breakdown`.

- [ ] **Step 1: Create `src/routes/allocation.js`**

```js
import express from 'express'
import Order from '../models/Order.js'
import AllocationHistory from '../models/AllocationHistory.js'
import { allocateOrder, generateReason } from '../services/allocationEngine.js'
import { getH3Buckets, getRiderState } from '../services/simulation.js'
import { getWeights } from '../config/constants.js'

const router = express.Router()

// POST /allocate-order
// Manual trigger for testing B6 before simulation (B8) is wired.
// In production, simulation.js calls allocateOrder directly — this route
// exists purely for isolated testing and ops tooling.
router.post('/', async (req, res, next) => {
  try {
    const { orderId } = req.body
    if (!orderId) {
      res.status(400)
      throw new Error('orderId is required')
    }

    const order = await Order.findById(orderId)
    if (!order) {
      res.status(404)
      throw new Error('Order not found')
    }

    const result = allocateOrder(order, getH3Buckets(), getRiderState(), getWeights())

    if (!result) {
      return res.json({ success: true, winner: null, reason: 'No eligible riders in zone' })
    }

    const { winner, score, breakdown } = result
    const reason = generateReason(winner, breakdown)

    await AllocationHistory.create({
      orderId: order._id,
      riderId: winner._id,
      allocationScore: score,
      candidatesConsidered: getH3Buckets().size, // approximate — sim not running
      breakdown: { ...breakdown, winnerName: winner.name, weights: getWeights(), reason },
    })

    res.json({ success: true, winner: { _id: winner._id, name: winner.name }, score, breakdown, reason })
  } catch (err) {
    next(err)
  }
})

// GET /allocation-history
router.get('/history', async (req, res, next) => {
  try {
    const history = await AllocationHistory.find()
      .sort({ createdAt: -1 })
      .lean()
    res.json({ success: true, data: history })
  } catch (err) {
    next(err)
  }
})

export default router
```

- [ ] **Step 2: Commit**

```bash
git add src/routes/allocation.js
git commit -m "feat: add POST /allocate-order and GET /allocation-history routes"
```

---

## Task 5: Create config weights routes, mount all routes

**Files:**
- Create: `src/routes/configRoutes.js`
- Modify: `src/routes/index.js`

- [ ] **Step 1: Create `src/routes/configRoutes.js`**

```js
import express from 'express'
import { getWeights, setWeights } from '../config/constants.js'

const router = express.Router()

// GET /config/weights
router.get('/weights', (req, res) => {
  res.json({ success: true, data: getWeights() })
})

// PUT /config/weights
router.put('/weights', (req, res, next) => {
  try {
    const { etar, rating, load } = req.body

    if (etar == null || rating == null || load == null) {
      res.status(400)
      throw new Error('etar, rating, and load are all required')
    }
    if (typeof etar !== 'number' || typeof rating !== 'number' || typeof load !== 'number') {
      res.status(400)
      throw new Error('etar, rating, and load must be numbers')
    }
    if (etar <= 0 || rating <= 0 || load <= 0) {
      res.status(400)
      throw new Error('etar, rating, and load must be greater than 0')
    }
    if (etar + rating + load === 0) {
      res.status(400)
      throw new Error('weights must not all be zero')
    }

    setWeights({ etar, rating, load })
    res.json({ success: true, data: getWeights() })
  } catch (err) {
    next(err)
  }
})

export default router
```

- [ ] **Step 2: Mount both new routes in `src/routes/index.js`**

Replace the entire file with:

```js
import express from 'express';
import riderRoutes      from './riders.js';
import restaurantRoutes from './restaurants.js';
import customerRoutes   from './customers.js';
import orderRoutes      from './orders.js';
import allocationRoutes from './allocation.js';
import configRoutes     from './configRoutes.js';

const router = express.Router();

router.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

router.use('/riders',           riderRoutes);
router.use('/restaurants',      restaurantRoutes);
router.use('/customers',        customerRoutes);
router.use('/orders',           orderRoutes);
router.use('/allocate-order',   allocationRoutes);
router.use('/config',           configRoutes);

export default router;
```

- [ ] **Step 3: Run the server and smoke test all routes**

Start the server:
```bash
npm run dev
```

Test health (confirms server still starts):
```bash
curl http://localhost:5000/api/health
```
Expected: `{"status":"ok"}`

Test GET weights:
```bash
curl http://localhost:5000/api/config/weights
```
Expected: `{"success":true,"data":{"etar":0.5,"rating":0.3,"load":0.2}}`

Test PUT weights:
```bash
curl -X PUT http://localhost:5000/api/config/weights \
  -H "Content-Type: application/json" \
  -d '{"etar":0.6,"rating":0.3,"load":0.1}'
```
Expected: `{"success":true,"data":{"etar":0.6,"rating":0.3,"load":0.1}}`

Test PUT weights validation (zero value):
```bash
curl -X PUT http://localhost:5000/api/config/weights \
  -H "Content-Type: application/json" \
  -d '{"etar":0,"rating":0.3,"load":0.1}'
```
Expected: 400 with error message.

Test POST /allocate-order with no simulation running (empty Maps):
```bash
curl -X POST http://localhost:5000/api/allocate-order \
  -H "Content-Type: application/json" \
  -d '{"orderId":"<any-valid-order-id-from-db>"}'
```
Expected: `{"success":true,"winner":null,"reason":"No eligible riders in zone"}`
(Because simulation Maps are empty until B8 runs.)

Test GET /allocation-history:
```bash
curl http://localhost:5000/api/allocation-history/history
```
Expected: `{"success":true,"data":[]}`

- [ ] **Step 4: Run the full test suite to confirm nothing regressed**

```bash
npm test
```

Expected: `10 passed (10)`

- [ ] **Step 5: Commit**

```bash
git add src/routes/configRoutes.js src/routes/index.js
git commit -m "feat: add config weights routes and mount all B6 routes"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| `getCandidateCells` with diskCache | Task 4 |
| `nextOrderId == null` filter | Task 4 |
| Zero-candidate early exit | Task 4 |
| Single-candidate short-circuit | Task 4 |
| ETAR for IDLE / ACCEPTED / PICKED_UP | Task 4 |
| Normalize ETARScore, RatingScore, LoadScore | Task 4 |
| maxETAR=0 → ETARScore=1 edge case | Task 4 (test + impl) |
| maxLoad=0 → LoadScore=1 edge case | Task 4 (test + impl) |
| `generateReason` template | Task 4 |
| `restaurantH3` computed inline via `latLngToCell` (no schema change) | Task 3 |
| `POST /allocate-order` | Task 4 |
| `GET /allocation-history` | Task 4 |
| `GET /config/weights` | Task 5 |
| `PUT /config/weights` with validation | Task 5 |
| `AllocationHistory` record on allocation | Task 4 |
| `breakdown.distanceToRestaurant_km` | Task 3 |

All spec requirements covered. No gaps.

**Placeholder scan:** No TBDs, TODOs, or vague steps. All code blocks are complete.

**Type consistency:** `haversine(a, b)` called with `{ lat, lng }` objects throughout — matches `src/utils/haversine.js` signature. `getWeights()` / `setWeights()` match `src/config/constants.js`. `AllocationHistory.create()` fields match the existing schema.

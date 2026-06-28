# Simulation Bug Audit — Map & Engine Edge Cases

Code audit conducted June 2026. These are bugs identified by reading the simulation engine
and frontend context — not yet fixed. Ordered by severity.

---

## SIM-BUG-1 — Rider dot teleports to route start when road-snapped route arrives

**Severity:** High  
**Visible:** Yes — happens on every single order  
**File:** `backend/src/services/simulationEngine.js` (tick allocation block, ~line 468)

### What happens
Every order goes through a two-phase movement system:
1. **Lerp fallback** — straight-line interpolation starts immediately while the route is being fetched
2. **Polyline mode** — road-snapped coordinates take over once `getRoute()` resolves

When the route arrives and the callback fires, it resets both `currentSegmentIdx = 0` and
`distanceCoveredOnSegment = 0` unconditionally:

```js
r.legCoords              = route.leg1Coords;
r.leg2Coords             = route.leg2Coords;
r.currentSegmentIdx      = 0;   // ← always reset to start
r.distanceCoveredOnSegment = 0;
```

Since the rider has been moving via lerp for 1–3 seconds already, setting the index to 0 places
them at the first coordinate of the polyline — which is the rider's position at assignment time,
not their current position. The dot jumps backwards on the map.

### Root cause
No pre-advancement step when the route first lands. The hydration code does this correctly
(`_preAdvancePolyline(entry, elapsed_s * speed)`) but the live assignment path does not.

### Fix direction
When the route arrives, calculate `elapsed_s = (Date.now() - winner.legStartedAt) / 1000` and
call `_preAdvancePolyline(r, elapsed_s * RIDER_SPEED_KMH / 3.6)` before setting lat/lng.

---

## SIM-BUG-2 — Route data overwrites active leg2 if getRoute resolves after PICKED_UP transition

**Severity:** High  
**Visible:** Yes — rider navigates leg1 route while in PICKED_UP state  
**File:** `backend/src/services/simulationEngine.js` (~line 468)

### What happens
The `getRoute()` callback guard only checks that the rider is still on the same order:

```js
if (r && r.currentOrderId?.toString() === orderId) {
  r.legCoords  = route.leg1Coords;   // ← always writes LEG1
  r.leg2Coords = route.leg2Coords;
  ...
}
```

If the route fetch is slow (high latency, route service busy) AND leg1 is short (rider close to
restaurant), the rider can complete leg1 via lerp and transition to `PICKED_UP` before the
promise resolves. When it finally does, `currentOrderId` still matches, so the guard passes —
and `r.legCoords` is set to `leg1Coords` while the rider is already in PICKED_UP state
navigating leg2. The rider's active polyline is now the restaurant-pickup route instead of
the customer-delivery route.

### Trigger conditions
- Route service latency > time for rider to complete leg1 via lerp
- Short leg1 distance (rider already near restaurant) — e.g. rider 200m from restaurant at
  30 km/h = ~24 seconds. If route fetch takes longer than that, bug fires.

### Fix direction
Add a status check in the callback: only apply leg1/leg2 coords if `r.status === 'ACCEPTED'`.
If `r.status === 'PICKED_UP'`, only apply `leg2Coords` to `r.legCoords` (the active leg).

---

## SIM-BUG-3 — activeRoutes not restored on server restart — route lines missing on OrdersMap

**Severity:** Medium  
**Visible:** Yes — route polylines disappear from the overview map after any server restart  
**File:** `backend/src/services/simulationEngine.js` (`hydrate()` function)

### What happens
`hydrate()` clears `activeRoutes` but never repopulates it for riders already in ACCEPTED or
PICKED_UP state:

```js
activeRoutes.clear();   // wiped
// ... riders are reconstructed with correct positions ...
// ... but activeRoutes is never re-filled from DB leg coords
```

The `initSimulation` connection handler replays `activeRoutes` to every new client:

```js
for (const [orderId, route] of activeRoutes) {
  socket.emit('order:route', { orderId, ...route });
}
```

After restart this emits nothing. `SimulationContext.routes` on the frontend stays an empty Map.
The OrdersMap overview page (which renders route polylines from `routes`) shows no route lines
for any in-flight order until a brand-new order is assigned and a fresh `order:route` event fires.

Single-order OrderMap page is NOT affected because it reads `leg1Coords`/`leg2Coords` directly
from the REST API response.

### Fix direction
In `hydrate()`, after reconstructing rider state, populate `activeRoutes` for every ACCEPTED and
PICKED_UP rider:

```js
if (rider.status === 'ACCEPTED' && ord.leg1Coords?.length) {
  activeRoutes.set(ord._id.toString(), {
    riderId: id,
    leg1Coords: ord.leg1Coords,
    leg2Coords: ord.leg2Coords ?? [],
  });
}
if (rider.status === 'PICKED_UP' && ord.leg2Coords?.length) {
  activeRoutes.set(ord._id.toString(), {
    riderId: id,
    leg1Coords: [],
    leg2Coords: ord.leg2Coords,
  });
}
```

---

## SIM-BUG-4 — Cancelled orders never cleaned from frontend routes Map

**Severity:** Low  
**Visible:** No — silent memory accumulation  
**File:** `frontend/src/context/SimulationContext.jsx`

### What happens
Routes are added to the `routes` Map on `order:route` and removed on `order:delivered`:

```js
socket.on('order:delivered', ({ orderId }) => {
  setRoutes((prev) => { const next = new Map(prev); next.delete(orderId); return next; });
});
```

There is no `order:cancelled` WebSocket event and no cleanup handler for cancellation. When
an order is cancelled (by `_healOrphanedOrders`, or any future cancel path), its entry stays
in the `routes` Map indefinitely. Over a long session with many cancellations, this accumulates.

### Fix direction
Emit `order:cancelled` from the backend whenever an order is cancelled. Add a listener in
`SimulationContext` that removes the orderId from `routes`, same as `order:delivered`.

---

## SIM-BUG-5 — order:status WebSocket event emitted but never consumed

**Severity:** Low  
**Visible:** Indirectly — OrderMap page status badge doesn't auto-update  
**File:** `backend/src/services/simulationEngine.js` line ~530 / `frontend/src/context/SimulationContext.jsx`

### What happens
The backend emits `order:status` when a rider picks up food:

```js
ioRef.emit('order:status', { orderId: orderId.toString(), status: 'PICKED_UP', riderId });
```

`SimulationContext` has no listener for this event. The single-order `OrderMap` page fetches
order data once on mount from the REST API. If a user is watching an order in real time, the
status badge stays on `ASSIGNED` even after the rider picks up the food — until they manually
refresh.

### Fix direction
Add a listener in `SimulationContext`:

```js
socket.on('order:status', ({ orderId, status }) => {
  // signal to any mounted OrderMap to re-fetch or update status inline
});
```

Because `OrderMap` owns its own `order` state from a REST fetch, the cleanest approach is to
broadcast the event and have `OrderMap` call `fetchOrder()` again when its current order's ID
matches.

---

## SIM-BUG-6 — Two riders permanently idle (data issue from reseed)

**Severity:** Medium  
**Visible:** Yes — 2 of 9 riders always show IDLE, never move  
**File:** `backend/reseed.js`

### What happens
The June 2026 reseed placed two riders at coordinates outside Jharkhand:
- Rishi → Lucknow (`26.8467, 80.9462`) — ~500 km from Ranchi
- Manav → Allahabad/Prayagraj (`25.4358, 81.8463`) — ~450 km from Ranchi

The H3 allocation engine (`getCandidateCells`) searches hexagon rings around the restaurant's
location. These two riders are in H3 cells that are hundreds of rings away from any Ranchi
restaurant. They will never appear in any candidate set and will never be allocated an order.

Additionally, both riders are invisible on the Ranchi-centered map (zoom 13) — they are
geographically off-screen.

### Fix direction
Replace Lucknow and Allahabad coordinates with Ranchi-area locations and re-run `node reseed.js`.
Suggested replacements: Namkum (~`23.3290, 85.3830`) and Booty More (~`23.4020, 85.3540`).

---

## Summary

| ID | Bug | Severity | Visible | File |
|----|-----|----------|---------|------|
| SIM-BUG-1 | Rider dot jumps to route start when polyline arrives | High | Yes | simulationEngine.js |
| SIM-BUG-2 | Route overwrite corrupts leg2 if getRoute is slow | High | Yes | simulationEngine.js |
| SIM-BUG-3 | activeRoutes empty after restart — no route lines on OrdersMap | Medium | Yes | simulationEngine.js |
| SIM-BUG-4 | Cancelled orders never removed from frontend routes Map | Low | No | SimulationContext.jsx |
| SIM-BUG-5 | order:status event unhandled — OrderMap status badge stale | Low | Indirectly | Both |
| SIM-BUG-6 | Two riders in wrong city — permanently idle, off-screen | Medium | Yes | reseed.js |

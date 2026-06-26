# Simulation Phase 2 — Road-Snapped Movement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Phase 2 of the simulation engine — road-snapped polyline movement via Mapbox Directions API, with live route lines rendered on the frontend fleet map and a fully functional per-order map page.

**Architecture:** The backend already has `routingService.js` (getRoute via Mapbox), polyline traversal in `simulationEngine.js`, and the Order schema fields. What remains is: (1) emit `order:route` socket event when route resolves so the frontend can render route lines, (2) wire `getRoute()` into the manual REST allocation endpoint, (3) build frontend route line rendering in RiderMap and a complete OrderMap page.

**Tech Stack:** Node.js/Express backend, Socket.IO, Mapbox Directions API, React + react-map-gl (Mapbox GL JS), CSS Modules.

---

## What Is Already Done (Do NOT re-implement)

- `backend/src/services/routingService.js` — `getRoute(riderCoords, restaurantCoords, customerCoords)` exists and is correct.
- `backend/src/services/simulationEngine.js` — polyline traversal (`_advanceAlongPolyline`, `_preAdvancePolyline`, `_positionFromPolyline`) is implemented and the tick loop already calls `getRoute()` fire-and-forget for pending-queue allocations.
- `backend/src/models/Order.js` — `leg1Coords`, `leg2Coords`, `leg1Duration_s`, `leg2Duration_s` fields are defined.
- `backend/src/config/env.js` — `config.mapboxToken` is exported.
- `.env` and `frontend/.env` — `MAPBOX_TOKEN` and `VITE_MAPBOX_ACCESS_TOKEN` are set.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `backend/src/routes/allocation.js` | Modify | Add fire-and-forget `getRoute()` call after manual allocation |
| `backend/src/services/simulationEngine.js` | Modify | Emit `order:route` socket event inside getRoute().then() |
| `frontend/src/context/SimulationContext.jsx` | Modify | Add `routes` Map state + `order:route` socket listener |
| `frontend/src/pages/RiderMap.jsx` | Modify | Add GeoJSON line Source+Layer for active routes |
| `frontend/src/pages/OrderMap.jsx` | Rewrite | Full Mapbox map with route line, restaurant/customer/rider markers |
| `frontend/src/pages/OrderMap.module.css` | Create | `.mapWrap { width: 100%; height: 420px; }` |

---

## Task 1: Emit `order:route` Socket Event from simulationEngine.js

**Files:**
- Modify: `backend/src/services/simulationEngine.js` (the `.then()` block of the fire-and-forget getRoute call, around lines 298–314)

- [ ] **Step 1: Add the ioRef.emit call in the getRoute().then() block**

Find the `.then(route => {` block that starts around line 298. The current code updates riderState and returns `Order.findByIdAndUpdate(...)`. Add the emit between the riderState update and the DB write:

```js
    getRoute(
      { lat: leg1OriginLat,        lng: leg1OriginLng         },
      { lat: order.restaurantLat,  lng: order.restaurantLng   },
      { lat: order.customerLat,    lng: order.customerLng     }
    ).then(route => {
      const r = riderState.get(winnerId);
      if (r && r.currentOrderId?.toString() === orderId) {
        r.legCoords              = route.leg1Coords;
        r.leg2Coords             = route.leg2Coords;
        r.currentSegmentIdx      = 0;
        r.distanceCoveredOnSegment = 0;
        r.legDuration_s          = route.leg1Duration_s;
        r.leg2Duration_s         = route.leg2Duration_s;
      }
      if (ioRef) {
        ioRef.emit('order:route', {
          orderId,
          riderId: winnerId,
          leg1Coords: route.leg1Coords,
          leg2Coords: route.leg2Coords,
        });
      }
      return Order.findByIdAndUpdate(order._id, {
        leg1Coords:     route.leg1Coords,
        leg2Coords:     route.leg2Coords,
        leg1Duration_s: route.leg1Duration_s,
        leg2Duration_s: route.leg2Duration_s,
      });
    }).catch(err => console.warn('[sim] getRoute failed, using lerp fallback:', err.message));
```

- [ ] **Step 2: Verify the server compiles (no syntax errors)**

Run: `node --input-type=module < /dev/null 2>&1` is not helpful here — instead start the backend briefly and check for import errors:

```bash
cd backend && node --check src/services/simulationEngine.js
```

Expected: no output (clean). Any error here means a syntax mistake.

---

## Task 2: Add getRoute() to Manual Allocation Endpoint

**Files:**
- Modify: `backend/src/routes/allocation.js`

The `POST /api/allocation/allocate` route assigns riders but never fetches the road-snapped route. The `simulationEngine.js` handles this for queue-based allocations, but the REST endpoint needs it too so the Order document gets `leg1Coords`/`leg2Coords` for the OrderMap page.

- [ ] **Step 1: Import getRoute at the top of allocation.js**

Add this import after the existing imports:

```js
import { getRoute } from '../services/routingService.js';
```

- [ ] **Step 2: Fire-and-forget getRoute after the Promise.all write**

After the `await Promise.all([...])` block (around line 63), add:

```js
    getRoute(
      { lat: winner.latitude,     lng: winner.longitude      },
      { lat: order.restaurantLat, lng: order.restaurantLng   },
      { lat: order.customerLat,   lng: order.customerLng     }
    ).then(route =>
      Order.findByIdAndUpdate(order._id, {
        leg1Coords:     route.leg1Coords,
        leg2Coords:     route.leg2Coords,
        leg1Duration_s: route.leg1Duration_s,
        leg2Duration_s: route.leg2Duration_s,
      })
    ).catch(err => console.warn('[allocation] getRoute failed, lerp coords remain:', err.message));
```

This is fire-and-forget — the HTTP response is sent immediately with the allocation result, and the route data updates the Order document asynchronously (within ~1–2 seconds).

- [ ] **Step 3: Syntax-check allocation.js**

```bash
cd backend && node --check src/routes/allocation.js
```

Expected: no output.

---

## Task 3: Add routes State to SimulationContext

**Files:**
- Modify: `frontend/src/context/SimulationContext.jsx`

- [ ] **Step 1: Add routes state and order:route listener**

The full updated `SimulationContext.jsx` (replace the entire file):

```jsx
import { createContext, useContext, useEffect, useState } from 'react';
import { io } from 'socket.io-client';

const SimulationContext = createContext(null);

const WS_URL = import.meta.env.VITE_WS_URL || 'http://localhost:5000';

export function SimulationProvider({ children }) {
  const [connected, setConnected]     = useState(false);
  const [riders, setRiders]           = useState([]);
  const [queueDepth, setQueueDepth]   = useState(0);
  const [allocations, setAllocations] = useState([]);
  const [routes, setRoutes]           = useState(new Map());

  useEffect(() => {
    const socket = io(WS_URL, { transports: ['websocket'] });

    socket.on('connect',    () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on('simulation:tick', (data) => {
      setRiders(data.riders ?? []);
      setQueueDepth(data.queueDepth ?? 0);
    });

    socket.on('order:assigned', (event) => {
      setAllocations((prev) => [{ ...event, ts: Date.now() }, ...prev].slice(0, 100));
    });

    socket.on('order:route', ({ orderId, riderId, leg1Coords, leg2Coords }) => {
      setRoutes((prev) => new Map(prev).set(orderId, { riderId, leg1Coords, leg2Coords }));
    });

    socket.on('order:delivered', ({ orderId }) => {
      setAllocations((prev) =>
        prev.map((a) => (a.orderId === orderId ? { ...a, delivered: true } : a))
      );
      setRoutes((prev) => {
        const next = new Map(prev);
        next.delete(orderId);
        return next;
      });
    });

    return () => { socket.disconnect(); };
  }, []);

  return (
    <SimulationContext.Provider value={{ connected, riders, queueDepth, allocations, routes }}>
      {children}
    </SimulationContext.Provider>
  );
}

export function useSimulation() {
  return useContext(SimulationContext);
}
```

- [ ] **Step 2: Verify no lint errors**

```bash
cd frontend && npx eslint src/context/SimulationContext.jsx --max-warnings 0
```

Expected: clean output (or only pre-existing warnings unrelated to this file).

---

## Task 4: Add Route Lines to RiderMap

**Files:**
- Modify: `frontend/src/pages/RiderMap.jsx`

Phase 2 renders a GeoJSON LineString layer under the rider circles showing each active order's full route (rider → restaurant → customer).

- [ ] **Step 1: Replace RiderMap.jsx with the route-line version**

```jsx
import 'mapbox-gl/dist/mapbox-gl.css';
import { useMemo } from 'react';
import { Box } from '@mui/material';
import Map, { Source, Layer } from 'react-map-gl';
import PageHeader from '../components/common/PageHeader';
import MapPanel from '../components/common/MapPanel';
import { useSimulation } from '../context/SimulationContext';
import styles from './RiderMap.module.css';

const MAPBOX_TOKEN  = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
const RANCHI_CENTER = { longitude: 85.33, latitude: 23.35, zoom: 13 };
const MAP_STYLE     = 'mapbox://styles/mapbox/dark-v11';

const circleLayer = {
  id:   'riders',
  type: 'circle',
  paint: {
    'circle-radius': 8,
    'circle-color': [
      'match', ['get', 'status'],
      'IDLE',      '#0070f3',
      'ACCEPTED',  '#f5a623',
      'PICKED_UP', '#7928ca',
      /* default */ '#a1a1a1',
    ],
    'circle-stroke-color': '#ffffff',
    'circle-stroke-width': 1.5,
    'circle-opacity': [
      'match', ['get', 'availabilityStatus'],
      'OFFLINE', 0.35,
      /* default */ 1,
    ],
  },
};

const routeLineLayer = {
  id:   'routes',
  type: 'line',
  paint: {
    'line-color':   '#f5a623',
    'line-width':   2,
    'line-opacity': 0.65,
  },
};

export default function RiderMap() {
  const { riders, connected, queueDepth, routes } = useSimulation();

  const riderGeojson = useMemo(() => ({
    type: 'FeatureCollection',
    features: riders.map((r) => ({
      type:       'Feature',
      geometry:   { type: 'Point', coordinates: [r.lng, r.lat] },
      properties: { id: r._id, status: r.status, availabilityStatus: r.availabilityStatus },
    })),
  }), [riders]);

  const routeGeojson = useMemo(() => ({
    type: 'FeatureCollection',
    features: Array.from(routes.values()).map(({ leg1Coords, leg2Coords }) => ({
      type:     'Feature',
      geometry: { type: 'LineString', coordinates: [...leg1Coords, ...leg2Coords] },
      properties: {},
    })),
  }), [routes]);

  const eyebrow = connected
    ? `Fleet — Live · ${riders.length} riders · Queue: ${queueDepth}`
    : 'Fleet — Waiting for simulation…';

  return (
    <Box>
      <PageHeader
        eyebrow="Ops — Fleet"
        title="Rider Map"
        description="Live positions of every rider, color-coded by movement state."
      />

      <MapPanel
        eyebrow={eyebrow}
        legend={[
          { label: 'Idle',      color: 'link' },
          { label: 'Accepted',  color: 'warning' },
          { label: 'Picked up', color: 'violet' },
          { label: 'Offline',   color: 'faint' },
        ]}
        variant="full"
      >
        <div className={styles.mapWrap}>
          <Map
            mapboxAccessToken={MAPBOX_TOKEN}
            initialViewState={RANCHI_CENTER}
            mapStyle={MAP_STYLE}
          >
            <Source id="routes" type="geojson" data={routeGeojson}>
              <Layer {...routeLineLayer} />
            </Source>
            <Source id="riders" type="geojson" data={riderGeojson}>
              <Layer {...circleLayer} />
            </Source>
          </Map>
        </div>
      </MapPanel>
    </Box>
  );
}
```

Note: routes Source is rendered before riders Source so route lines appear under the dots.

---

## Task 5: Build the OrderMap Page

**Files:**
- Create: `frontend/src/pages/OrderMap.module.css`
- Rewrite: `frontend/src/pages/OrderMap.jsx`

OrderMap shows the full route for a single order: route line, restaurant pin, customer pin, and the live rider position (updated every tick from SimulationContext).

- [ ] **Step 1: Create OrderMap.module.css**

```css
.mapWrap {
  width: 100%;
  height: 420px;
}

.pinRestaurant {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #f5a623;
  border: 2px solid #ffffff;
}

.pinCustomer {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #7928ca;
  border: 2px solid #ffffff;
}

.pinRider {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #0070f3;
  border: 2px solid #ffffff;
}
```

- [ ] **Step 2: Rewrite OrderMap.jsx**

```jsx
import 'mapbox-gl/dist/mapbox-gl.css';
import { useEffect, useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { Box } from '@mui/material';
import Map, { Source, Layer, Marker } from 'react-map-gl';
import PageHeader from '../components/common/PageHeader';
import MapPanel from '../components/common/MapPanel';
import StatusBadge from '../components/common/StatusBadge';
import { getOrder } from '../api/endpoints';
import { useSimulation } from '../context/SimulationContext';
import styles from './OrderMap.module.css';

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
const MAP_STYLE    = 'mapbox://styles/mapbox/dark-v11';
const RANCHI_DEFAULT = { longitude: 85.33, latitude: 23.35, zoom: 13 };

const routeLineLayer = {
  id:   'order-route',
  type: 'line',
  paint: { 'line-color': '#f5a623', 'line-width': 3, 'line-opacity': 0.85 },
};

export default function OrderMap() {
  const { id } = useParams();
  const [order, setOrder] = useState(null);
  const { riders } = useSimulation();

  useEffect(() => {
    getOrder(id)
      .then((res) => setOrder(res.data))
      .catch(() => setOrder(null));
  }, [id]);

  const assignedRider = useMemo(
    () => riders.find((r) => r.orderId === id),
    [riders, id]
  );

  const routeGeojson = useMemo(() => {
    const leg1 = order?.leg1Coords ?? [];
    const leg2 = order?.leg2Coords ?? [];
    const coords = [...leg1, ...leg2];
    return {
      type: 'FeatureCollection',
      features: coords.length >= 2
        ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }]
        : [],
    };
  }, [order]);

  const initialView = order
    ? { longitude: order.restaurantLng, latitude: order.restaurantLat, zoom: 13 }
    : RANCHI_DEFAULT;

  const hasRoute = (order?.leg1Coords?.length ?? 0) >= 2;

  return (
    <Box>
      <PageHeader
        eyebrow={`Ops — Order ${id}`}
        title="Order Map"
        description="Restaurant, customer, and assigned rider for this delivery."
        action={order && <StatusBadge kind="order" status={order.status} />}
      />

      <MapPanel
        eyebrow="Route — Rider → Restaurant → Customer"
        legend={[
          { label: 'Restaurant', color: 'warning' },
          { label: 'Customer',   color: 'violet'  },
          { label: 'Rider',      color: 'link'    },
        ]}
        variant="full"
      >
        <div className={styles.mapWrap}>
          <Map
            mapboxAccessToken={MAPBOX_TOKEN}
            initialViewState={initialView}
            mapStyle={MAP_STYLE}
          >
            {hasRoute && (
              <Source id="order-route" type="geojson" data={routeGeojson}>
                <Layer {...routeLineLayer} />
              </Source>
            )}

            {order && (
              <Marker longitude={order.restaurantLng} latitude={order.restaurantLat} anchor="center">
                <div className={styles.pinRestaurant} />
              </Marker>
            )}

            {order && (
              <Marker longitude={order.customerLng} latitude={order.customerLat} anchor="center">
                <div className={styles.pinCustomer} />
              </Marker>
            )}

            {assignedRider && (
              <Marker longitude={assignedRider.lng} latitude={assignedRider.lat} anchor="center">
                <div className={styles.pinRider} />
              </Marker>
            )}
          </Map>
        </div>
      </MapPanel>
    </Box>
  );
}
```

- [ ] **Step 3: Verify the frontend builds without errors**

```bash
cd frontend && npx vite build 2>&1 | tail -20
```

Expected: `built in X.Xs` with no error lines.

---

## Task 6: Postman API Verification

Start the backend server before running these tests:

```bash
cd backend && node src/server.js
```

- [ ] **Step 1: Verify simulation start endpoint**

```
POST http://localhost:5000/api/simulation/start
Headers: { Content-Type: application/json }
Body: {}
```

Expected response:
```json
{ "success": true, "status": { "running": true, "riderCount": 32, "queueDepth": 0 } }
```

- [ ] **Step 2: Create a batch of orders**

```
POST http://localhost:5000/api/orders/bulk
Headers: { Content-Type: application/json }
Body: { "count": 5 }
```

Expected: array of 5 order objects, each with status `"PENDING"` and empty `leg1Coords: []`.

- [ ] **Step 3: Wait 3 seconds, then check orders for route data**

After the simulation tick runs (~1–3 seconds), pending orders should be ASSIGNED and have leg1Coords populated:

```
GET http://localhost:5000/api/orders?status=ASSIGNED
```

Expected: at least one order with `leg1Coords` as a non-empty array of `[lng, lat]` pairs (Mapbox response takes ~1 second to arrive after assignment).

- [ ] **Step 4: Test manual allocation endpoint**

First, create a pending order:
```
POST http://localhost:5000/api/orders
Body: {}
```

Copy the returned `_id`. Then:
```
POST http://localhost:5000/api/allocation/allocate
Body: { "orderId": "<paste_id_here>" }
```

Expected: `{ "assigned": true, "riderId": "...", "score": 0.XX, ... }`

Then wait 2 seconds and fetch the order:
```
GET http://localhost:5000/api/orders/<paste_id_here>
```

Expected: `leg1Coords` is now a non-empty array (route fetched asynchronously after assignment).

- [ ] **Step 5: Verify simulation status**

```
GET http://localhost:5000/api/simulation/status
```

Expected: `{ "success": true, "status": { "running": true, "riderCount": 32, "queueDepth": 0 } }`

---

## Task 7: Playwright UI Verification

Start both servers before running Playwright:
- Backend: `cd backend && node src/server.js`
- Frontend: `cd frontend && npm run dev`

- [ ] **Step 1: Open the fleet map and verify route lines appear**

Navigate to `http://localhost:5173` (or the Vite dev server port). Log in, go to Rider Map page.

Verify:
- Rider dots appear on the map (colored circles)
- After orders are allocated (within 3-5 seconds), orange route lines appear connecting rider → restaurant → customer positions
- Lines disappear when `order:delivered` is received

- [ ] **Step 2: Open an order map and verify markers + route line**

Navigate to an allocated order's page: `http://localhost:5173/orders/<orderId>/map`

Verify:
- Orange dot at restaurant coordinates
- Purple dot at customer coordinates
- Blue dot at rider's live position (updates every ~1 second)
- Orange route line connects the three points (appears within ~2 seconds of page load once route is fetched)

- [ ] **Step 3: Verify lerp fallback when Mapbox is unavailable**

Temporarily set `MAPBOX_TOKEN=invalid` in `.env`, restart backend, start simulation, create an order.

Expected: server logs `[sim] getRoute failed, using lerp fallback: Mapbox Directions error: 401`, rider still moves in a straight line (lerp), no crash.

Restore the correct token after verifying.

---

## Spec Coverage Self-Review

| Spec requirement | Task covering it |
|-----------------|-----------------|
| routingService.js: getRoute() with 3 waypoints | Already done (not re-implemented) |
| allocation.js: call getRoute after winner selected | Task 2 |
| allocation.js: write leg1Coords/leg2Coords to Order | Task 2 |
| simulationEngine.js: polyline walk instead of lerp | Already done (not re-implemented) |
| simulationEngine.js: lerp fallback for empty coords | Already done (not re-implemented) |
| Frontend: GeoJSON circles + route line | Task 4 (RiderMap), Task 5 (OrderMap) |
| order:route socket event for frontend rendering | Task 1 |
| Postman verification | Task 6 |
| Playwright UI verification | Task 7 |

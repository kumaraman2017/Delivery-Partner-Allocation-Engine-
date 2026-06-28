import { latLngToCell } from 'h3-js';
import { getCandidateCells, allocateOrder as scoreAllocate } from './allocationEngine.js';
import { getRoute } from './routingService.js';
import {
  getWeights,
  RIDER_SPEED_KMH,
  TICK_INTERVAL_MS,
  H3_RESOLUTION,
} from '../config/constants.js';
import { haversine } from '../utils/haversine.js';
import Rider from '../models/Rider.js';
import Order from '../models/Order.js';
import AllocationHistory from '../models/AllocationHistory.js';

// ─── In-memory state ─────────────────────────────────────────────────────────

const riderState        = new Map();   // riderId(string) → riderEntry
const h3Buckets         = new Map();   // h3Cell(string)  → Set<riderId(string)>
const pendingQueue      = new Map();   // orderId(string)  → orderDoc
const activeRoutes      = new Map();   // orderId(string)  → { riderId, leg1Coords, leg2Coords }
const recentAssignments = [];          // capped ring-buffer of last 20 order:assigned payloads
const RECENT_CAP        = 20;

let tickTimer = null;
let ioRef     = null;
let running   = false;

// ─── Public API ──────────────────────────────────────────────────────────────

export function initSimulation(io) {
  ioRef = io;
  io.on('connection', (socket) => {
    socket.emit('simulation:status', { running });
    for (const [orderId, route] of activeRoutes) {
      socket.emit('order:route', { orderId, ...route });
    }
    if (recentAssignments.length) {
      socket.emit('recent:assignments', recentAssignments);
    }
  });
}

export async function startSimulation() {
  if (running) return;
  await hydrate();
  running   = true;
  tickTimer = setInterval(tick, TICK_INTERVAL_MS);
  if (ioRef) ioRef.emit('simulation:status', { running: true });
  console.log('[sim] started');
}

export async function stopSimulation() {
  if (!running) return;
  clearInterval(tickTimer);
  tickTimer = null;
  running   = false;

  // Flush current in-memory state to DB so restarts always have a clean baseline.
  const writes = [];
  for (const [riderId, rider] of riderState) {
    writes.push(
      Rider.findByIdAndUpdate(riderId, {
        status:         rider.status,
        currentOrderId: rider.currentOrderId ?? null,
        activeOrders:   rider.status === 'IDLE' ? 0 : 1,
        latitude:       rider.lat,
        longitude:      rider.lng,
        h3Index:        rider.h3Index,
      }).catch(err => console.error('[sim] flush write failed for', rider.name, ':', err.message))
    );
  }
  await Promise.allSettled(writes);
  if (ioRef) ioRef.emit('simulation:status', { running: false });
  console.log(`[sim] stopped + flushed ${riderState.size} riders to DB`);
}

export function getStatus() {
  return { running, riderCount: riderState.size, queueDepth: pendingQueue.size };
}

export function addPendingOrder(order) {
  if (!running) return;
  pendingQueue.set(order._id.toString(), order);
}

// Called by allocation.js when a second order is queued for a busy rider.
// Stores the order data so _transitionToDelivered can chain into it without
// a DB fetch, and removes it from pendingQueue to prevent re-allocation.
export function queueNextOrder(riderId, orderDoc) {
  if (!running) return;
  const rider = riderState.get(riderId.toString());
  if (!rider) return;
  rider.nextOrderId = orderDoc._id;
  rider.nextOrderData = {
    _id:           orderDoc._id,
    restaurantLat: orderDoc.restaurantLat,
    restaurantLng: orderDoc.restaurantLng,
    customerLat:   orderDoc.customerLat,
    customerLng:   orderDoc.customerLng,
  };
  pendingQueue.delete(orderDoc._id.toString());
}

// ─── Hydration ───────────────────────────────────────────────────────────────

// Detect and repair riders whose status is non-IDLE but have no linked order —
// caused by a failed ASSIGNED write followed by a successful PICKED_UP write.
async function _healOrphanedRiders() {
  const orphaned = await Rider.find({
    availabilityStatus: 'ONLINE',
    status: { $in: ['ACCEPTED', 'PICKED_UP'] },
    currentOrderId: null,
  });
  if (!orphaned.length) return;

  const orphanedIds = orphaned.map(r => r._id);
  console.warn(`[sim] healing ${orphaned.length} orphaned rider(s):`, orphaned.map(r => r.name).join(', '));

  await Promise.all([
    // Reset orphaned riders to IDLE
    Rider.updateMany(
      { _id: { $in: orphanedIds } },
      { status: 'IDLE', currentOrderId: null, activeOrders: 0 }
    ),
    // ASSIGNED orders with no rider in-flight → re-queue as PENDING
    Order.updateMany(
      { assignedRiderId: { $in: orphanedIds }, status: 'ASSIGNED' },
      { $set: { status: 'PENDING', assignedRiderId: null, assignedAt: null } }
    ),
    // PICKED_UP orders → cancel (food was collected but delivery never completed)
    Order.updateMany(
      { assignedRiderId: { $in: orphanedIds }, status: 'PICKED_UP' },
      { $set: { status: 'CANCELLED', cancelledAt: new Date() } }
    ),
  ]);
}

async function hydrate() {
  await _healOrphanedRiders();

  riderState.clear();
  h3Buckets.clear();
  pendingQueue.clear();
  activeRoutes.clear();
  recentAssignments.length = 0;

  const riders = await Rider.find({ availabilityStatus: 'ONLINE' }).populate({
    path: 'currentOrderId',
    select: 'restaurantLat restaurantLng customerLat customerLng leg1Duration_s leg2Duration_s leg1OriginLat leg1OriginLng leg1Coords leg2Coords legStartedAt pickedUpAt restaurantName customerName',
  });

  const now = Date.now();

  for (const rider of riders) {
    const id    = rider._id.toString();
    const entry = _buildEntry(rider);

    if (rider.status === 'ACCEPTED' && rider.currentOrderId) {
      const ord        = rider.currentOrderId;
      const originLat  = ord.leg1OriginLat  ?? rider.latitude;
      const originLng  = ord.leg1OriginLng  ?? rider.longitude;
      const startedAt  = ord.legStartedAt   ? new Date(ord.legStartedAt) : new Date(now);
      const duration_s = ord.leg1Duration_s ?? 60;
      const legCoords  = ord.leg1Coords?.length >= 2 ? ord.leg1Coords : [];

      Object.assign(entry, {
        currentOrderId: ord._id,
        legOriginLat: originLat, legOriginLng: originLng,
        legDestLat: ord.restaurantLat, legDestLng: ord.restaurantLng,
        legStartedAt: startedAt, legDuration_s: duration_s,
        restaurantLat: ord.restaurantLat, restaurantLng: ord.restaurantLng,
        customerLat: ord.customerLat,   customerLng: ord.customerLng,
        leg2Duration_s: ord.leg2Duration_s,
        legCoords,
        leg2Coords: ord.leg2Coords ?? [],
        currentSegmentIdx: 0,
        distanceCoveredOnSegment: 0,
      });

      if (legCoords.length >= 2) {
        const elapsed_s = (now - startedAt.getTime()) / 1000;
        _preAdvancePolyline(entry, (RIDER_SPEED_KMH / 3.6) * elapsed_s);
        _positionFromPolyline(entry);
      } else {
        const t    = Math.min(1, (now - startedAt.getTime()) / (duration_s * 1000));
        entry.lat  = originLat + t * (ord.restaurantLat - originLat);
        entry.lng  = originLng + t * (ord.restaurantLng - originLng);
      }
      entry.h3Index = latLngToCell(entry.lat, entry.lng, H3_RESOLUTION);

    } else if (rider.status === 'PICKED_UP' && rider.currentOrderId) {
      const ord        = rider.currentOrderId;
      const startedAt  = ord.pickedUpAt     ? new Date(ord.pickedUpAt) : new Date(now);
      const duration_s = ord.leg2Duration_s ?? 120;
      const legCoords  = ord.leg2Coords?.length >= 2 ? ord.leg2Coords : [];

      Object.assign(entry, {
        currentOrderId: ord._id,
        legOriginLat: ord.restaurantLat, legOriginLng: ord.restaurantLng,
        legDestLat: ord.customerLat,    legDestLng: ord.customerLng,
        legStartedAt: startedAt, legDuration_s: duration_s,
        restaurantLat: ord.restaurantLat, restaurantLng: ord.restaurantLng,
        customerLat: ord.customerLat,   customerLng: ord.customerLng,
        leg2Duration_s: ord.leg2Duration_s,
        legCoords,
        leg2Coords: [],
        currentSegmentIdx: 0,
        distanceCoveredOnSegment: 0,
      });

      if (legCoords.length >= 2) {
        const elapsed_s = (now - startedAt.getTime()) / 1000;
        _preAdvancePolyline(entry, (RIDER_SPEED_KMH / 3.6) * elapsed_s);
        _positionFromPolyline(entry);
      } else {
        const t   = Math.min(1, (now - startedAt.getTime()) / (duration_s * 1000));
        entry.lat = ord.restaurantLat + t * (ord.customerLat - ord.restaurantLat);
        entry.lng = ord.restaurantLng + t * (ord.customerLng - ord.restaurantLng);
      }
      entry.h3Index = latLngToCell(entry.lat, entry.lng, H3_RESOLUTION);

    } else {
      _addToH3(id, entry.h3Index);
    }

    riderState.set(id, entry);
  }

  const pending = await Order.find({ status: 'PENDING' });
  for (const ord of pending) pendingQueue.set(ord._id.toString(), ord);

  // Populate nextOrderData for riders who had a queued order, and remove those
  // orders from pendingQueue so the sim engine doesn't re-allocate them.
  for (const [, entry] of riderState) {
    if (!entry.nextOrderId) continue;
    const nextOrdDoc = pendingQueue.get(entry.nextOrderId.toString());
    if (nextOrdDoc) {
      entry.nextOrderData = {
        _id:           nextOrdDoc._id,
        restaurantLat: nextOrdDoc.restaurantLat,
        restaurantLng: nextOrdDoc.restaurantLng,
        customerLat:   nextOrdDoc.customerLat,
        customerLng:   nextOrdDoc.customerLng,
      };
      pendingQueue.delete(entry.nextOrderId.toString());
    } else {
      entry.nextOrderId = null;
    }
  }

  console.log(`[sim] hydrated — ${riderState.size} riders, ${pendingQueue.size} pending orders`);
}

function _buildEntry(rider) {
  return {
    _id:   rider._id,
    name:  rider.name,
    lat:   rider.latitude,
    lng:   rider.longitude,
    h3Index: rider.h3Index,
    status:  rider.status,
    availabilityStatus: rider.availabilityStatus,
    rating:  rider.rating,
    deliveryTimestamps: rider.deliveryTimestamps ?? [],
    currentOrderId: null,

    // Queued next order (set when a second order is pre-assigned while rider is busy)
    nextOrderId:   rider.nextOrderId ?? null,
    nextOrderData: null,   // { _id, restaurantLat, restaurantLng, customerLat, customerLng }

    // Leg navigation — lerp fallback fields
    legOriginLat: null, legOriginLng: null,
    legDestLat:   null, legDestLng:   null,
    legStartedAt: null, legDuration_s: null,

    // Stored for leg-2 setup
    restaurantLat: null, restaurantLng: null,
    customerLat:   null, customerLng:   null,
    leg2Duration_s: null,

    // Phase 2 — road-snapped polyline traversal
    legCoords: [],              // [[lng, lat], ...] — current leg polyline
    leg2Coords: [],             // stored at assignment, swapped in at PICKED_UP
    currentSegmentIdx: 0,
    distanceCoveredOnSegment: 0,
  };
}

// ─── Tick ─────────────────────────────────────────────────────────────────────

function tick() {
  const now = Date.now();
  const tickRiders = [];

  // Phase 1 — advance positions + detect leg completions
  for (const [riderId, rider] of riderState) {
    if (rider.status !== 'IDLE' && rider.legStartedAt && rider.legDuration_s) {
      let legComplete;

      if (rider.legCoords.length >= 2) {
        // Phase 2: walk along road-snapped polyline
        legComplete = _advanceAlongPolyline(rider);
      } else {
        // Phase 1 fallback: straight-line lerp
        const t = Math.min(1, (now - rider.legStartedAt.getTime()) / (rider.legDuration_s * 1000));
        rider.lat = rider.legOriginLat + t * (rider.legDestLat - rider.legOriginLat);
        rider.lng = rider.legOriginLng + t * (rider.legDestLng - rider.legOriginLng);
        legComplete = t >= 1;
      }

      rider.h3Index = latLngToCell(rider.lat, rider.lng, H3_RESOLUTION);

      if (legComplete) {
        rider.lat = rider.legDestLat;
        rider.lng = rider.legDestLng;
        if (rider.status === 'ACCEPTED') {
          _transitionToPickedUp(riderId, rider, now);
        } else if (rider.status === 'PICKED_UP') {
          _transitionToDelivered(riderId, rider, now);
        }
      }
    }

    tickRiders.push({
      _id:                riderId,
      name:               rider.name,
      lat:                rider.lat,
      lng:                rider.lng,
      status:             rider.status,
      availabilityStatus: rider.availabilityStatus ?? 'ONLINE',
      orderId:            rider.currentOrderId ? rider.currentOrderId.toString() : null,
      legStepIndex:       rider.currentSegmentIdx ?? 0,
      leg:                rider.status === 'ACCEPTED' ? 'leg1'
                        : rider.status === 'PICKED_UP' ? 'leg2'
                        : null,
    });
  }

  // Phase 2 — allocate pending orders to IDLE riders
  for (const [orderId, order] of pendingQueue) {
    const candidateCells = getCandidateCells(order.restaurantLat, order.restaurantLng);
    const eligible = [];

    for (const cell of candidateCells) {
      const bucket = h3Buckets.get(cell);
      if (bucket) {
        for (const rid of bucket) {
          const r = riderState.get(rid);
          if (r && r.status === 'IDLE') eligible.push(r);
        }
      }
    }

    if (!eligible.length) continue;

    const candidates = eligible.map(r => ({
      _id: r._id,
      latitude: r.lat,
      longitude: r.lng,
      status: r.status,
      rating: r.rating,
      deliveryTimestamps: r.deliveryTimestamps,
      currentOrderId: null,
    }));

    const result = scoreAllocate(order, candidates, getWeights());
    if (!result) continue;

    const winnerId = result.winner._id.toString();
    const winner   = riderState.get(winnerId);
    if (!winner || winner.status !== 'IDLE') continue;

    const leg1Duration_s = haversine(
      { lat: winner.lat, lng: winner.lng },
      { lat: order.restaurantLat, lng: order.restaurantLng }
    ) / RIDER_SPEED_KMH * 3600;

    const leg2Duration_s = haversine(
      { lat: order.restaurantLat, lng: order.restaurantLng },
      { lat: order.customerLat, lng: order.customerLng }
    ) / RIDER_SPEED_KMH * 3600;

    const leg1OriginLat = winner.lat;
    const leg1OriginLng = winner.lng;

    // Sync in-memory update — prevents double-allocation on next tick
    pendingQueue.delete(orderId);
    _removeFromH3(winnerId, winner.h3Index);

    winner.status         = 'ACCEPTED';
    winner.currentOrderId = order._id;
    winner.legOriginLat   = leg1OriginLat;
    winner.legOriginLng   = leg1OriginLng;
    winner.legDestLat     = order.restaurantLat;
    winner.legDestLng     = order.restaurantLng;
    winner.legStartedAt   = new Date(now);
    winner.legDuration_s  = leg1Duration_s;
    winner.restaurantLat  = order.restaurantLat;
    winner.restaurantLng  = order.restaurantLng;
    winner.customerLat    = order.customerLat;
    winner.customerLng    = order.customerLng;
    winner.leg2Duration_s = leg2Duration_s;
    winner.legCoords              = [];    // filled async by getRoute below
    winner.leg2Coords             = [];
    winner.currentSegmentIdx      = 0;
    winner.distanceCoveredOnSegment = 0;

    // Fetch road-snapped route (fire-and-forget — lerp covers us until it arrives)
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
      activeRoutes.set(orderId, {
        riderId: winnerId,
        leg1Coords: route.leg1Coords,
        leg2Coords: route.leg2Coords,
      });
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

    // Async DB writes (assignment)
    Promise.all([
      Order.findByIdAndUpdate(order._id, {
        status: 'ASSIGNED',
        assignedRiderId: result.winner._id,
        assignedAt: new Date(now),
        allocationScore: result.score,
        leg1Duration_s,
        leg2Duration_s,
        leg1OriginLat,
        leg1OriginLng,
        legStartedAt: new Date(now),
      }),
      Rider.findByIdAndUpdate(result.winner._id, {
        status: 'ACCEPTED',
        currentOrderId: order._id,
        activeOrders: 1,
      }),
      AllocationHistory.create({
        orderId: order._id,
        riderId: result.winner._id,
        allocationScore: result.score,
        breakdown: result.breakdown,
        candidatesConsidered: result.candidatesConsidered,
      }),
    ]).catch(err => console.error('[sim] assign write failed:', err.message));

    if (ioRef) {
      const assignedPayload = {
        orderId:        order._id.toString(),
        riderId:        winnerId,
        riderName:      winner.name,
        restaurantName: order.restaurantName,
        customerName:   order.customerName,
        score:          result.score,
        ts:             now,
      };
      ioRef.emit('order:assigned', assignedPayload);
      recentAssignments.push(assignedPayload);
      if (recentAssignments.length > RECENT_CAP) recentAssignments.shift();
    }
  }

  // Phase 3 — broadcast tick to all connected clients
  if (ioRef) {
    ioRef.emit('simulation:tick', {
      riders:     tickRiders,
      queueDepth: pendingQueue.size,
    });
  }
}

// ─── State transitions ────────────────────────────────────────────────────────

function _transitionToPickedUp(riderId, rider, now) {
  rider.status        = 'PICKED_UP';
  rider.legOriginLat  = rider.restaurantLat;
  rider.legOriginLng  = rider.restaurantLng;
  rider.legDestLat    = rider.customerLat;
  rider.legDestLng    = rider.customerLng;
  rider.legStartedAt  = new Date(now);
  rider.legDuration_s = rider.leg2Duration_s;
  rider.lat    = rider.restaurantLat;
  rider.lng    = rider.restaurantLng;
  rider.h3Index = latLngToCell(rider.lat, rider.lng, H3_RESOLUTION);

  // Switch to leg-2 polyline (empty → lerp fallback takes over until route arrives)
  rider.legCoords              = rider.leg2Coords ?? [];
  rider.leg2Coords             = [];
  rider.currentSegmentIdx      = 0;
  rider.distanceCoveredOnSegment = 0;

  const orderId = rider.currentOrderId;
  Promise.all([
    Order.findByIdAndUpdate(orderId, {
      status: 'PICKED_UP',
      pickedUpAt: new Date(now),
      legStartedAt: new Date(now),
    }),
    // Explicitly re-affirm currentOrderId here so this write is idempotent even
    // if the earlier ASSIGNED write failed silently (the primary cause of stuck riders).
    Rider.findByIdAndUpdate(riderId, { status: 'PICKED_UP', currentOrderId: orderId }),
  ]).catch(err => console.error('[sim] pickup write failed:', err.message));

  if (ioRef) ioRef.emit('order:status', { orderId: orderId.toString(), status: 'PICKED_UP', riderId });
}

function _transitionToDelivered(riderId, rider, now) {
  const deliveredOrderId = rider.currentOrderId;
  activeRoutes.delete(deliveredOrderId.toString());

  // Snap to delivery drop-off
  rider.lat     = rider.customerLat;
  rider.lng     = rider.customerLng;
  rider.h3Index = latLngToCell(rider.lat, rider.lng, H3_RESOLUTION);
  rider.deliveryTimestamps = [...rider.deliveryTimestamps, new Date(now)];

  // Clear current-leg fields
  rider.currentOrderId         = null;
  rider.legStartedAt           = null; rider.legDuration_s  = null;
  rider.legOriginLat           = null; rider.legOriginLng   = null;
  rider.legDestLat             = null; rider.legDestLng     = null;
  rider.restaurantLat          = null; rider.restaurantLng  = null;
  rider.customerLat            = null; rider.customerLng    = null;
  rider.leg2Duration_s         = null;
  rider.legCoords              = [];
  rider.leg2Coords             = [];
  rider.currentSegmentIdx      = 0;
  rider.distanceCoveredOnSegment = 0;

  Order.findByIdAndUpdate(deliveredOrderId, {
    status: 'DELIVERED', deliveredAt: new Date(now),
  }).catch(err => console.error('[sim] delivered write failed:', err.message));

  if (ioRef) ioRef.emit('order:delivered', { orderId: deliveredOrderId.toString(), riderId });

  if (rider.nextOrderId && rider.nextOrderData) {
    // ── Chain into the queued next order ──────────────────────────────────────
    const nextId    = rider.nextOrderId;
    const nextData  = rider.nextOrderData;
    const nextIdStr = nextId.toString();
    const originLat = rider.lat;
    const originLng = rider.lng;

    rider.nextOrderId   = null;
    rider.nextOrderData = null;

    const leg1Duration_s = haversine(
      { lat: originLat,              lng: originLng              },
      { lat: nextData.restaurantLat, lng: nextData.restaurantLng }
    ) / RIDER_SPEED_KMH * 3600;

    const leg2Duration_s = haversine(
      { lat: nextData.restaurantLat, lng: nextData.restaurantLng },
      { lat: nextData.customerLat,   lng: nextData.customerLng   }
    ) / RIDER_SPEED_KMH * 3600;

    rider.status         = 'ACCEPTED';
    rider.currentOrderId = nextId;
    rider.legOriginLat   = originLat;
    rider.legOriginLng   = originLng;
    rider.legDestLat     = nextData.restaurantLat;
    rider.legDestLng     = nextData.restaurantLng;
    rider.legStartedAt   = new Date(now);
    rider.legDuration_s  = leg1Duration_s;
    rider.restaurantLat  = nextData.restaurantLat;
    rider.restaurantLng  = nextData.restaurantLng;
    rider.customerLat    = nextData.customerLat;
    rider.customerLng    = nextData.customerLng;
    rider.leg2Duration_s = leg2Duration_s;

    Promise.all([
      Order.findByIdAndUpdate(nextId, {
        status:          'ASSIGNED',
        assignedRiderId: riderId,
        assignedAt:      new Date(now),
        legStartedAt:    new Date(now),
        leg1Duration_s,
        leg2Duration_s,
        leg1OriginLat:   originLat,
        leg1OriginLng:   originLng,
      }),
      Rider.findByIdAndUpdate(riderId, {
        status:         'ACCEPTED',
        currentOrderId: nextId,
        nextOrderId:    null,
        activeOrders:   1,
        latitude:       rider.lat,
        longitude:      rider.lng,
        h3Index:        rider.h3Index,
        $push:          { deliveryTimestamps: new Date(now) },
      }),
    ]).catch(err => console.error('[sim] next-order chain write failed:', err.message));

    getRoute(
      { lat: originLat,              lng: originLng              },
      { lat: nextData.restaurantLat, lng: nextData.restaurantLng },
      { lat: nextData.customerLat,   lng: nextData.customerLng   }
    ).then(route => {
      const r = riderState.get(riderId);
      if (r && r.currentOrderId?.toString() === nextIdStr) {
        r.legCoords              = route.leg1Coords;
        r.leg2Coords             = route.leg2Coords;
        r.currentSegmentIdx      = 0;
        r.distanceCoveredOnSegment = 0;
        r.legDuration_s          = route.leg1Duration_s;
        r.leg2Duration_s         = route.leg2Duration_s;
      }
      activeRoutes.set(nextIdStr, { riderId, leg1Coords: route.leg1Coords, leg2Coords: route.leg2Coords });
      if (ioRef) ioRef.emit('order:route', { orderId: nextIdStr, riderId, leg1Coords: route.leg1Coords, leg2Coords: route.leg2Coords });
      Order.findByIdAndUpdate(nextId, {
        leg1Coords:     route.leg1Coords,
        leg2Coords:     route.leg2Coords,
        leg1Duration_s: route.leg1Duration_s,
        leg2Duration_s: route.leg2Duration_s,
      }).catch(() => {});
    }).catch(err => console.warn('[sim] next-order route fetch failed:', err.message));

    if (ioRef) {
      const chainedPayload = { orderId: nextIdStr, riderId, riderName: rider.name, ts: now };
      ioRef.emit('order:assigned', chainedPayload);
      recentAssignments.push(chainedPayload);
      if (recentAssignments.length > RECENT_CAP) recentAssignments.shift();
    }

  } else {
    // ── No queued order — go IDLE ─────────────────────────────────────────────
    rider.status = 'IDLE';
    _addToH3(riderId, rider.h3Index);

    Rider.findByIdAndUpdate(riderId, {
      status:         'IDLE',
      currentOrderId: null,
      activeOrders:   0,
      latitude:       rider.lat,
      longitude:      rider.lng,
      h3Index:        rider.h3Index,
      $push:          { deliveryTimestamps: new Date(now) },
    }).catch(err => console.error('[sim] idle write failed:', err.message));
  }
}

// ─── Polyline traversal ───────────────────────────────────────────────────────

// Advance rider along their current legCoords polyline by one tick's worth of distance.
// Returns true when the end of the polyline is reached (leg complete).
function _advanceAlongPolyline(rider) {
  const metersPerTick = (RIDER_SPEED_KMH / 3.6) * (TICK_INTERVAL_MS / 1000);
  _preAdvancePolyline(rider, metersPerTick);

  const coords = rider.legCoords;
  const segIdx = rider.currentSegmentIdx;

  if (segIdx >= coords.length - 1) {
    const last = coords[coords.length - 1];
    rider.lat  = last[1];
    rider.lng  = last[0];
    return true;
  }

  const from   = coords[segIdx];
  const to     = coords[segIdx + 1];
  const segLen = haversine({ lat: from[1], lng: from[0] }, { lat: to[1], lng: to[0] }) * 1000;
  const t      = segLen > 0 ? Math.min(1, rider.distanceCoveredOnSegment / segLen) : 0;
  rider.lat    = from[1] + t * (to[1] - from[1]);
  rider.lng    = from[0] + t * (to[0] - from[0]);
  return false;
}

// Advance segment index and distanceCoveredOnSegment by `meters` without updating lat/lng.
function _preAdvancePolyline(rider, meters) {
  let remaining = meters;
  const coords  = rider.legCoords;
  let segIdx    = rider.currentSegmentIdx;
  let distOnSeg = rider.distanceCoveredOnSegment;

  while (remaining > 0 && segIdx < coords.length - 1) {
    const from   = coords[segIdx];
    const to     = coords[segIdx + 1];
    const segLen = haversine({ lat: from[1], lng: from[0] }, { lat: to[1], lng: to[0] }) * 1000;
    const left   = segLen - distOnSeg;

    if (remaining >= left) {
      remaining -= left;
      segIdx++;
      distOnSeg = 0;
    } else {
      distOnSeg += remaining;
      remaining  = 0;
    }
  }

  rider.currentSegmentIdx      = segIdx;
  rider.distanceCoveredOnSegment = distOnSeg;
}

// Compute lat/lng from current segmentIdx + distanceCoveredOnSegment (used in hydration).
function _positionFromPolyline(rider) {
  const coords = rider.legCoords;
  const segIdx = rider.currentSegmentIdx;

  if (segIdx >= coords.length - 1) {
    const last = coords[coords.length - 1];
    rider.lat  = last[1];
    rider.lng  = last[0];
    return;
  }

  const from   = coords[segIdx];
  const to     = coords[segIdx + 1];
  const segLen = haversine({ lat: from[1], lng: from[0] }, { lat: to[1], lng: to[0] }) * 1000;
  const t      = segLen > 0 ? Math.min(1, rider.distanceCoveredOnSegment / segLen) : 0;
  rider.lat    = from[1] + t * (to[1] - from[1]);
  rider.lng    = from[0] + t * (to[0] - from[0]);
}

// ─── H3 bucket helpers ────────────────────────────────────────────────────────

function _addToH3(riderId, cell) {
  if (!h3Buckets.has(cell)) h3Buckets.set(cell, new Set());
  h3Buckets.get(cell).add(riderId);
}

function _removeFromH3(riderId, cell) {
  const bucket = h3Buckets.get(cell);
  if (bucket) bucket.delete(riderId);
}

import { latLngToCell } from 'h3-js';
import { getCandidateCells, allocateOrder as scoreAllocate } from './allocationEngine.js';
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

const riderState = new Map();   // riderId(string) → riderEntry
const h3Buckets  = new Map();   // h3Cell(string)  → Set<riderId(string)>
const pendingQueue = new Map(); // orderId(string)  → orderDoc

let tickTimer = null;
let ioRef     = null;
let running   = false;

// ─── Public API ──────────────────────────────────────────────────────────────

export function initSimulation(io) {
  ioRef = io;
}

export async function startSimulation() {
  if (running) return;
  await hydrate();
  running   = true;
  tickTimer = setInterval(tick, TICK_INTERVAL_MS);
  console.log('[sim] started');
}

export function stopSimulation() {
  if (!running) return;
  clearInterval(tickTimer);
  tickTimer = null;
  running   = false;
  console.log('[sim] stopped');
}

export function getStatus() {
  return { running, riderCount: riderState.size, queueDepth: pendingQueue.size };
}

export function addPendingOrder(order) {
  if (!running) return;
  pendingQueue.set(order._id.toString(), order);
}

// ─── Hydration ───────────────────────────────────────────────────────────────

async function hydrate() {
  riderState.clear();
  h3Buckets.clear();
  pendingQueue.clear();

  const riders = await Rider.find({ availabilityStatus: 'ONLINE' }).populate({
    path: 'currentOrderId',
    select: 'restaurantLat restaurantLng customerLat customerLng leg1Duration_s leg2Duration_s leg1OriginLat leg1OriginLng legStartedAt pickedUpAt status restaurantName customerName',
  });

  const now = Date.now();

  for (const rider of riders) {
    const id    = rider._id.toString();
    const entry = _buildEntry(rider);

    if (rider.status === 'ACCEPTED' && rider.currentOrderId) {
      const ord         = rider.currentOrderId;
      const originLat   = ord.leg1OriginLat  ?? rider.latitude;
      const originLng   = ord.leg1OriginLng  ?? rider.longitude;
      const startedAt   = ord.legStartedAt   ? new Date(ord.legStartedAt) : new Date(now);
      const duration_s  = ord.leg1Duration_s ?? 60;
      const t           = Math.min(1, (now - startedAt.getTime()) / (duration_s * 1000));

      entry.lat          = originLat + t * (ord.restaurantLat - originLat);
      entry.lng          = originLng + t * (ord.restaurantLng - originLng);
      entry.h3Index      = latLngToCell(entry.lat, entry.lng, H3_RESOLUTION);
      entry.currentOrderId = ord._id;
      Object.assign(entry, {
        legOriginLat: originLat, legOriginLng: originLng,
        legDestLat: ord.restaurantLat, legDestLng: ord.restaurantLng,
        legStartedAt: startedAt, legDuration_s: duration_s,
        restaurantLat: ord.restaurantLat, restaurantLng: ord.restaurantLng,
        customerLat: ord.customerLat, customerLng: ord.customerLng,
        leg2Duration_s: ord.leg2Duration_s,
      });

    } else if (rider.status === 'PICKED_UP' && rider.currentOrderId) {
      const ord        = rider.currentOrderId;
      const startedAt  = ord.pickedUpAt     ? new Date(ord.pickedUpAt) : new Date(now);
      const duration_s = ord.leg2Duration_s ?? 120;
      const t          = Math.min(1, (now - startedAt.getTime()) / (duration_s * 1000));

      entry.lat          = ord.restaurantLat + t * (ord.customerLat - ord.restaurantLat);
      entry.lng          = ord.restaurantLng + t * (ord.customerLng - ord.restaurantLng);
      entry.h3Index      = latLngToCell(entry.lat, entry.lng, H3_RESOLUTION);
      entry.currentOrderId = ord._id;
      Object.assign(entry, {
        legOriginLat: ord.restaurantLat, legOriginLng: ord.restaurantLng,
        legDestLat: ord.customerLat, legDestLng: ord.customerLng,
        legStartedAt: startedAt, legDuration_s: duration_s,
        restaurantLat: ord.restaurantLat, restaurantLng: ord.restaurantLng,
        customerLat: ord.customerLat, customerLng: ord.customerLng,
        leg2Duration_s: ord.leg2Duration_s,
      });

    } else {
      _addToH3(id, entry.h3Index);
    }

    riderState.set(id, entry);
  }

  const pending = await Order.find({ status: 'PENDING' });
  for (const ord of pending) pendingQueue.set(ord._id.toString(), ord);

  console.log(`[sim] hydrated — ${riderState.size} riders, ${pendingQueue.size} pending orders`);
}

function _buildEntry(rider) {
  return {
    _id: rider._id,
    name: rider.name,
    lat: rider.latitude,
    lng: rider.longitude,
    h3Index: rider.h3Index,
    status: rider.status,
    rating: rider.rating,
    deliveryTimestamps: rider.deliveryTimestamps ?? [],
    currentOrderId: null,
    nextOrderId: rider.nextOrderId ?? null,
    legOriginLat: null, legOriginLng: null,
    legDestLat:   null, legDestLng:   null,
    legStartedAt: null, legDuration_s: null,
    restaurantLat: null, restaurantLng: null,
    customerLat:   null, customerLng:   null,
    leg2Duration_s: null,
  };
}

// ─── Tick ─────────────────────────────────────────────────────────────────────

function tick() {
  const now = Date.now();
  const tickRiders = [];

  // Phase 1 — advance positions + detect leg completions
  for (const [riderId, rider] of riderState) {
    if (rider.status !== 'IDLE' && rider.legStartedAt && rider.legDuration_s) {
      const t = Math.min(1, (now - rider.legStartedAt.getTime()) / (rider.legDuration_s * 1000));

      rider.lat    = rider.legOriginLat + t * (rider.legDestLat - rider.legOriginLat);
      rider.lng    = rider.legOriginLng + t * (rider.legDestLng - rider.legOriginLng);
      rider.h3Index = latLngToCell(rider.lat, rider.lng, H3_RESOLUTION);

      if (t >= 1) {
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
      _id:    riderId,
      name:   rider.name,
      lat:    rider.lat,
      lng:    rider.lng,
      status: rider.status,
      orderId: rider.currentOrderId ? rider.currentOrderId.toString() : null,
    });
  }

  // Phase 2 — allocate pending orders
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

    // Sync in-memory update first — prevents double-allocation on next tick
    pendingQueue.delete(orderId);
    _removeFromH3(winnerId, winner.h3Index);

    winner.status        = 'ACCEPTED';
    winner.currentOrderId = order._id;
    winner.legOriginLat  = leg1OriginLat;
    winner.legOriginLng  = leg1OriginLng;
    winner.legDestLat    = order.restaurantLat;
    winner.legDestLng    = order.restaurantLng;
    winner.legStartedAt  = new Date(now);
    winner.legDuration_s = leg1Duration_s;
    winner.restaurantLat = order.restaurantLat;
    winner.restaurantLng = order.restaurantLng;
    winner.customerLat   = order.customerLat;
    winner.customerLng   = order.customerLng;
    winner.leg2Duration_s = leg2Duration_s;

    // Async DB writes (fire-and-forget)
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
      ioRef.emit('order:assigned', {
        orderId: order._id.toString(),
        riderId: winnerId,
        riderName: winner.name,
        restaurantName: order.restaurantName,
        customerName: order.customerName,
        score: result.score,
      });
    }
  }

  // Phase 3 — broadcast
  if (ioRef) {
    ioRef.emit('simulation:tick', {
      riders: tickRiders,
      queueDepth: pendingQueue.size,
    });
  }
}

// ─── State transitions (synchronous in-memory, async DB) ─────────────────────

function _transitionToPickedUp(riderId, rider, now) {
  rider.status       = 'PICKED_UP';
  rider.legOriginLat = rider.restaurantLat;
  rider.legOriginLng = rider.restaurantLng;
  rider.legDestLat   = rider.customerLat;
  rider.legDestLng   = rider.customerLng;
  rider.legStartedAt = new Date(now);
  rider.legDuration_s = rider.leg2Duration_s;
  rider.lat    = rider.restaurantLat;
  rider.lng    = rider.restaurantLng;
  rider.h3Index = latLngToCell(rider.lat, rider.lng, H3_RESOLUTION);

  const orderId = rider.currentOrderId;

  Promise.all([
    Order.findByIdAndUpdate(orderId, {
      status: 'PICKED_UP',
      pickedUpAt: new Date(now),
      legStartedAt: new Date(now),
    }),
    Rider.findByIdAndUpdate(riderId, { status: 'PICKED_UP' }),
  ]).catch(err => console.error('[sim] pickup write failed:', err.message));

  if (ioRef) ioRef.emit('order:status', { orderId: orderId.toString(), status: 'PICKED_UP', riderId });
}

function _transitionToDelivered(riderId, rider, now) {
  const orderId = rider.currentOrderId;

  rider.lat    = rider.customerLat;
  rider.lng    = rider.customerLng;
  rider.h3Index = latLngToCell(rider.lat, rider.lng, H3_RESOLUTION);
  rider.status = 'IDLE';
  rider.deliveryTimestamps = [...rider.deliveryTimestamps, new Date(now)];
  rider.currentOrderId = null;
  rider.legStartedAt  = null;
  rider.legDuration_s = null;
  rider.legOriginLat  = null; rider.legOriginLng = null;
  rider.legDestLat    = null; rider.legDestLng   = null;
  rider.restaurantLat = null; rider.restaurantLng = null;
  rider.customerLat   = null; rider.customerLng  = null;
  rider.leg2Duration_s = null;

  _addToH3(riderId, rider.h3Index);

  Promise.all([
    Order.findByIdAndUpdate(orderId, { status: 'DELIVERED', deliveredAt: new Date(now) }),
    Rider.findByIdAndUpdate(riderId, {
      status: 'IDLE',
      currentOrderId: null,
      activeOrders: 0,
      latitude:  rider.lat,
      longitude: rider.lng,
      h3Index:   rider.h3Index,
      $push: { deliveryTimestamps: new Date(now) },
    }),
  ]).catch(err => console.error('[sim] delivered write failed:', err.message));

  if (ioRef) ioRef.emit('order:delivered', { orderId: orderId.toString(), riderId });
}

// ─── H3 bucket helpers ───────────────────────────────────────────────────────

function _addToH3(riderId, cell) {
  if (!h3Buckets.has(cell)) h3Buckets.set(cell, new Set());
  h3Buckets.get(cell).add(riderId);
}

function _removeFromH3(riderId, cell) {
  const bucket = h3Buckets.get(cell);
  if (bucket) bucket.delete(riderId);
}

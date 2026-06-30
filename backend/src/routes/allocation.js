import express from 'express';
import Rider from '../models/Rider.js';
import Order from '../models/Order.js';
import AllocationHistory from '../models/AllocationHistory.js';
import { getCandidateCells, allocateOrder } from '../services/allocationEngine.js';
import { getWeights, RIDER_SPEED_KMH } from '../config/constants.js';
import { haversine } from '../utils/haversine.js';
import { getRoute } from '../services/routingService.js';
import { queueNextOrder, syncManualAllocation } from '../services/simulationEngine.js';

const router = express.Router();

// POST /api/allocation/allocate
// Manually trigger allocation for one PENDING order (admin / simulation fallback).
router.post('/allocate', async (req, res, next) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ message: 'orderId required' });

    const order = await Order.findOne({ _id: orderId, status: 'PENDING' });
    if (!order) {
      return res.status(404).json({ message: 'Order not found or not PENDING' });
    }

    const candidateCells = getCandidateCells(order.restaurantLat, order.restaurantLng);

    const candidates = await Rider.find({
      availabilityStatus: 'ONLINE',
      nextOrderId: null,
      h3Index: { $in: candidateCells },
    }).populate('currentOrderId');

    const result = allocateOrder(order, candidates, getWeights());

    if (!result) {
      return res.json({
        assigned: false,
        message: 'No eligible riders in range — order stays PENDING',
        orderId,
        candidatesConsidered: candidates.length,
      });
    }

    const { winner, score, breakdown, candidatesConsidered } = result;
    const now = new Date();
    const isIdle = winner.status === 'IDLE';

    if (isIdle) {
      const leg1Duration_s =
        haversine(
          { lat: winner.latitude, lng: winner.longitude },
          { lat: order.restaurantLat, lng: order.restaurantLng }
        ) / RIDER_SPEED_KMH * 3600;

      const leg2Duration_s =
        haversine(
          { lat: order.restaurantLat, lng: order.restaurantLng },
          { lat: order.customerLat, lng: order.customerLng }
        ) / RIDER_SPEED_KMH * 3600;

      await Promise.all([
        Order.findByIdAndUpdate(order._id, {
          status:          'ASSIGNED',
          assignedRiderId: winner._id,
          assignedAt:      now,
          allocationScore: score,
          leg1Duration_s,
          leg2Duration_s,
          legStartedAt:    now,
          leg1OriginLat:   winner.latitude,
          leg1OriginLng:   winner.longitude,
        }),
        Rider.findByIdAndUpdate(winner._id, {
          status: 'ACCEPTED', currentOrderId: order._id, activeOrders: 1,
        }),
        AllocationHistory.create({
          orderId: order._id, riderId: winner._id,
          allocationScore: score, breakdown, candidatesConsidered,
        }),
      ]);

      syncManualAllocation(winner._id, order._id);

      getRoute(
        { lat: winner.latitude,     lng: winner.longitude    },
        { lat: order.restaurantLat, lng: order.restaurantLng },
        { lat: order.customerLat,   lng: order.customerLng   }
      ).then(route =>
        Order.findByIdAndUpdate(order._id, {
          leg1Coords:     route.leg1Coords,
          leg2Coords:     route.leg2Coords,
          leg1Duration_s: route.leg1Duration_s,
          leg2Duration_s: route.leg2Duration_s,
        })
      ).catch(err => console.warn('[allocation] getRoute failed, lerp coords remain:', err.message));

    } else {
      // Rider is busy — queue the order as nextOrderId. Order stays PENDING until
      // the rider finishes their current delivery and _transitionToDelivered chains in.
      await Promise.all([
        Rider.findByIdAndUpdate(winner._id, { nextOrderId: order._id }),
        AllocationHistory.create({
          orderId: order._id, riderId: winner._id,
          allocationScore: score, breakdown, candidatesConsidered,
        }),
      ]);

      // Sync in-memory sim state so the order is reserved and not re-allocated
      queueNextOrder(winner._id, order);
    }

    return res.json({
      assigned: true,
      orderId:  order._id,
      riderId:  winner._id,
      riderName: winner.name,
      score,
      breakdown,
      candidatesConsidered,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/allocation/history?page=1&limit=20
router.get('/history', async (req, res, next) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);

    const [records, total] = await Promise.all([
      AllocationHistory.find()
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('orderId',  'restaurantName customerName status')
        .populate('riderId',  'name rating'),
      AllocationHistory.countDocuments(),
    ]);

    res.json({ total, page, limit, records });
  } catch (err) {
    next(err);
  }
});

export default router;

import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import authRoutes        from './auth.js';
import riderRoutes       from './riders.js';
import restaurantRoutes  from './restaurants.js';
import customerRoutes    from './customers.js';
import orderRoutes       from './orders.js';
import allocationRoutes  from './allocation.js';
import configRoutes      from './config.js';
import simulationRoutes  from './simulation.js';
import Rider from '../models/Rider.js';
import Order from '../models/Order.js';

const router = express.Router();

router.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

router.get('/analytics', async (req, res) => {
  try {
    const [totalRiders, availableRiders, activeOrders, completedOrders] = await Promise.all([
      Rider.countDocuments(),
      Rider.countDocuments({ availabilityStatus: 'ONLINE', status: 'IDLE' }),
      Order.countDocuments({ status: { $in: ['ASSIGNED', 'PICKED_UP'] } }),
      Order.countDocuments({ status: 'DELIVERED' }),
    ]);
    res.json({ totalRiders, availableRiders, activeOrders, completedOrders });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.use('/auth',        authRoutes);
router.use('/riders',      protect, riderRoutes);
router.use('/restaurants', protect, restaurantRoutes);
router.use('/customers',   protect, customerRoutes);
router.use('/orders',      protect, orderRoutes);
router.use('/allocation',  protect, allocationRoutes);
router.use('/config',      protect, configRoutes);
router.use('/simulation',  protect, simulationRoutes);

export default router;

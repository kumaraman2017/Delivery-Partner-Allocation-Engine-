import express from 'express';
import {
  createSingleOrder,
  createBulkOrders,
  getAllOrders,
  getOrderById,
} from '../controllers/orderController.js';
import Order from '../models/Order.js';

const router = express.Router();

router.post('/bulk', createBulkOrders);
router.post('/',     createSingleOrder);
router.get('/',      getAllOrders);
router.get('/:id',   getOrderById);

router.put('/:id/accept', async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.status !== 'ASSIGNED')
      return res.status(409).json({ success: false, message: `Order is ${order.status}, not ASSIGNED` });
    res.json({ success: true, data: order });
  } catch (err) { next(err); }
});

export default router;

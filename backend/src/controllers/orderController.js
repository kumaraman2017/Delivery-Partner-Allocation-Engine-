import Order from '../models/Order.js';
import { createOrder, bulkCreateOrders } from '../services/orderGenerator.js';
import { addPendingOrder } from '../services/simulationEngine.js';

export const createSingleOrder = async (req, res, next) => {
  try {
    const order = await createOrder();
    addPendingOrder(order);
    res.status(201).json({ success: true, data: order });
  } catch (err) {
    next(err);
  }
};

export const createBulkOrders = async (req, res, next) => {
  try {
    const count = parseInt(req.body.count, 10);
    if (!count || count < 1 || count > 100) {
      res.status(400);
      throw new Error('count must be a number between 1 and 100');
    }
    const orders = await bulkCreateOrders(count);
    orders.forEach(addPendingOrder);
    res.status(201).json({ success: true, created: orders.length, requested: count });
  } catch (err) {
    next(err);
  }
};

export const getAllOrders = async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;

    const orders = await Order.find(filter).sort({ createdAt: -1 });
    res.json({ success: true, data: orders });
  } catch (err) {
    next(err);
  }
};

export const getOrderById = async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) { res.status(404); throw new Error('Order not found'); }
    res.json({ success: true, data: order });
  } catch (err) {
    next(err);
  }
};

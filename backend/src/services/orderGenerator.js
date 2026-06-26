import { latLngToCell, gridDisk } from 'h3-js';
import { H3_RESOLUTION, H3_SERVICE_AREA_K, AUTO_ORDER_INTERVAL_MS } from '../config/constants.js';
import Restaurant from '../models/Restaurant.js';
import Customer from '../models/Customer.js';
import Order from '../models/Order.js';

async function pickPair() {
  const restaurants = await Restaurant.find({ isActive: true });
  if (!restaurants.length) throw new Error('No active restaurants available');

  const shuffled = restaurants.sort(() => Math.random() - 0.5);

  for (const restaurant of shuffled.slice(0, 10)) {
    const restaurantHex = latLngToCell(restaurant.latitude, restaurant.longitude, H3_RESOLUTION);
    const serviceArea = gridDisk(restaurantHex, H3_SERVICE_AREA_K);
    const customers = await Customer.find({ h3Index: { $in: serviceArea }, isActive: true });
    if (!customers.length) continue;
    const customer = customers[Math.floor(Math.random() * customers.length)];
    return { restaurant, customer };
  }

  throw new Error('No customer found within service area of any restaurant after 10 attempts');
}

export async function createOrder() {
  const { restaurant, customer } = await pickPair();

  return Order.create({
    restaurantId:   restaurant._id,
    restaurantName: restaurant.name,
    restaurantLat:  restaurant.latitude,
    restaurantLng:  restaurant.longitude,
    customerId:     customer._id,
    customerName:   customer.name,
    customerLat:    customer.latitude,
    customerLng:    customer.longitude,
    status:         'PENDING',
    queuedAt:       new Date(),
  });
}

export async function bulkCreateOrders(count) {
  const created = [];
  for (let i = 0; i < count; i++) {
    try {
      const order = await createOrder();
      created.push(order);
    } catch {
      // skip — no eligible customer found for this attempt
    }
  }
  return created;
}

let autoOrderTimer = null;

export function startAutoOrderJob() {
  if (autoOrderTimer) return;
  autoOrderTimer = setInterval(() => {
    createOrder().catch(() => {});
  }, AUTO_ORDER_INTERVAL_MS);
}

export function stopAutoOrderJob() {
  if (!autoOrderTimer) return;
  clearInterval(autoOrderTimer);
  autoOrderTimer = null;
}

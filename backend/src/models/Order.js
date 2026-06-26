import mongoose from 'mongoose';

const OrderSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    restaurantName: { type: String, required: true },
    restaurantLat: { type: Number, required: true },
    restaurantLng: { type: Number, required: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    customerName: { type: String, required: true },
    customerLat: { type: Number, required: true },
    customerLng: { type: Number, required: true },
    assignedRiderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Rider', default: null },
    status: { type: String, required: true, enum: ['PENDING', 'ASSIGNED', 'PICKED_UP', 'DELIVERED', 'CANCELLED'], default: 'PENDING' },
    polyline: { type: [{ lat: Number, lng: Number }], default: [] },
    leg1Duration_s: { type: Number },
    leg2Duration_s: { type: Number },
    leg1OriginLat: { type: Number },
    leg1OriginLng: { type: Number },
    leg1Coords: { type: [[Number]], default: [] },
    leg2Coords: { type: [[Number]], default: [] },
    legStartedAt: { type: Date },
    progress: { type: Number, default: 0 },
    queuedAt: { type: Date },
    allocationScore: { type: Number },
    assignedAt:      { type: Date },
    pickedUpAt: { type: Date },
    deliveredAt: { type: Date },
  },
  { timestamps: true }
);

OrderSchema.index({ status: 1, createdAt: 1 });
OrderSchema.index({ assignedRiderId: 1, deliveredAt: 1 });

export default mongoose.model('Order', OrderSchema);

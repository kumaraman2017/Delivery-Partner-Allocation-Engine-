import api from './axios';

// Mock user for local development (when backend isn't available)
const MOCK_USER = {
  _id: '507f1f77bcf86cd799439011',
  email: 'admin@demo.com',
  name: 'Admin User',
  role: 'admin',
};

// Auth — with fallback to mock login for development
export const login = async (body) => {
  try {
    return await api.post('/auth/login', body);
  } catch (error) {
    // Dev fallback: allow mock login with test credentials
    if (import.meta.env.DEV && body.email === 'admin@demo.com' && body.password === 'password') {
      return {
        data: {
          token: 'mock-token-' + Date.now(),
          user: MOCK_USER,
        },
      };
    }
    throw error;
  }
};

export const getMe = async () => {
  try {
    return await api.get('/auth/me');
  } catch (error) {
    // Dev fallback: return mock user if token exists in localStorage
    if (import.meta.env.DEV && localStorage.getItem('token')?.startsWith('mock-token')) {
      return { data: { user: MOCK_USER } };
    }
    throw error;
  }
};

// Mock data for development
const MOCK_RIDERS = [
  {
    _id: '1',
    name: 'Rajesh Kumar',
    phone: '9876543210',
    rating: 4.8,
    availabilityStatus: 'ONLINE',
    status: 'IDLE',
    currentOrderId: null,
    latitude: 23.35,
    longitude: 85.32,
  },
  {
    _id: '2',
    name: 'Priya Singh',
    phone: '9876543211',
    rating: 4.6,
    availabilityStatus: 'ONLINE',
    status: 'ACCEPTED',
    currentOrderId: 'order-1',
    latitude: 23.36,
    longitude: 85.33,
  },
];

const MOCK_RESTAURANTS = [
  {
    _id: 'r1',
    name: 'Sharma Dhaba',
    phone: '8765432100',
    latitude: 23.35,
    longitude: 85.32,
    isActive: true,
  },
  {
    _id: 'r2',
    name: 'Biryani House',
    phone: '8765432101',
    latitude: 23.36,
    longitude: 85.33,
    isActive: true,
  },
];

const MOCK_CUSTOMERS = [
  {
    _id: 'c1',
    name: 'Amit Patel',
    phone: '7654321000',
    address: '123 Main Street, Ranchi',
    latitude: 23.34,
    longitude: 85.31,
    isActive: true,
  },
  {
    _id: 'c2',
    name: 'Neha Gupta',
    phone: '7654321001',
    address: '456 Park Avenue, Ranchi',
    latitude: 23.37,
    longitude: 85.34,
    isActive: true,
  },
];

const MOCK_ORDERS = [
  {
    _id: 'order-1',
    restaurantName: 'Sharma Dhaba',
    customerName: 'Amit Patel',
    status: 'ASSIGNED',
    assignedRiderId: '1',
    createdAt: new Date(Date.now() - 600000).toISOString(),
  },
  {
    _id: 'order-2',
    restaurantName: 'Biryani House',
    customerName: 'Neha Gupta',
    status: 'PENDING',
    assignedRiderId: null,
    createdAt: new Date(Date.now() - 300000).toISOString(),
  },
];

const MOCK_ANALYTICS = {
  totalRiders: 32,
  availableRiders: 24,
  activeOrders: 8,
  completedOrders: 156,
};

// Riders
export const getRiders = async () => {
  try {
    const res = await api.get('/riders');
    return { data: res.data?.data ?? res.data };
  } catch (error) {
    if (import.meta.env.DEV) {
      return { data: MOCK_RIDERS };
    }
    throw error;
  }
};

export const getRider = async (id) => {
  try {
    return await api.get(`/riders/${id}`);
  } catch (error) {
    if (import.meta.env.DEV) {
      const rider = MOCK_RIDERS.find((r) => r._id === id);
      if (rider) return { data: rider };
    }
    throw error;
  }
};

export const updateLocation = (id, body) => api.put(`/riders/${id}/location`, body);
export const updateStatus = (id, body) => api.put(`/riders/${id}/status`, body);

// Restaurants
export const getRestaurants = async () => {
  try {
    const res = await api.get('/restaurants');
    return { data: res.data?.data ?? res.data };
  } catch (error) {
    if (import.meta.env.DEV) {
      return { data: MOCK_RESTAURANTS };
    }
    throw error;
  }
};

export const createRestaurant = async (body) => {
  try {
    return await api.post('/restaurants', body);
  } catch (error) {
    if (import.meta.env.DEV) {
      const newRestaurant = { _id: 'r' + Date.now(), ...body, isActive: true };
      MOCK_RESTAURANTS.push(newRestaurant);
      return { data: newRestaurant };
    }
    throw error;
  }
};

export const deleteRestaurant = async (id) => {
  try {
    return await api.delete(`/restaurants/${id}`);
  } catch (error) {
    if (import.meta.env.DEV) {
      const idx = MOCK_RESTAURANTS.findIndex((r) => r._id === id);
      if (idx >= 0) {
        MOCK_RESTAURANTS[idx].isActive = false;
        return { data: { success: true } };
      }
    }
    throw error;
  }
};

// Customers
export const getCustomers = async () => {
  try {
    const res = await api.get('/customers');
    return { data: res.data?.data ?? res.data };
  } catch (error) {
    if (import.meta.env.DEV) {
      return { data: MOCK_CUSTOMERS };
    }
    throw error;
  }
};

export const createCustomer = async (body) => {
  try {
    return await api.post('/customers', body);
  } catch (error) {
    if (import.meta.env.DEV) {
      const newCustomer = { _id: 'c' + Date.now(), ...body, isActive: true };
      MOCK_CUSTOMERS.push(newCustomer);
      return { data: newCustomer };
    }
    throw error;
  }
};

export const deleteCustomer = async (id) => {
  try {
    return await api.delete(`/customers/${id}`);
  } catch (error) {
    if (import.meta.env.DEV) {
      const idx = MOCK_CUSTOMERS.findIndex((c) => c._id === id);
      if (idx >= 0) {
        MOCK_CUSTOMERS[idx].isActive = false;
        return { data: { success: true } };
      }
    }
    throw error;
  }
};

// Orders
export const getOrders = async (params) => {
  try {
    const res = await api.get('/orders', { params });
    return { data: res.data?.data ?? res.data };
  } catch (error) {
    if (import.meta.env.DEV) {
      return { data: MOCK_ORDERS };
    }
    throw error;
  }
};

export const getOrder = async (id) => {
  try {
    return await api.get(`/orders/${id}`);
  } catch (error) {
    if (import.meta.env.DEV) {
      const order = MOCK_ORDERS.find((o) => o._id === id);
      if (order) return { data: order };
    }
    throw error;
  }
};

export const createOrder = async () => {
  try {
    return await api.post('/orders');
  } catch (error) {
    if (import.meta.env.DEV) {
      const newOrder = {
        _id: 'order-' + Date.now(),
        restaurantName: MOCK_RESTAURANTS[0].name,
        customerName: MOCK_CUSTOMERS[0].name,
        status: 'PENDING',
        assignedRiderId: null,
        createdAt: new Date().toISOString(),
      };
      MOCK_ORDERS.push(newOrder);
      return { data: newOrder };
    }
    throw error;
  }
};

export const bulkOrders = async (count) => {
  try {
    return await api.post('/orders/bulk', { count });
  } catch (error) {
    if (import.meta.env.DEV) {
      const newOrders = [];
      for (let i = 0; i < count; i++) {
        const order = {
          _id: 'order-' + Date.now() + '-' + i,
          restaurantName: MOCK_RESTAURANTS[i % MOCK_RESTAURANTS.length].name,
          customerName: MOCK_CUSTOMERS[i % MOCK_CUSTOMERS.length].name,
          status: 'PENDING',
          assignedRiderId: null,
          createdAt: new Date().toISOString(),
        };
        MOCK_ORDERS.push(order);
        newOrders.push(order);
      }
      return { data: newOrders };
    }
    throw error;
  }
};

export const acceptOrder = (id) => api.put(`/orders/${id}/accept`);

// Allocation
export const allocateOrder = (orderId) => api.post('/allocation/allocate', { orderId });
export const getAllocationHistory = async (params) => {
  try {
    return await api.get('/allocation/history', { params });
  } catch (error) {
    if (import.meta.env.DEV) {
      return { data: { total: 0, page: 1, limit: 20, records: [] } };
    }
    throw error;
  }
};

// Config
export const getWeights = async () => {
  try {
    return await api.get('/config/weights');
  } catch (error) {
    if (import.meta.env.DEV) {
      return { data: { etar: 0.5, rating: 0.3, load: 0.2 } };
    }
    throw error;
  }
};

export const setWeights = (body) => api.put('/config/weights', body);

// Simulation control
export const startSimulation = async () => {
  try {
    return await api.post('/simulation/start');
  } catch (error) {
    if (import.meta.env.DEV) return { data: { success: true, status: { running: true, riderCount: 0, queueDepth: 0 } } };
    throw error;
  }
};

export const stopSimulation = async () => {
  try {
    return await api.post('/simulation/stop');
  } catch (error) {
    if (import.meta.env.DEV) return { data: { success: true, status: { running: false, riderCount: 0, queueDepth: 0 } } };
    throw error;
  }
};

export const getSimulationStatus = async () => {
  try {
    return await api.get('/simulation/status');
  } catch (error) {
    if (import.meta.env.DEV) return { data: { success: true, status: { running: false, riderCount: 0, queueDepth: 0 } } };
    throw error;
  }
};

// Analytics
export const getAnalytics = async () => {
  try {
    return await api.get('/analytics'); // returns flat { totalRiders, availableRiders, ... }
  } catch (error) {
    if (import.meta.env.DEV) {
      return { data: MOCK_ANALYTICS };
    }
    throw error;
  }
};

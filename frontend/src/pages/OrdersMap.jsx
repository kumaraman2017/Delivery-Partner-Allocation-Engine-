import 'mapbox-gl/dist/mapbox-gl.css';
import { useEffect, useState, useMemo, useRef } from 'react';
import { Box } from '@mui/material';
import MapGL, { Source, Layer } from 'react-map-gl';
import PageHeader from '../components/common/PageHeader';
import MapPanel from '../components/common/MapPanel';
import LiveDot from '../components/common/LiveDot';
import { useSimulation } from '../context/SimulationContext';
import { getOrders, getRestaurants } from '../api/endpoints';
import styles from './OrdersMap.module.css';

const MAPBOX_TOKEN  = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN || import.meta.env.VITE_MAPBOX_TOKEN || '';
const RANCHI_CENTER = { longitude: 85.33, latitude: 23.35, zoom: 12 };
const MAP_STYLE     = 'mapbox://styles/mapbox/dark-v11';
const POLL_MS       = 10_000;

const leg1LineLayer = {
  id:   'leg1-routes',
  type: 'line',
  paint: { 'line-color': '#22c55e', 'line-width': 2.5, 'line-opacity': 0.8 },
};

const leg2LineLayer = {
  id:   'leg2-routes',
  type: 'line',
  paint: { 'line-color': '#06b6d4', 'line-width': 2.5, 'line-opacity': 0.8 },
};

const restaurantLayer = {
  id:   'map-restaurants',
  type: 'circle',
  paint: {
    'circle-radius':       4,
    'circle-color':        '#22c55e',
    'circle-stroke-color': '#ffffff',
    'circle-stroke-width': 1,
    'circle-opacity':      0.75,
  },
};

const pendingLayer = {
  id:   'pending-orders',
  type: 'circle',
  paint: {
    'circle-radius':       7,
    'circle-color':        '#888888',
    'circle-stroke-color': '#ffffff',
    'circle-stroke-width': 1.5,
  },
};

const customerLayer = {
  id:   'customer-drops',
  type: 'circle',
  paint: {
    'circle-radius':       6,
    'circle-color':        '#06b6d4',
    'circle-stroke-color': '#ffffff',
    'circle-stroke-width': 1.5,
    'circle-opacity':      0.9,
  },
};

const riderCircleLayer = {
  id:   'riders',
  type: 'circle',
  paint: {
    'circle-radius': 9,
    'circle-color': [
      'match', ['get', 'status'],
      'IDLE',      '#ffffff',
      'ACCEPTED',  '#fb923c',
      'PICKED_UP', '#ea580c',
      '#6b7280',
    ],
    'circle-stroke-color': '#1a1a1a',
    'circle-stroke-width': 0.5,
    'circle-opacity': [
      'match', ['get', 'availabilityStatus'],
      'OFFLINE', 0.35,
      1,
    ],
  },
};

export default function OrdersMap() {
  const mapRef = useRef(null);
  const mapContainerRef = useRef(null);
  const { riders, routes, connected } = useSimulation();
  const [orders, setOrders]           = useState([]);
  const [restaurants, setRestaurants] = useState([]);

  useEffect(() => {
    if (!mapContainerRef.current) return;
    const observer = new ResizeObserver(() => {
      mapRef.current?.resize();
    });
    observer.observe(mapContainerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    getRestaurants()
      .then((r) => setRestaurants(r.data ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const load = () =>
      getOrders()
        .then((r) => setOrders(r.data ?? []))
        .catch(() => {});
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, []);

  const activeOrders = useMemo(
    () => orders.filter((o) => o.status !== 'DELIVERED' && o.status !== 'CANCELLED'),
    [orders]
  );

  const riderByOrder = useMemo(() => {
    const map = new Map();
    for (const r of riders) {
      if (r.orderId) map.set(r.orderId, r);
    }
    return map;
  }, [riders]);

  const pendingOrders = useMemo(
    () => activeOrders.filter((o) => o.status === 'PENDING'),
    [activeOrders]
  );

  const inTransit = useMemo(
    () => activeOrders.filter((o) => o.status === 'ASSIGNED' || o.status === 'PICKED_UP').length,
    [activeOrders]
  );

  // Route lines — active leg only, hard-cut trail from legStepIndex forward
  const leg1Geojson = useMemo(() => {
    const features = [];
    for (const o of activeOrders) {
      if (o.status !== 'ASSIGNED') continue;
      const live    = routes.get(o._id?.toString());
      const full    = live?.leg1Coords ?? o.leg1Coords ?? [];
      const rider   = riderByOrder.get(o._id?.toString());
      const stepIdx = rider?.legStepIndex ?? 0;
      const coords  = full.slice(stepIdx);
      if (coords.length >= 2) {
        features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} });
      }
    }
    return { type: 'FeatureCollection', features };
  }, [activeOrders, routes, riderByOrder]);

  const leg2Geojson = useMemo(() => {
    const features = [];
    for (const o of activeOrders) {
      if (o.status !== 'PICKED_UP') continue;
      const live    = routes.get(o._id?.toString());
      const full    = live?.leg2Coords ?? o.leg2Coords ?? [];
      const rider   = riderByOrder.get(o._id?.toString());
      const stepIdx = rider?.legStepIndex ?? 0;
      const coords  = full.slice(stepIdx);
      if (coords.length >= 2) {
        features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} });
      }
    }
    return { type: 'FeatureCollection', features };
  }, [activeOrders, routes, riderByOrder]);

  const restaurantGeojson = useMemo(() => ({
    type: 'FeatureCollection',
    features: restaurants
      .filter((r) => r.isActive !== false)
      .map((r) => ({
        type:     'Feature',
        geometry: { type: 'Point', coordinates: [r.longitude, r.latitude] },
        properties: {},
      })),
  }), [restaurants]);

  // Gray pins at restaurant location for each pending order
  const pendingGeojson = useMemo(() => ({
    type: 'FeatureCollection',
    features: pendingOrders
      .filter((o) => o.restaurantLng != null && o.restaurantLat != null)
      .map((o) => ({
        type:     'Feature',
        geometry: { type: 'Point', coordinates: [o.restaurantLng, o.restaurantLat] },
        properties: {},
      })),
  }), [pendingOrders]);

  // Cyan pins at customer location for all active (non-pending) orders
  const customerGeojson = useMemo(() => ({
    type: 'FeatureCollection',
    features: activeOrders
      .filter((o) => o.status !== 'PENDING' && o.customerLng != null && o.customerLat != null)
      .map((o) => ({
        type:     'Feature',
        geometry: { type: 'Point', coordinates: [o.customerLng, o.customerLat] },
        properties: {},
      })),
  }), [activeOrders]);

  const riderGeojson = useMemo(() => ({
    type: 'FeatureCollection',
    features: riders.map((r) => ({
      type:     'Feature',
      geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
      properties: {
        status:             r.status,
        availabilityStatus: r.availabilityStatus ?? 'ONLINE',
      },
    })),
  }), [riders]);

  const eyebrow = (
    <span className={styles.liveEyebrow}>
      <LiveDot active={connected} />
      {connected
        ? `Orders — Live · ${pendingOrders.length} pending · ${inTransit} in transit`
        : 'Orders — Waiting for simulation…'}
    </span>
  );

  return (
    <Box className={styles.pageRoot}>
      <PageHeader
        title="Order Map"
        description="Live view of all active orders, pending queue, delivery routes, and rider positions."
      />

      <div className={styles.mapPanelWrap}>
        <MapPanel
          eyebrow={eyebrow}
        legend={[
          { label: 'Idle rider',     color: 'riderIdle'   },
          { label: 'To restaurant',  color: 'warning'     },
          { label: 'Carrying order', color: 'riderPickup' },
          { label: 'Pending order',  color: 'faint'       },
          { label: 'Restaurant',     color: 'restaurant'  },
          { label: 'Customer drop',  color: 'customer'    },
        ]}
        variant="full"
      >
        <div className={styles.mapWrap} ref={mapContainerRef}>
          <MapGL
            ref={mapRef}
            mapboxAccessToken={MAPBOX_TOKEN}
            initialViewState={RANCHI_CENTER}
            mapStyle={MAP_STYLE}
            style={{ width: '100%', height: '100%' }}
          >
            {/* Layer order: bottom → top so riders render above everything */}
            <Source id="leg1-routes" type="geojson" data={leg1Geojson}>
              <Layer {...leg1LineLayer} />
            </Source>
            <Source id="leg2-routes" type="geojson" data={leg2Geojson}>
              <Layer {...leg2LineLayer} />
            </Source>
            <Source id="map-restaurants" type="geojson" data={restaurantGeojson}>
              <Layer {...restaurantLayer} />
            </Source>
            <Source id="pending-orders" type="geojson" data={pendingGeojson}>
              <Layer {...pendingLayer} />
            </Source>
            <Source id="customer-drops" type="geojson" data={customerGeojson}>
              <Layer {...customerLayer} />
            </Source>
            <Source id="riders" type="geojson" data={riderGeojson}>
              <Layer {...riderCircleLayer} />
            </Source>
          </MapGL>
        </div>
      </MapPanel>
      </div>
    </Box>
  );
}

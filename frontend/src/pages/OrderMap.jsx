import 'mapbox-gl/dist/mapbox-gl.css';
import { useEffect, useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { Box, Button } from '@mui/material';
import { RefreshCw } from 'lucide-react';
import Map, { Source, Layer, Marker } from 'react-map-gl';
import PageHeader from '../components/common/PageHeader';
import MapPanel from '../components/common/MapPanel';
import StatusBadge from '../components/common/StatusBadge';
import EmptyState from '../components/common/EmptyState';
import { Skeleton } from '../components/common/Skeleton';
import { getOrder } from '../api/endpoints';
import { useSimulation } from '../context/SimulationContext';
import styles from './OrderMap.module.css';

const MAPBOX_TOKEN   = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
const MAP_STYLE      = 'mapbox://styles/mapbox/dark-v11';
const RANCHI_DEFAULT = { longitude: 85.33, latitude: 23.35, zoom: 13 };

const leg1LineLayer = {
  id:   'order-leg1',
  type: 'line',
  paint: { 'line-color': '#f5a623', 'line-width': 3, 'line-opacity': 0.85 },
};

const leg2LineLayer = {
  id:   'order-leg2',
  type: 'line',
  paint: { 'line-color': '#7928ca', 'line-width': 3, 'line-opacity': 0.85 },
};

export default function OrderMap() {
  const { id } = useParams();
  const [order, setOrder] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const { riders } = useSimulation();

  const fetchOrder = () => {
    setStatus('loading');
    getOrder(id)
      .then((res) => {
        setOrder(res.data?.data ?? res.data);
        setStatus('ready');
      })
      .catch(() => {
        setOrder(null);
        setStatus('error');
      });
  };

  useEffect(fetchOrder, [id]);

  const assignedRider = useMemo(
    () => riders.find((r) => r.orderId === id),
    [riders, id]
  );

  const leg1Geojson = useMemo(() => {
    if (!order || order.status !== 'ASSIGNED') return { type: 'FeatureCollection', features: [] };
    const full    = order.leg1Coords ?? [];
    const stepIdx = assignedRider?.legStepIndex ?? 0;
    const coords  = full.slice(stepIdx);
    return {
      type: 'FeatureCollection',
      features: coords.length >= 2
        ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }]
        : [],
    };
  }, [order, assignedRider]);

  const leg2Geojson = useMemo(() => {
    if (!order) return { type: 'FeatureCollection', features: [] };
    const full    = order.leg2Coords ?? [];
    const stepIdx = order.status === 'PICKED_UP' ? (assignedRider?.legStepIndex ?? 0) : 0;
    const coords  = full.slice(stepIdx);
    return {
      type: 'FeatureCollection',
      features: coords.length >= 2
        ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }]
        : [],
    };
  }, [order, assignedRider]);

  const initialView = order
    ? { longitude: order.restaurantLng, latitude: order.restaurantLat, zoom: 13 }
    : RANCHI_DEFAULT;

  return (
    <Box>
      <PageHeader
        title="Order Map"
        description="Restaurant, customer, and assigned rider for this delivery."
        action={order && <StatusBadge kind="order" status={order.status} />}
      />

      <MapPanel
        eyebrow="Route — Live remaining path"
        legend={[
          { label: 'To restaurant', color: 'warning' },
          { label: 'To customer',   color: 'violet'  },
          { label: 'Rider',         color: 'link'    },
        ]}
        variant="full"
      >
        <div className={styles.mapWrap}>
          {status === 'loading' && <Skeleton shape="block" />}

          {status === 'error' && (
            <EmptyState
              title="Could not load this order"
              description="The backend isn’t reachable yet — this will resolve once it’s live."
              action={
                <Button size="small" variant="outlined" startIcon={<RefreshCw size={14} />} onClick={fetchOrder}>
                  Retry
                </Button>
              }
            />
          )}

          {status === 'ready' && (
            <Map
              mapboxAccessToken={MAPBOX_TOKEN}
              initialViewState={initialView}
              mapStyle={MAP_STYLE}
            >
              <Source id="order-leg1" type="geojson" data={leg1Geojson}>
                <Layer {...leg1LineLayer} />
              </Source>
              <Source id="order-leg2" type="geojson" data={leg2Geojson}>
                <Layer {...leg2LineLayer} />
              </Source>

              {order && (
                <Marker longitude={order.restaurantLng} latitude={order.restaurantLat} anchor="center">
                  <div className={styles.pinRestaurant} />
                </Marker>
              )}

              {order && (
                <Marker longitude={order.customerLng} latitude={order.customerLat} anchor="center">
                  <div className={styles.pinCustomer} />
                </Marker>
              )}

              {assignedRider && (
                <Marker longitude={assignedRider.lng} latitude={assignedRider.lat} anchor="center">
                  <div className={styles.pinRider} />
                </Marker>
              )}
            </Map>
          )}
        </div>
      </MapPanel>
    </Box>
  );
}

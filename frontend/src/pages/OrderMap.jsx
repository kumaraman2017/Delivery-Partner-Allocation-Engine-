import 'mapbox-gl/dist/mapbox-gl.css';
import { useEffect, useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { Box } from '@mui/material';
import Map, { Source, Layer, Marker } from 'react-map-gl';
import PageHeader from '../components/common/PageHeader';
import MapPanel from '../components/common/MapPanel';
import StatusBadge from '../components/common/StatusBadge';
import { getOrder } from '../api/endpoints';
import { useSimulation } from '../context/SimulationContext';
import styles from './OrderMap.module.css';

const MAPBOX_TOKEN   = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
const MAP_STYLE      = 'mapbox://styles/mapbox/dark-v11';
const RANCHI_DEFAULT = { longitude: 85.33, latitude: 23.35, zoom: 13 };

const routeLineLayer = {
  id:   'order-route',
  type: 'line',
  paint: { 'line-color': '#f5a623', 'line-width': 3, 'line-opacity': 0.85 },
};

export default function OrderMap() {
  const { id } = useParams();
  const [order, setOrder] = useState(null);
  const { riders } = useSimulation();

  useEffect(() => {
    getOrder(id)
      .then((res) => setOrder(res.data?.data ?? res.data))
      .catch(() => setOrder(null));
  }, [id]);

  const assignedRider = useMemo(
    () => riders.find((r) => r.orderId === id),
    [riders, id]
  );

  const routeGeojson = useMemo(() => {
    const leg1   = order?.leg1Coords ?? [];
    const leg2   = order?.leg2Coords ?? [];
    const coords = [...leg1, ...leg2];
    return {
      type: 'FeatureCollection',
      features: coords.length >= 2
        ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }]
        : [],
    };
  }, [order]);

  const hasRoute    = (order?.leg1Coords?.length ?? 0) >= 2;
  const initialView = order
    ? { longitude: order.restaurantLng, latitude: order.restaurantLat, zoom: 13 }
    : RANCHI_DEFAULT;

  return (
    <Box>
      <PageHeader
        eyebrow={`Ops — Order ${id}`}
        title="Order Map"
        description="Restaurant, customer, and assigned rider for this delivery."
        action={order && <StatusBadge kind="order" status={order.status} />}
      />

      <MapPanel
        eyebrow="Route — Rider → Restaurant → Customer"
        legend={[
          { label: 'Restaurant', color: 'warning' },
          { label: 'Customer',   color: 'violet'  },
          { label: 'Rider',      color: 'link'    },
        ]}
        variant="full"
      >
        <div className={styles.mapWrap}>
          <Map
            mapboxAccessToken={MAPBOX_TOKEN}
            initialViewState={initialView}
            mapStyle={MAP_STYLE}
          >
            {hasRoute && (
              <Source id="order-route" type="geojson" data={routeGeojson}>
                <Layer {...routeLineLayer} />
              </Source>
            )}

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
        </div>
      </MapPanel>
    </Box>
  );
}

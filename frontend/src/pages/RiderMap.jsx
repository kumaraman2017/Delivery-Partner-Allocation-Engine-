import 'mapbox-gl/dist/mapbox-gl.css';
import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Box } from '@mui/material';
import Map, { Source, Layer, Popup } from 'react-map-gl';
import PageHeader from '../components/common/PageHeader';
import MapPanel from '../components/common/MapPanel';
import LiveDot from '../components/common/LiveDot';
import { useSimulation } from '../context/SimulationContext';
import { getRestaurants } from '../api/endpoints';
import styles from './RiderMap.module.css';

const MAPBOX_TOKEN  = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
const RANCHI_CENTER = { longitude: 85.33, latitude: 23.35, zoom: 13 };
const MAP_STYLE     = 'mapbox://styles/mapbox/dark-v11';

const circleLayer = {
  id:   'unclustered-riders',
  type: 'circle',
  filter: ['!', ['has', 'point_count']],
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
    'circle-stroke-width': [
      'match', ['get', 'status'],
      'IDLE', 1.5,
      0.5,
    ],
    'circle-opacity': [
      'match', ['get', 'availabilityStatus'],
      'OFFLINE', 0.35,
      1,
    ],
  },
};

const pulseLayer = {
  id:     'riders-pulse',
  type:   'circle',
  filter: ['all',
    ['!', ['has', 'point_count']],
    ['match', ['get', 'status'], ['ACCEPTED', 'PICKED_UP'], true, false],
  ],
  paint: {
    'circle-radius':       10,
    'circle-color':        'transparent',
    'circle-stroke-color': [
      'match', ['get', 'status'],
      'ACCEPTED',  '#fb923c',
      'PICKED_UP', '#ea580c',
      '#fb923c',
    ],
    'circle-stroke-width': 2,
    'circle-opacity':      0.6,
  },
};

const clusterCircleLayer = {
  id:     'clusters',
  type:   'circle',
  filter: ['has', 'point_count'],
  paint: {
    'circle-radius': ['step', ['get', 'point_count'], 18, 5, 24, 10, 30],
    'circle-color':  '#fb923c',
    'circle-stroke-color': '#1a1a1a',
    'circle-stroke-width': 1.5,
    'circle-opacity': 0.9,
  },
};

const clusterCountLayer = {
  id:     'cluster-count',
  type:   'symbol',
  filter: ['has', 'point_count'],
  layout: {
    'text-field':  ['get', 'point_count_abbreviated'],
    'text-size':   13,
    'text-font':   ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
  },
  paint: {
    'text-color': '#1a1a1a',
  },
};

const restaurantLayer = {
  id:   'restaurants',
  type: 'circle',
  paint: {
    'circle-radius':       5,
    'circle-color':        '#22c55e',
    'circle-stroke-color': '#ffffff',
    'circle-stroke-width': 1,
    'circle-opacity':      0.85,
  },
};

export default function RiderMap() {
  const { riders, connected, queueDepth } = useSimulation();
  const [restaurants, setRestaurants] = useState([]);
  const [popup, setPopup] = useState(null); // { lng, lat, name, status, orderId }

  const mapRef = useRef(null);

  useEffect(() => {
    getRestaurants()
      .then((r) => setRestaurants(r.data ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;

    let rafId;
    const animate = (ts) => {
      const t = (ts % 1400) / 1400;
      const radius  = 10 + t * 16;
      const opacity = 0.65 * (1 - t);
      if (map.getLayer('riders-pulse')) {
        map.setPaintProperty('riders-pulse', 'circle-radius',  radius);
        map.setPaintProperty('riders-pulse', 'circle-opacity', opacity);
      }
      rafId = requestAnimationFrame(animate);
    };

    const start = () => { rafId = requestAnimationFrame(animate); };

    if (map.isStyleLoaded()) {
      start();
    } else {
      map.once('load', start);
    }

    return () => {
      cancelAnimationFrame(rafId);
      map.off('load', start);
    };
  }, []);

  const handleMapClick = useCallback((e) => {
    const features = e.features ?? [];
    const clusterFeature = features.find((f) => f.layer.id === 'clusters');
    const riderFeature   = features.find((f) => f.layer.id === 'unclustered-riders');

    if (clusterFeature) {
      const map    = mapRef.current?.getMap();
      const source = map?.getSource('riders');
      source?.getClusterExpansionZoom(
        clusterFeature.properties.cluster_id,
        (err, zoom) => {
          if (err) return;
          map.easeTo({ center: clusterFeature.geometry.coordinates, zoom });
        }
      );
      setPopup(null);
      return;
    }

    if (riderFeature) {
      const { name, status, orderId } = riderFeature.properties;
      const [lng, lat] = riderFeature.geometry.coordinates;
      setPopup({ lng, lat, name, status, orderId });
      return;
    }

    setPopup(null);
  }, []);

  const riderGeojson = useMemo(() => ({
    type: 'FeatureCollection',
    features: riders.map((r) => ({
      type:       'Feature',
      geometry:   { type: 'Point', coordinates: [r.lng, r.lat] },
      properties: {
        id:                 r._id,
        name:               r.name,
        status:             r.status,
        availabilityStatus: r.availabilityStatus ?? 'ONLINE',
        orderId:            r.orderId ?? null,
      },
    })),
  }), [riders]);

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

  const stats = useMemo(() => {
    const idle    = riders.filter((r) => r.status === 'IDLE').length;
    const active  = riders.filter((r) => r.status === 'ACCEPTED' || r.status === 'PICKED_UP').length;
    const offline = riders.filter((r) => r.availabilityStatus === 'OFFLINE').length;
    return { idle, active, offline };
  }, [riders]);

  const eyebrow = (
    <span className={styles.liveEyebrow}>
      <LiveDot active={connected} />
      {connected
        ? `Fleet — Live · ${riders.length} riders · Queue: ${queueDepth}`
        : 'Fleet — Waiting for simulation…'}
    </span>
  );

  return (
    <Box>
      <PageHeader
        title="Rider Map"
        description="Live positions of every rider, color-coded by movement state."
      />

      <MapPanel
        eyebrow={eyebrow}
        legend={[
          { label: 'Idle',       color: 'riderIdle'    },
          { label: 'Accepted',   color: 'warning'      },
          { label: 'Picked up',  color: 'riderPickup'  },
          { label: 'Offline',    color: 'faint'        },
          { label: 'Restaurant', color: 'restaurant'   },
        ]}
        variant="full"
      >
        <div className={styles.mapWrap}>
          <div className={styles.statsOverlay}>
            <span className={styles.statItem}>
              <span className={`${styles.statValue} ${styles.statIdle}`}>{stats.idle}</span>
              <span className={styles.statLabel}>Idle</span>
            </span>
            <span className={styles.statDivider} />
            <span className={styles.statItem}>
              <span className={`${styles.statValue} ${styles.statActive}`}>{stats.active}</span>
              <span className={styles.statLabel}>Active</span>
            </span>
            <span className={styles.statDivider} />
            <span className={styles.statItem}>
              <span className={`${styles.statValue} ${styles.statOffline}`}>{stats.offline}</span>
              <span className={styles.statLabel}>Offline</span>
            </span>
            <span className={styles.statDivider} />
            <span className={styles.statItem}>
              <span className={`${styles.statValue} ${styles.statQueue}`}>{queueDepth}</span>
              <span className={styles.statLabel}>Queued Orders</span>
            </span>
          </div>
          <Map
            ref={mapRef}
            mapboxAccessToken={MAPBOX_TOKEN}
            initialViewState={RANCHI_CENTER}
            mapStyle={MAP_STYLE}
            onClick={handleMapClick}
            onZoomEnd={() => setPopup(null)}
            interactiveLayerIds={['unclustered-riders', 'clusters']}
          >
            <Source id="restaurants" type="geojson" data={restaurantGeojson}>
              <Layer {...restaurantLayer} />
            </Source>
            <Source
              id="riders"
              type="geojson"
              data={riderGeojson}
              cluster={true}
              clusterMaxZoom={14}
              clusterRadius={50}
            >
              <Layer {...clusterCircleLayer} />
              <Layer {...clusterCountLayer} />
              <Layer {...pulseLayer} />
              <Layer {...circleLayer} />
            </Source>
            {popup && (
              <Popup
                longitude={popup.lng}
                latitude={popup.lat}
                anchor="bottom"
                onClose={() => setPopup(null)}
                closeOnClick={false}
              >
                <div className={styles.popup}>
                  <div className={styles.popupName}>{popup.name}</div>
                  <span className={`${styles.popupBadge} ${styles[`badge${popup.status}`]}`}>
                    {popup.status}
                  </span>
                  {popup.orderId && (
                    <div className={styles.popupOrder}>
                      Order{' '}
                      <Link to={`/map/orders/${popup.orderId}`} className={styles.popupLink}>
                        #{popup.orderId.slice(-8).toUpperCase()}
                      </Link>
                    </div>
                  )}
                </div>
              </Popup>
            )}
          </Map>
        </div>
      </MapPanel>
    </Box>
  );
}

import 'mapbox-gl/dist/mapbox-gl.css';
import { useMemo } from 'react';
import { Box } from '@mui/material';
import Map, { Source, Layer } from 'react-map-gl';
import PageHeader from '../components/common/PageHeader';
import MapPanel from '../components/common/MapPanel';
import { useSimulation } from '../context/SimulationContext';
import styles from './RiderMap.module.css';

const MAPBOX_TOKEN  = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
const RANCHI_CENTER = { longitude: 85.33, latitude: 23.35, zoom: 13 };
const MAP_STYLE     = 'mapbox://styles/mapbox/dark-v11';

const circleLayer = {
  id:   'riders',
  type: 'circle',
  paint: {
    'circle-radius': 8,
    'circle-color': [
      'match', ['get', 'status'],
      'IDLE',      '#0070f3',
      'ACCEPTED',  '#f5a623',
      'PICKED_UP', '#7928ca',
      /* default */ '#a1a1a1',
    ],
    'circle-stroke-color': '#ffffff',
    'circle-stroke-width': 1.5,
    'circle-opacity': [
      'match', ['get', 'availabilityStatus'],
      'OFFLINE', 0.35,
      /* default */ 1,
    ],
  },
};

const routeLineLayer = {
  id:   'routes',
  type: 'line',
  paint: {
    'line-color':   '#f5a623',
    'line-width':   2,
    'line-opacity': 0.65,
  },
};

export default function RiderMap() {
  const { riders, connected, queueDepth, routes } = useSimulation();

  const riderGeojson = useMemo(() => ({
    type: 'FeatureCollection',
    features: riders.map((r) => ({
      type:       'Feature',
      geometry:   { type: 'Point', coordinates: [r.lng, r.lat] },
      properties: { id: r._id, status: r.status, availabilityStatus: r.availabilityStatus },
    })),
  }), [riders]);

  const routeGeojson = useMemo(() => ({
    type: 'FeatureCollection',
    features: Array.from(routes.values()).map(({ leg1Coords, leg2Coords }) => ({
      type:     'Feature',
      geometry: { type: 'LineString', coordinates: [...leg1Coords, ...leg2Coords] },
      properties: {},
    })),
  }), [routes]);

  const eyebrow = connected
    ? `Fleet — Live · ${riders.length} riders · Queue: ${queueDepth}`
    : 'Fleet — Waiting for simulation…';

  return (
    <Box>
      <PageHeader
        eyebrow="Ops — Fleet"
        title="Rider Map"
        description="Live positions of every rider, color-coded by movement state."
      />

      <MapPanel
        eyebrow={eyebrow}
        legend={[
          { label: 'Idle',      color: 'link' },
          { label: 'Accepted',  color: 'warning' },
          { label: 'Picked up', color: 'violet' },
          { label: 'Offline',   color: 'faint' },
        ]}
        variant="full"
      >
        <div className={styles.mapWrap}>
          <Map
            mapboxAccessToken={MAPBOX_TOKEN}
            initialViewState={RANCHI_CENTER}
            mapStyle={MAP_STYLE}
          >
            <Source id="routes" type="geojson" data={routeGeojson}>
              <Layer {...routeLineLayer} />
            </Source>
            <Source id="riders" type="geojson" data={riderGeojson}>
              <Layer {...circleLayer} />
            </Source>
          </Map>
        </div>
      </MapPanel>
    </Box>
  );
}

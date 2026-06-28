import 'mapbox-gl/dist/mapbox-gl.css';
import { useEffect, useMemo, useState } from 'react';
import { Box, Card, Typography } from '@mui/material';
import { Activity } from 'lucide-react';
import Map, { Source, Layer } from 'react-map-gl';
import StatCard from '../components/common/StatCard';
import MapPanel from '../components/common/MapPanel';
import EmptyState from '../components/common/EmptyState';
import LiveDot from '../components/common/LiveDot';
import ProgressRing from '../components/common/ProgressRing';
import { getAnalytics } from '../api/endpoints';
import { useSimulation } from '../context/SimulationContext';
import styles from './Dashboard.module.css';

const MAPBOX_TOKEN  = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
const RANCHI_CENTER = { longitude: 85.33, latitude: 23.35, zoom: 12 };
const MAP_STYLE     = 'mapbox://styles/mapbox/dark-v11';

const circleLayer = {
  id:   'riders-mini',
  type: 'circle',
  paint: {
    'circle-radius': 5,
    'circle-color': [
      'match', ['get', 'status'],
      'IDLE',      '#0070f3',
      'ACCEPTED',  '#f5a623',
      'PICKED_UP', '#7928ca',
      '#a1a1a1',
    ],
    'circle-stroke-color': '#ffffff',
    'circle-stroke-width': 1,
    'circle-opacity': [
      'match', ['get', 'availabilityStatus'],
      'OFFLINE', 0.3,
      1,
    ],
  },
};

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

export default function Dashboard() {
  const [analytics, setAnalytics] = useState(null);
  const [analyticsStatus, setAnalyticsStatus] = useState('loading'); // loading | ready | error
  const { riders, connected, queueDepth, allocations } = useSimulation();

  useEffect(() => {
    const load = () =>
      getAnalytics()
        .then((res) => { setAnalytics(res.data); setAnalyticsStatus('ready'); })
        .catch(() => { setAnalytics(null); setAnalyticsStatus('error'); });
    load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, []);

  const geojson = useMemo(() => ({
    type: 'FeatureCollection',
    features: riders.map((r) => ({
      type:       'Feature',
      geometry:   { type: 'Point', coordinates: [r.lng, r.lat] },
      properties: { status: r.status, availabilityStatus: r.availabilityStatus },
    })),
  }), [riders]);

  // undefined → StatCard renders a skeleton (still loading); null → StatCard renders '—' (loaded/errored, no value)
  const statValue = (key) => (analyticsStatus === 'loading' ? undefined : analytics?.[key] ?? null);

  const stats = [
    { label: 'Total riders',     value: statValue('totalRiders') },
    { label: 'Active orders',    value: statValue('activeOrders') },
    { label: 'Completed orders', value: statValue('completedOrders') },
  ];

  const totalRiders     = analytics?.totalRiders ?? 0;
  const availableRiders = analytics?.availableRiders ?? 0;
  const availablePercent = totalRiders > 0 ? Math.round((availableRiders / totalRiders) * 100) : 0;

  return (
    <Box>
      <Box className={styles.hero}>
        <div className={styles.heroGlow} aria-hidden="true" />
        <svg className={styles.heroBg} viewBox="0 0 800 220" preserveAspectRatio="none" aria-hidden="true">
          <path id="route-1" className={styles.route} data-variant="link" d="M -20,160 C 120,40 280,220 440,90 S 680,30 860,110" />
          <path id="route-2" className={styles.route} data-variant="violet" d="M -20,50 C 160,190 320,20 480,150 S 700,60 860,190" />
          <path id="route-3" className={styles.route} data-variant="info" d="M -20,110 C 200,10 360,200 520,70 S 760,150 860,40" />

          <circle className={styles.routeDot} data-variant="link" r="3.5">
            <animateMotion dur="9s" repeatCount="indefinite">
              <mpath href="#route-1" />
            </animateMotion>
          </circle>
          <circle className={styles.routeDot} data-variant="violet" r="3.5">
            <animateMotion dur="12s" repeatCount="indefinite" begin="1s">
              <mpath href="#route-2" />
            </animateMotion>
          </circle>
          <circle className={styles.routeDot} data-variant="info" r="3.5">
            <animateMotion dur="10.5s" repeatCount="indefinite" begin="2s">
              <mpath href="#route-3" />
            </animateMotion>
          </circle>
        </svg>

        <Box className={styles.heroContent}>
          <Typography variant="h1" className={styles.heroTitle}>Live Delivery Intelligence</Typography>
          <Typography className={styles.heroSubtitle}>AI-Powered Delivery Intelligence</Typography>
        </Box>

        <Box className={styles.heroStats}>
          {stats.map((s) => <StatCard key={s.label} label={s.label} value={s.value} />)}
          <Box className={styles.heroRing}>
            <ProgressRing
              percent={availablePercent}
              label={analyticsStatus === 'loading' ? '—' : availableRiders}
              sublabel="Available"
              color="success"
            />
          </Box>
        </Box>
      </Box>

      <Box className={styles.lowerGrid}>
        <MapPanel
          eyebrow={
            <span className={styles.liveEyebrow}>
              <LiveDot active={connected} />
              {connected ? `Fleet — Live · Queue: ${queueDepth}` : 'Fleet — Waiting for simulation…'}
            </span>
          }
          legend={[
            { label: 'Idle',      color: 'link' },
            { label: 'Accepted',  color: 'warning' },
            { label: 'Picked up', color: 'violet' },
            { label: 'Offline',   color: 'faint' },
          ]}
          variant="compact"
        >
          <div className={styles.miniMapWrap}>
            <Map
              mapboxAccessToken={MAPBOX_TOKEN}
              initialViewState={RANCHI_CENTER}
              mapStyle={MAP_STYLE}
            >
              <Source id="riders-mini" type="geojson" data={geojson}>
                <Layer {...circleLayer} />
              </Source>
            </Map>
          </div>
        </MapPanel>

        <Card elevation={0} className={styles.activityCard}>
          <div className={styles.activityTitle}>Recent allocations</div>

          {allocations.length === 0 ? (
            <EmptyState
              icon={Activity}
              title="No recent allocations"
              description="No recent allocations yet. They will appear here in real time."
            />
          ) : (
            <div className={styles.allocationFeed}>
              {allocations.slice(0, 8).map((a) => (
                <div key={a.orderId + a.ts} className={`${styles.allocationItem} ${styles.flashIn}`}>
                  <div>
                    <div className={styles.allocationRider}>
                      Rider {String(a.riderId).slice(-6)}
                    </div>
                    <div className={styles.allocationMeta}>
                      Order {String(a.orderId).slice(-6)}
                    </div>
                  </div>
                  <div className={styles.allocationRight}>
                    <div className={styles.allocationScore}>
                      {(a.score * 100).toFixed(0)}%
                    </div>
                    <div className={styles.allocationMeta}>{timeAgo(a.ts)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </Box>
    </Box>
  );
}

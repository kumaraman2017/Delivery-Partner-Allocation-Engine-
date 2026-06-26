import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Button, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, TextField } from '@mui/material';
import PageHeader from '../components/common/PageHeader';
import StatusBadge from '../components/common/StatusBadge';
import EmptyState from '../components/common/EmptyState';
import { getOrders, createOrder, bulkOrders } from '../api/endpoints';
import styles from './Orders.module.css';

export default function Orders() {
  const navigate = useNavigate();
  const [orders, setOrders] = useState([]);
  const [status, setStatus] = useState('loading');
  const [bulkCount, setBulkCount] = useState(5);

  const fetchOrders = () => {
    setStatus('loading');
    getOrders()
      .then((res) => {
        setOrders(res.data ?? []);
        setStatus('ready');
      })
      .catch(() => setStatus('error'));
  };

  useEffect(fetchOrders, []);

  const handleCreate = async () => {
    await createOrder();
    fetchOrders();
  };

  const handleBulkCreate = async () => {
    await bulkOrders(Number(bulkCount));
    fetchOrders();
  };

  return (
    <Box>
      <PageHeader
        eyebrow="Ops — Orders"
        title="Orders"
        description="Pending, assigned, and completed delivery assignments."
        action={
          <Box className={styles.actions}>
            <TextField
              size="small"
              type="number"
              value={bulkCount}
              onChange={(e) => setBulkCount(e.target.value)}
              className={styles.bulkCount}
              aria-label="Bulk order count"
            />
            <Button variant="outlined" onClick={handleBulkCreate}>Bulk create</Button>
            <Button variant="contained" onClick={handleCreate}>Create order</Button>
          </Box>
        }
      />

      <TableContainer component={Paper} elevation={0}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Restaurant</TableCell>
              <TableCell>Customer</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Assigned rider</TableCell>
              <TableCell>Created at</TableCell>
              <TableCell />
            </TableRow>
          </TableHead>
          <TableBody>
            {status !== 'ready' || orders.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className={styles.emptyCell}>
                  <EmptyState
                    title={status === 'error' ? 'Could not load orders' : 'No orders yet'}
                    description={
                      status === 'error'
                        ? 'The backend is not reachable yet.'
                        : 'Orders created here will appear once the backend is running.'
                    }
                  />
                </TableCell>
              </TableRow>
            ) : (
              orders.map((o) => (
                <TableRow key={o._id}>
                  <TableCell>{o.restaurantName}</TableCell>
                  <TableCell>{o.customerName}</TableCell>
                  <TableCell><StatusBadge kind="order" status={o.status} /></TableCell>
                  <TableCell>{o.assignedRiderId ?? '—'}</TableCell>
                  <TableCell>{o.createdAt ? new Date(o.createdAt).toLocaleString() : '—'}</TableCell>
                  <TableCell>
                    <Button size="small" onClick={() => navigate(`/map/orders/${o._id}`)}>Map</Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}

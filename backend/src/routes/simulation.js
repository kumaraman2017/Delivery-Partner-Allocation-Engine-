import express from 'express';
import { startSimulation, stopSimulation, getStatus } from '../services/simulationEngine.js';

const router = express.Router();

router.post('/start', async (req, res, next) => {
  try {
    await startSimulation();
    res.json({ success: true, status: getStatus() });
  } catch (err) {
    next(err);
  }
});

router.post('/stop', (req, res) => {
  stopSimulation();
  res.json({ success: true, status: getStatus() });
});

router.get('/status', (req, res) => {
  res.json({ success: true, status: getStatus() });
});

export default router;

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

router.post('/stop', async (req, res, next) => {
  try {
    await stopSimulation();
    res.json({ success: true, status: getStatus() });
  } catch (err) {
    next(err);
  }
});

router.get('/status', (req, res) => {
  res.json({ success: true, status: getStatus() });
});

export default router;

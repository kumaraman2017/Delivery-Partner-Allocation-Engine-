import { createServer } from 'http';
import { Server } from 'socket.io';
import app from './app.js';
import connectDB from './config/db.js';
import { config } from './config/env.js';
import { initSimulation, startSimulation } from './services/simulationEngine.js';

await connectDB();

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

initSimulation(io);

io.on('connection', (socket) => {
  console.log('[ws] client connected:', socket.id);
  socket.on('disconnect', () => console.log('[ws] client disconnected:', socket.id));
});

const PORT = config.port;

httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startSimulation().catch(console.error);
});

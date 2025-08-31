const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
require('dotenv').config();

const { setupDatabase } = require('./config/database');
const { setupRedis } = require('./config/redis');
const logger = require('./utils/logger');

// Import route handlers
const aggregatorRoutes = require('./aggregators/routes');
const arbitrageRoutes = require('./arbitrage/routes');
const dashboardRoutes = require('./dashboard/routes');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "http://localhost:3001",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Routes
app.use('/api/aggregators', aggregatorRoutes);
app.use('/api/arbitrage', arbitrageRoutes);
app.use('/api/dashboard', dashboardRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV 
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  logger.info(`Client connected: ${socket.id}`);
  
  socket.on('subscribe_arbitrage', () => {
    socket.join('arbitrage_updates');
    logger.info(`Client ${socket.id} subscribed to arbitrage updates`);
  });
  
  socket.on('subscribe_prices', () => {
    socket.join('price_updates');
    logger.info(`Client ${socket.id} subscribed to price updates`);
  });
  
  socket.on('disconnect', () => {
    logger.info(`Client disconnected: ${socket.id}`);
  });
});

// Initialize services
async function initialize() {
  try {
    // Setup database connection
    await setupDatabase();
    logger.info('Database initialized');
    
    // Setup Redis connection
    await setupRedis();
    logger.info('Redis initialized');
    
    // Start the server
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      logger.info(`DeFi Arbitrage Dashboard server running on port ${PORT}`);
      logger.info(`Environment: ${process.env.NODE_ENV}`);
    });
    
    // Start background services
    require('./services/priceMonitor').start(io);
    require('./services/arbitrageScanner').start(io);
    
  } catch (error) {
    logger.error('Failed to initialize application:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => {
    logger.info('Process terminated');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  server.close(() => {
    logger.info('Process terminated');
    process.exit(0);
  });
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start the application
initialize();
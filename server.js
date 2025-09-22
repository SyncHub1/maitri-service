import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { Server } from 'socket.io';
import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

// Load environment variables
dotenv.config();

// ES Module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import configurations and middleware
import { connectDB } from './config/database.js';
import { initializeRedis } from './config/redis.js';
import { setupSocketIO } from './config/socket.js';
import { logger } from './config/logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { authMiddleware } from './middleware/auth.js';

// Import routes
import teamRoutes from './routes/teamRoutes.js';
import collaborationRoutes from './routes/collaborationRoutes.js';
import chatRoutes from './routes/chatRoutes.js';
import taskRoutes from './routes/taskRoutes.js';
import analyticsRoutes from './routes/analyticsRoutes.js';
import invitationRoutes from './routes/invitationRoutes.js';
import whiteboardRoutes from './routes/whiteboardRoutes.js';
import ideRoutes from './routes/ideRoutes.js';
import videoRoutes from './routes/videoRoutes.js';

const app = express();
const PORT = process.env.PORT || 3003;

// Create HTTP server and Socket.IO instance
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: [
      process.env.FRONTEND_URL || 'http://localhost:5173',
      process.env.MATRI_FRONTEND_URL || 'http://localhost:5175',
      'http://localhost:3000',
      'http://localhost:5173',
      'http://localhost:5175',
      'https://www.synchubb.in',
      'https://synchubb-matri-frontend.vercel.app'
    ],
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

// Create logs directory if it doesn't exist
const logsDir = join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100, // limit each IP to 100 requests per windowMs
  message: {
    error: 'Too many requests from this IP, please try again later.',
    code: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Security middleware
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "ws:", "wss:"]
    }
  }
}));

app.use(compression());
app.use(limiter);

// CORS configuration
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:5173',
    process.env.MATRI_FRONTEND_URL || 'http://localhost:5175',
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:5175',
    'https://www.synchubb.in',
    'https://synchubb-matri-frontend.vercel.app'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Cookie']
}));

// Logging middleware
app.use(morgan('combined', {
  stream: {
    write: (message) => logger.info(message.trim())
  }
}));

// Body parsing middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'matri-service',
    version: process.env.API_VERSION || 'v1',
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// API routes with versioning
const apiVersion = process.env.API_VERSION || 'v1';
app.use(`/api/${apiVersion}/teams`, teamRoutes);
app.use(`/api/${apiVersion}/collaboration`, collaborationRoutes);
app.use(`/api/${apiVersion}/chat`, chatRoutes);
app.use(`/api/${apiVersion}/tasks`, taskRoutes);
app.use(`/api/${apiVersion}/analytics`, analyticsRoutes);
app.use(`/api/${apiVersion}/invitations`, invitationRoutes);
app.use(`/api/${apiVersion}/whiteboard`, whiteboardRoutes);
app.use(`/api/${apiVersion}/ide`, ideRoutes);
app.use(`/api/${apiVersion}/video`, videoRoutes);

// Legacy routes for backward compatibility
app.use('/api/teams', teamRoutes);
app.use('/api/collaboration', collaborationRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/invitations', invitationRoutes);
app.use('/api/whiteboard', whiteboardRoutes);
app.use('/api/ide', ideRoutes);
app.use('/api/video', videoRoutes);

// Error handling middleware
app.use(notFoundHandler);
app.use(errorHandler);

// Initialize services and start server
const startServer = async () => {
  try {
    logger.info('🚀 Starting Matri Service...');
    logger.info(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
    logger.info(`🔌 Port: ${PORT}`);

    // Initialize database connection
    try {
      await connectDB();
      logger.info('✅ Database connected successfully');
    } catch (dbError) {
      logger.error('❌ Database connection failed:', dbError.message);
      if (process.env.NODE_ENV === 'production') {
        throw dbError;
      }
      logger.warn('⚠️ Continuing without database in development mode');
    }

    // Initialize Redis connection
    try {
      await initializeRedis();
      logger.info('✅ Redis connected successfully');
    } catch (redisError) {
      // Redis initialization handles its own logging and fallback
      // No need to log additional errors here
      if (process.env.NODE_ENV === 'production') {
        throw redisError;
      }
    }

    // Setup Socket.IO
    setupSocketIO(io);
    logger.info('✅ Socket.IO configured successfully');

    // Start server
    server.listen(PORT, '0.0.0.0', () => {
      logger.info(`🚀 Matri Service running on port ${PORT}`);
      logger.info(`📊 Health check: http://localhost:${PORT}/health`);
      logger.info(`🔌 API endpoint: http://localhost:${PORT}/api/${apiVersion}`);
      logger.info(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    });

    // Handle server errors
    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        logger.error(`❌ Port ${PORT} is already in use`);
      } else {
        logger.error('❌ Server error:', error);
      }
      process.exit(1);
    });

  } catch (error) {
    logger.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

// Graceful shutdown
const gracefulShutdown = async (signal) => {
  logger.info(`🛑 ${signal} received, shutting down Matri service gracefully...`);
  
  try {
    // Close server
    server.close(() => {
      logger.info('✅ HTTP server closed');
    });

    // Close database connection
    await mongoose.connection.close();
    logger.info('✅ Database connection closed');

    // Close Redis connection (if initialized)
    // Redis cleanup will be handled by shared-utils

    logger.info('✅ Matri service shut down successfully');
    process.exit(0);
  } catch (error) {
    logger.error('❌ Error during shutdown:', error);
    process.exit(1);
  }
};

// Handle process signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Start the server
startServer();

export { app, io };

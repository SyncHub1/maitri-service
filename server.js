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
import { initializeRedis, closeRedis } from './config/redis.js';
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
      'http://localhost:5173',
      'http://localhost:5175',
      'http://localhost:8080',
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
  contentSecurityPolicy: {
      directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'", "https://www.synchubb.in", process.env.MATRI_FRONTEND_URL],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          mediaSrc: ["'self'"],
          frameSrc: ["'self'", "https://www.synchubb.in"]
      }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginOpenerPolicy: { policy: "same-origin" }
}));


// CORS configuration with explicit header setting
app.use(cors({
  origin: function (origin, callback) {
    console.log('🔍 CORS Check - Request Origin:', origin);
    
    const allowedOrigins = [
      'http://localhost:5173',
      'http://localhost:5175',
      'http://localhost:8080',
      'https://www.synchubb.in',
      'https://synchubb-matri-frontend.vercel.app'
    ];
    
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) {
      console.log('✅ CORS: Allowing request with no origin');
      return callback(null, true);
    }
    
    // Check if origin is in allowed list
    if (allowedOrigins.includes(origin)) {
      console.log('✅ CORS: Origin allowed:', origin);
      return callback(null, true);
    }
    
    // In development, allow all origins
    console.log('⚠️ CORS: Origin not in whitelist but allowing in development:', origin);
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'Cookie',
    'X-Requested-With',
    'Accept',
    'Origin',
    'Cache-Control',
    'Pragma'
  ],
  exposedHeaders: ['Content-Length', 'Date', 'X-API-Version'],
  preflightContinue: false,
  optionsSuccessStatus: 200
}));

// Additional middleware to ensure CORS headers are always present
app.use((req, res, next) => {
  const origin = req.get('Origin');
  
  console.log('🔧 Setting CORS headers for:', req.method, req.url, 'from origin:', origin);
  
  // Always set Access-Control-Allow-Origin
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    res.header('Access-Control-Allow-Origin', 'http://localhost:5175');
  }
  
  // Set other CORS headers
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS,HEAD');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,Cookie,X-Requested-With,Accept,Origin,Cache-Control,Pragma');
  res.header('Access-Control-Max-Age', '86400');
  
  // Handle preflight OPTIONS requests
  if (req.method === 'OPTIONS') {
    console.log('🔄 Handling preflight OPTIONS request for:', req.url);
    return res.status(200).end();
  }
  
  next();
});


app.use(compression());
app.use(limiter);

// Logging middleware
app.use(morgan('combined', {
  stream: {
    write: (message) => logger.info(message.trim())
  }
}));

// Body parsing middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));




// Request logging middleware
app.use((req, res, next) => {
  console.log(`📥 ${req.method} ${req.url} from ${req.get('Origin') || 'unknown'}`);
  next();
});

// Health check endpoint with CORS debugging
app.get('/health', (req, res) => {
  const origin = req.get('Origin');
  console.log('🌡️ Health check requested from origin:', origin);
  console.log('🔧 Current response headers before sending:');
  console.log('  Access-Control-Allow-Origin:', res.get('Access-Control-Allow-Origin'));
  console.log('  Access-Control-Allow-Credentials:', res.get('Access-Control-Allow-Credentials'));
  
  const healthData = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'matri-service',
    version: process.env.API_VERSION || 'v1',
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    port: process.env.PORT || 3003,
    cors: {
      requestOrigin: origin,
      responseHeaders: {
        'access-control-allow-origin': res.get('Access-Control-Allow-Origin'),
        'access-control-allow-credentials': res.get('Access-Control-Allow-Credentials'),
        'access-control-allow-methods': res.get('Access-Control-Allow-Methods')
      }
    }
  };
  
  console.log('✅ Health check response data:', healthData);
  res.json(healthData);
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

    // Initialize Redis connection with better error handling
    try {
      logger.info('🔄 Attempting to connect to Redis...');
      await initializeRedis();
      logger.info('✅ Redis connected successfully');
    } catch (redisError) {
      logger.warn('⚠️ Redis connection failed, using mock Redis for development');
      logger.info('🛠️ Service will continue with limited caching capabilities');
      
      // In production, we might want to fail if Redis is required
      if (process.env.NODE_ENV === 'production' && process.env.REQUIRE_REDIS === 'true') {
        logger.error('❌ Redis is required in production but not available');
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

// Handle unhandled promise rejections and uncaught exceptions
process.on('unhandledRejection', (reason, promise) => {
  logger.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit the process in development for Redis connection issues
  if (reason && reason.code === 'ECONNREFUSED' && reason.address === '127.0.0.1') {
    logger.warn('⚠️ Redis connection refused - continuing with mock Redis');
    return;
  }
});

process.on('uncaughtException', (error) => {
  logger.error('❌ Uncaught Exception:', error);
  // Don't exit for Redis connection issues
  if (error.code === 'ECONNREFUSED' && error.address === '127.0.0.1') {
    logger.warn('⚠️ Redis connection refused - continuing with mock Redis');
    return;
  }
  process.exit(1);
});

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
    try {
      await closeRedis();
    } catch (redisCloseError) {
      logger.warn('⚠️ Redis cleanup failed:', redisCloseError.message);
    }

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

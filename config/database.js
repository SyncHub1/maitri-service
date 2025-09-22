import mongoose from 'mongoose';
import { logger } from './logger.js';

// MongoDB connection configuration
const connectDB = async () => {
  try {
    const mongoURI = process.env.NODE_ENV === 'test' 
      ? process.env.MONGODB_TEST_URI 
      : process.env.MONGODB_URI;

    if (!mongoURI) {
      logger.warn('⚠️ MongoDB URI is not defined in environment variables');
      if (process.env.NODE_ENV === 'development') {
        logger.info('🔄 Using default local MongoDB URI for development');
        const defaultURI = 'mongodb://localhost:27017/matri-service';
        return await connectWithFallback(defaultURI);
      }
      throw new Error('MongoDB URI is required for production');
    }

    return await connectWithFallback(mongoURI);
  } catch (error) {
    logger.error('❌ Database connection failed:', error.message);
    
    if (process.env.NODE_ENV === 'development') {
      logger.warn('🔄 Continuing without database in development mode');
      return createMockConnection();
    }
    
    throw error;
  }
};

// Helper function to connect with fallback
const connectWithFallback = async (mongoURI) => {
  try {
    logger.info('🔄 Attempting to connect to MongoDB...');
    logger.info(`📍 URI: ${mongoURI.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}`);

    const options = {
      // Connection options
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000, // Reduced timeout for faster failure
      socketTimeoutMS: 45000,
      bufferMaxEntries: 0,
      bufferCommands: false,
      
      // Replica set options
      retryWrites: true,
      w: 'majority',
      
      // Authentication (only if credentials are provided)
      ...(mongoURI?.includes('@') && { authSource: 'admin' }),
      
      // SSL/TLS (only for production/cloud)
      ...(process.env.NODE_ENV === 'production' || mongoURI?.includes('mongodb+srv') ? {
        ssl: true,
        sslValidate: true,
      } : {}),
    };

    // Connect to MongoDB with timeout
    const conn = await Promise.race([
      mongoose.connect(mongoURI, options),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('MongoDB connection timeout')), 8000)
      )
    ]);

    logger.info(`✅ MongoDB Connected: ${conn.connection.host}`);
    logger.info(`📊 Database: ${conn.connection.name}`);

    // Setup connection event listeners
    setupConnectionListeners();

    return conn;
  } catch (error) {
    logger.error(`❌ MongoDB connection failed: ${error.message}`);
    throw error;
  }
};

// Setup connection event listeners
const setupConnectionListeners = () => {
  mongoose.connection.on('connected', () => {
    logger.info('🔗 Mongoose connected to MongoDB');
  });

  mongoose.connection.on('error', (err) => {
    logger.error('❌ Mongoose connection error:', err.message);
  });

  mongoose.connection.on('disconnected', () => {
    logger.warn('⚠️ Mongoose disconnected from MongoDB');
  });

  // Handle application termination
  process.on('SIGINT', async () => {
    try {
      await mongoose.connection.close();
      logger.info('🛑 Mongoose connection closed through app termination');
    } catch (error) {
      logger.error('❌ Error closing mongoose connection:', error.message);
    }
    process.exit(0);
  });
};

// Create mock connection for development
const createMockConnection = () => {
  logger.info('🔄 Creating mock database connection for development');
  
  // Create a mock connection object
  const mockConnection = {
    connection: {
      host: 'localhost (mock)',
      name: 'matri-service-mock',
      readyState: 1 // Connected state
    }
  };
  
  // Override mongoose connection methods to prevent errors
  if (!mongoose.connection.readyState) {
    mongoose.connection.readyState = 1;
  }
  
  logger.info('✅ Mock database connection created');
  return mockConnection;
};

// Database health check
const checkDBHealth = async () => {
  try {
    const state = mongoose.connection.readyState;
    const states = {
      0: 'disconnected',
      1: 'connected',
      2: 'connecting',
      3: 'disconnecting'
    };

    return {
      status: states[state] || 'unknown',
      connected: state === 1,
      host: mongoose.connection.host,
      name: mongoose.connection.name,
      collections: Object.keys(mongoose.connection.collections).length
    };
  } catch (error) {
    logger.error('❌ Database health check failed:', error);
    return {
      status: 'error',
      connected: false,
      error: error.message
    };
  }
};

// Close database connection
const closeDB = async () => {
  try {
    await mongoose.connection.close();
    logger.info('✅ Database connection closed successfully');
  } catch (error) {
    logger.error('❌ Error closing database connection:', error);
    throw error;
  }
};

export { connectDB, checkDBHealth, closeDB, connectWithFallback, createMockConnection };

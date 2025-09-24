import Redis from 'ioredis';
import { logger } from './logger.js';

let redisClient = null;
let redisSubscriber = null;
let redisPublisher = null;

// Redis connection configuration
const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  retryDelayOnFailover: 100,
  maxRetriesPerRequest: 3,
  lazyConnect: false, // Connect immediately
  keepAlive: 30000,
  connectTimeout: 10000,
  commandTimeout: 5000,
  db: 0, // Use database 0 for Matri service
  family: 4, // Force IPv4
};

// Initialize Redis connections
const initializeRedis = async () => {
  try {
    logger.info('🔄 Initializing Redis connections...');
    
    // First, test if Redis is available with a simple connection test
    const testClient = new Redis({
      ...redisConfig,
      retryDelayOnFailover: 0,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      lazyConnect: true,
      enableOfflineQueue: false,
      enableReadyCheck: false,
      maxRetriesPerRequest: null
    });
    
    // Test connection with timeout
    try {
      await Promise.race([
        testClient.ping(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Redis connection timeout')), 2000)
        )
      ]);
      
      // If we get here, Redis is available
      await testClient.quit();
      logger.info('✅ Redis server is available, creating connections...');
      
    } catch (testError) {
      await testClient.disconnect();
      throw testError;
    }
    
    // Main Redis client for general operations
    redisClient = new Redis({
      ...redisConfig,
      retryDelayOnFailover: 100,
      maxRetriesPerRequest: 3,
      connectTimeout: 5000,
      lazyConnect: false,
      enableOfflineQueue: false
    });
    
    // Separate clients for pub/sub to avoid blocking
    redisSubscriber = new Redis({
      ...redisConfig,
      retryDelayOnFailover: 100,
      maxRetriesPerRequest: 3,
      connectTimeout: 5000,
      lazyConnect: false,
      enableOfflineQueue: false
    });
    
    redisPublisher = new Redis({
      ...redisConfig,
      retryDelayOnFailover: 100,
      maxRetriesPerRequest: 3,
      connectTimeout: 5000,
      lazyConnect: false,
      enableOfflineQueue: false
    });

    // Wait for all connections to be ready
    await Promise.all([
      new Promise((resolve) => redisClient.on('ready', resolve)),
      new Promise((resolve) => redisSubscriber.on('ready', resolve)),
      new Promise((resolve) => redisPublisher.on('ready', resolve))
    ]);

    // Event listeners for main client
    redisClient.on('connect', () => {
      logger.info('✅ Redis client connected');
    });

    redisClient.on('ready', () => {
      logger.info('🚀 Redis client ready');
    });

    redisClient.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') {
        logger.warn('⚠️ Redis client connection refused - using fallback mode');
      } else {
        logger.error('❌ Redis client error:', err.message);
      }
    });

    redisClient.on('close', () => {
      logger.warn('⚠️ Redis client connection closed');
    });

    redisClient.on('reconnecting', () => {
      logger.info('🔄 Redis client reconnecting...');
    });

    // Event listeners for subscriber
    redisSubscriber.on('connect', () => {
      logger.info('✅ Redis subscriber connected');
    });

    redisSubscriber.on('error', (err) => {
      if (err.code !== 'ECONNREFUSED') {
        logger.error('❌ Redis subscriber error:', err.message);
      }
    });

    // Event listeners for publisher
    redisPublisher.on('connect', () => {
      logger.info('✅ Redis publisher connected');
    });

    redisPublisher.on('error', (err) => {
      if (err.code !== 'ECONNREFUSED') {
        logger.error('❌ Redis publisher error:', err.message);
      }
    });

    logger.info('✅ All Redis connections initialized successfully');
    return { redisClient, redisSubscriber, redisPublisher };

  } catch (error) {
    if (error.message.includes('ECONNREFUSED')) {
      logger.warn('⚠️ Redis server not available on localhost:6379');
      logger.info('🔄 Switching to mock Redis service for development');
    } else {
      logger.error('❌ Redis connection failed:', error.message);
      logger.warn('🔄 Using mock Redis service for development');
    }
    
    // Create mock Redis clients that don't attempt connections
    const createMockRedis = () => ({
      ping: async () => 'PONG',
      get: async () => null,
      set: async () => 'OK',
      setex: async () => 'OK',
      del: async () => 1,
      exists: async () => 0,
      expire: async () => 1,
      mget: async (keys) => keys.map(() => null),
      publish: async () => 0,
      subscribe: async () => {},
      unsubscribe: async () => {},
      quit: async () => 'OK',
      disconnect: async () => 'OK',
      info: async () => 'redis_version:mock\r\nuptime_in_seconds:0',
      pipeline: () => ({
        setex: () => mockRedis.pipeline(),
        set: () => mockRedis.pipeline(),
        exec: async () => []
      }),
      on: () => {},
      off: () => {},
      removeAllListeners: () => {},
      status: 'ready'
    });
    
    const mockRedis = createMockRedis();
    
    redisClient = mockRedis;
    redisSubscriber = mockRedis;
    redisPublisher = mockRedis;
    
    logger.info('✅ Mock Redis service initialized');
    return { redisClient, redisSubscriber, redisPublisher };
  }
};

// Redis health check
const checkRedisHealth = async () => {
  try {
    if (!redisClient) {
      return {
        status: 'disconnected',
        connected: false,
        error: 'Redis client not initialized'
      };
    }

    const pong = await redisClient.ping();
    const info = await redisClient.info('server');
    
    return {
      status: 'connected',
      connected: true,
      ping: pong,
      version: info.split('\r\n').find(line => line.startsWith('redis_version:'))?.split(':')[1],
      uptime: info.split('\r\n').find(line => line.startsWith('uptime_in_seconds:'))?.split(':')[1]
    };
  } catch (error) {
    logger.error('❌ Redis health check failed:', error);
    return {
      status: 'error',
      connected: false,
      error: error.message
    };
  }
};

// Cache operations
const cacheOperations = {
  // Set cache with expiration
  set: async (key, value, ttl = 3600) => {
    try {
      if (!redisClient) {
        logger.warn('⚠️ Redis not available, skipping cache set');
        return false;
      }
      const serializedValue = JSON.stringify(value);
      if (ttl) {
        await redisClient.setex(key, ttl, serializedValue);
      } else {
        await redisClient.set(key, serializedValue);
      }
      return true;
    } catch (error) {
      logger.error('❌ Cache set error:', error);
      return false;
    }
  },

  // Get cache
  get: async (key) => {
    try {
      if (!redisClient) {
        return null;
      }
      const value = await redisClient.get(key);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      logger.error('❌ Cache get error:', error);
      return null;
    }
  },

  // Delete cache
  del: async (key) => {
    try {
      const result = await redisClient.del(key);
      return result > 0;
    } catch (error) {
      logger.error('❌ Cache delete error:', error);
      return false;
    }
  },

  // Check if key exists
  exists: async (key) => {
    try {
      const result = await redisClient.exists(key);
      return result === 1;
    } catch (error) {
      logger.error('❌ Cache exists error:', error);
      return false;
    }
  },

  // Set expiration
  expire: async (key, ttl) => {
    try {
      const result = await redisClient.expire(key, ttl);
      return result === 1;
    } catch (error) {
      logger.error('❌ Cache expire error:', error);
      return false;
    }
  },

  // Get multiple keys
  mget: async (keys) => {
    try {
      const values = await redisClient.mget(keys);
      return values.map(value => value ? JSON.parse(value) : null);
    } catch (error) {
      logger.error('❌ Cache mget error:', error);
      return keys.map(() => null);
    }
  },

  // Set multiple keys
  mset: async (keyValuePairs, ttl = 3600) => {
    try {
      const pipeline = redisClient.pipeline();
      
      for (const [key, value] of Object.entries(keyValuePairs)) {
        const serializedValue = JSON.stringify(value);
        if (ttl) {
          pipeline.setex(key, ttl, serializedValue);
        } else {
          pipeline.set(key, serializedValue);
        }
      }
      
      await pipeline.exec();
      return true;
    } catch (error) {
      logger.error('❌ Cache mset error:', error);
      return false;
    }
  }
};

// Pub/Sub operations
const pubSubOperations = {
  // Publish message
  publish: async (channel, message) => {
    try {
      const serializedMessage = JSON.stringify(message);
      const result = await redisPublisher.publish(channel, serializedMessage);
      return result;
    } catch (error) {
      logger.error('❌ Redis publish error:', error);
      return 0;
    }
  },

  // Subscribe to channel
  subscribe: async (channel, callback) => {
    try {
      await redisSubscriber.subscribe(channel);
      redisSubscriber.on('message', (receivedChannel, message) => {
        if (receivedChannel === channel) {
          try {
            const parsedMessage = JSON.parse(message);
            callback(parsedMessage);
          } catch (error) {
            logger.error('❌ Error parsing Redis message:', error);
            callback(message);
          }
        }
      });
      return true;
    } catch (error) {
      logger.error('❌ Redis subscribe error:', error);
      return false;
    }
  },

  // Unsubscribe from channel
  unsubscribe: async (channel) => {
    try {
      await redisSubscriber.unsubscribe(channel);
      return true;
    } catch (error) {
      logger.error('❌ Redis unsubscribe error:', error);
      return false;
    }
  }
};

// Close Redis connections
const closeRedis = async () => {
  try {
    const promises = [];
    
    if (redisClient) {
      promises.push(redisClient.quit());
    }
    
    if (redisSubscriber) {
      promises.push(redisSubscriber.quit());
    }
    
    if (redisPublisher) {
      promises.push(redisPublisher.quit());
    }

    await Promise.all(promises);
    logger.info('✅ All Redis connections closed successfully');
  } catch (error) {
    logger.error('❌ Error closing Redis connections:', error);
    throw error;
  }
};

export {
  initializeRedis,
  checkRedisHealth,
  closeRedis,
  cacheOperations,
  pubSubOperations,
  redisClient,
  redisSubscriber,
  redisPublisher
};

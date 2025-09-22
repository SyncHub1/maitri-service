import winston from 'winston';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Create logs directory if it doesn't exist
const logsDir = join(dirname(__dirname), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Custom log format
const logFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'YYYY-MM-DD HH:mm:ss'
  }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.prettyPrint()
);

// Console format for development
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({
    format: 'HH:mm:ss'
  }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let log = `${timestamp} [${level}]: ${message}`;
    
    // Add metadata if present
    if (Object.keys(meta).length > 0) {
      log += ` ${JSON.stringify(meta, null, 2)}`;
    }
    
    return log;
  })
);

// Create logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  defaultMeta: {
    service: 'matri-service',
    version: process.env.API_VERSION || 'v1',
    environment: process.env.NODE_ENV || 'development'
  },
  transports: [
    // Write all logs with level 'error' and below to error.log
    new winston.transports.File({
      filename: join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
      tailable: true
    }),
    
    // Write all logs to combined.log
    new winston.transports.File({
      filename: join(logsDir, 'combined.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 10,
      tailable: true
    }),
    
    // Write all logs to the main log file specified in env
    new winston.transports.File({
      filename: join(logsDir, process.env.LOG_FILE?.split('/').pop() || 'matri-service.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 10,
      tailable: true
    })
  ],
  
  // Handle exceptions and rejections
  exceptionHandlers: [
    new winston.transports.File({
      filename: join(logsDir, 'exceptions.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5
    })
  ],
  
  rejectionHandlers: [
    new winston.transports.File({
      filename: join(logsDir, 'rejections.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5
    })
  ]
});

// Add console transport for non-production environments
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: consoleFormat,
    level: 'debug'
  }));
}

// Create a stream object for Morgan HTTP logging
const stream = {
  write: (message) => {
    logger.info(message.trim());
  }
};

// Helper functions for structured logging
const logHelpers = {
  // Log API requests
  logRequest: (req, res, responseTime) => {
    logger.info('API Request', {
      method: req.method,
      url: req.originalUrl,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      statusCode: res.statusCode,
      responseTime: `${responseTime}ms`,
      userId: req.user?.id,
      teamId: req.params?.teamId
    });
  },

  // Log authentication events
  logAuth: (event, userId, details = {}) => {
    logger.info('Authentication Event', {
      event,
      userId,
      ...details
    });
  },

  // Log team events
  logTeam: (event, teamId, userId, details = {}) => {
    logger.info('Team Event', {
      event,
      teamId,
      userId,
      ...details
    });
  },

  // Log collaboration events
  logCollaboration: (event, teamId, userId, type, details = {}) => {
    logger.info('Collaboration Event', {
      event,
      teamId,
      userId,
      type, // chat, ide, whiteboard, video, etc.
      ...details
    });
  },

  // Log errors with context
  logError: (error, context = {}) => {
    logger.error('Application Error', {
      message: error.message,
      stack: error.stack,
      ...context
    });
  },

  // Log performance metrics
  logPerformance: (operation, duration, details = {}) => {
    logger.info('Performance Metric', {
      operation,
      duration: `${duration}ms`,
      ...details
    });
  },

  // Log security events
  logSecurity: (event, details = {}) => {
    logger.warn('Security Event', {
      event,
      timestamp: new Date().toISOString(),
      ...details
    });
  }
};

export { logger, stream, logHelpers };

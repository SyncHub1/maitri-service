import { logger, logHelpers } from '../config/logger.js';

// Global error handler middleware
const errorHandler = (err, req, res, next) => {
  // Log the error with context
  logHelpers.logError(err, {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    userId: req.user?.id,
    teamId: req.params?.teamId,
    body: req.method !== 'GET' ? req.body : undefined
  });

  // Default error response
  let error = {
    success: false,
    error: {
      message: 'Internal server error',
      code: 'INTERNAL_ERROR'
    }
  };

  let statusCode = 500;

  // Handle specific error types
  if (err.name === 'ValidationError') {
    // Mongoose validation error
    statusCode = 400;
    const validationErrors = Object.values(err.errors).map(e => ({
      field: e.path,
      message: e.message,
      value: e.value
    }));

    error = {
      success: false,
      error: {
        message: 'Validation failed',
        code: 'VALIDATION_ERROR',
        details: validationErrors
      }
    };
  } else if (err.name === 'CastError') {
    // Mongoose cast error (invalid ObjectId, etc.)
    statusCode = 400;
    error = {
      success: false,
      error: {
        message: `Invalid ${err.path}: ${err.value}`,
        code: 'INVALID_ID'
      }
    };
  } else if (err.code === 11000) {
    // MongoDB duplicate key error
    statusCode = 409;
    const field = Object.keys(err.keyValue)[0];
    const value = err.keyValue[field];

    error = {
      success: false,
      error: {
        message: `${field} '${value}' already exists`,
        code: 'DUPLICATE_ENTRY',
        field
      }
    };
  } else if (err.name === 'JsonWebTokenError') {
    // JWT error
    statusCode = 401;
    error = {
      success: false,
      error: {
        message: 'Invalid authentication token',
        code: 'INVALID_TOKEN'
      }
    };
  } else if (err.name === 'TokenExpiredError') {
    // JWT expired error
    statusCode = 401;
    error = {
      success: false,
      error: {
        message: 'Authentication token has expired',
        code: 'TOKEN_EXPIRED'
      }
    };
  } else if (err.name === 'MulterError') {
    // File upload error
    statusCode = 400;
    let message = 'File upload error';

    switch (err.code) {
      case 'LIMIT_FILE_SIZE':
        message = 'File size too large';
        break;
      case 'LIMIT_FILE_COUNT':
        message = 'Too many files';
        break;
      case 'LIMIT_UNEXPECTED_FILE':
        message = 'Unexpected file field';
        break;
      default:
        message = err.message;
    }

    error = {
      success: false,
      error: {
        message,
        code: 'FILE_UPLOAD_ERROR'
      }
    };
  } else if (err.type === 'entity.parse.failed') {
    // JSON parse error
    statusCode = 400;
    error = {
      success: false,
      error: {
        message: 'Invalid JSON in request body',
        code: 'INVALID_JSON'
      }
    };
  } else if (err.type === 'entity.too.large') {
    // Request entity too large
    statusCode = 413;
    error = {
      success: false,
      error: {
        message: 'Request entity too large',
        code: 'PAYLOAD_TOO_LARGE'
      }
    };
  } else if (err.status || err.statusCode) {
    // Custom error with status code
    statusCode = err.status || err.statusCode;
    error = {
      success: false,
      error: {
        message: err.message || 'An error occurred',
        code: err.code || 'CUSTOM_ERROR'
      }
    };
  }

  // In development, include stack trace
  if (process.env.NODE_ENV === 'development') {
    error.error.stack = err.stack;
  }

  // Send error response
  res.status(statusCode).json(error);
};

// 404 handler for undefined routes
const notFoundHandler = (req, res) => {
  const error = {
    success: false,
    error: {
      message: `Route ${req.method} ${req.originalUrl} not found`,
      code: 'ROUTE_NOT_FOUND'
    }
  };

  // Log 404 errors
  logger.warn('404 Route not found', {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    userId: req.user?.id
  });

  res.status(404).json(error);
};

// Async error wrapper to catch async errors in route handlers
const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

// Custom error class for application-specific errors
class AppError extends Error {
  constructor(message, statusCode = 500, code = 'APP_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

// Validation error helper
const createValidationError = (message, field = null) => {
  const error = new AppError(message, 400, 'VALIDATION_ERROR');
  if (field) {
    error.field = field;
  }
  return error;
};

// Authorization error helper
const createAuthError = (message = 'Access denied', code = 'ACCESS_DENIED') => {
  return new AppError(message, 403, code);
};

// Not found error helper
const createNotFoundError = (resource = 'Resource') => {
  return new AppError(`${resource} not found`, 404, 'NOT_FOUND');
};

// Conflict error helper
const createConflictError = (message) => {
  return new AppError(message, 409, 'CONFLICT');
};

// Rate limit error helper
const createRateLimitError = (message = 'Too many requests') => {
  return new AppError(message, 429, 'RATE_LIMIT_EXCEEDED');
};

export {
  errorHandler,
  notFoundHandler,
  asyncHandler,
  AppError,
  createValidationError,
  createAuthError,
  createNotFoundError,
  createConflictError,
  createRateLimitError
};

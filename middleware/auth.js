import jwt from 'jsonwebtoken';
import axios from 'axios';
import { logger, logHelpers } from '../config/logger.js';
import { cacheOperations } from '../config/redis.js';

// JWT token verification middleware
const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: {
          message: 'Access token required',
          code: 'MISSING_TOKEN'
        }
      });
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    // Verify JWT token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Check if token is blacklisted (cached)
    const isBlacklisted = await cacheOperations.get(`blacklist:${token}`);
    if (isBlacklisted) {
      return res.status(401).json({
        success: false,
        error: {
          message: 'Token has been revoked',
          code: 'TOKEN_REVOKED'
        }
      });
    }

    // Try to get user info from cache first
    const userId = decoded.userId || decoded.id;
    let userInfo = await cacheOperations.get(`user:${userId}:info`);

    // If not in cache, fetch from auth service
    if (!userInfo) {
      try {
        const authServiceUrl = process.env.AUTH_SERVICE_URL || 'http://localhost:8000';
        const response = await axios.get(`${authServiceUrl}/auth/profile`, {
          headers: {
            Authorization: `Bearer ${token}`
          },
          timeout: 5000
        });

        userInfo = response.data.user || response.data;
        
        // Cache user info for 15 minutes
        await cacheOperations.set(`user:${userId}:info`, userInfo, 900);
        
      } catch (authError) {
        logger.error('❌ Failed to fetch user info from auth service:', authError.message);
        
        // If auth service is down, use basic info from token
        userInfo = {
          id: userId,
          email: decoded.email,
          name: decoded.name || 'Unknown User'
        };
      }
    }

    // Attach user info to request
    req.user = {
      id: userId,
      ...userInfo,
      token
    };

    // Log authentication event
    logHelpers.logAuth('token_verified', userId, {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      endpoint: req.originalUrl
    });

    next();

  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        error: {
          message: 'Invalid token',
          code: 'INVALID_TOKEN'
        }
      });
    }

    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: {
          message: 'Token has expired',
          code: 'TOKEN_EXPIRED'
        }
      });
    }

    logger.error('❌ Authentication middleware error:', error);
    return res.status(500).json({
      success: false,
      error: {
        message: 'Authentication service error',
        code: 'AUTH_SERVICE_ERROR'
      }
    });
  }
};

// Optional authentication middleware (doesn't fail if no token)
const optionalAuthMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      req.user = null;
      return next();
    }

    // Use the main auth middleware logic
    await authMiddleware(req, res, next);
  } catch (error) {
    // If authentication fails, continue without user info
    req.user = null;
    next();
  }
};

// Team member authorization middleware
const teamMemberMiddleware = async (req, res, next) => {
  try {
    const { teamId } = req.params;
    const userId = req.user?.id;

    if (!teamId) {
      return res.status(400).json({
        success: false,
        error: {
          message: 'Team ID is required',
          code: 'MISSING_TEAM_ID'
        }
      });
    }

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: {
          message: 'Authentication required',
          code: 'AUTH_REQUIRED'
        }
      });
    }

    // Check if user is a member of the team (from cache first)
    const cacheKey = `team:${teamId}:member:${userId}`;
    let isMember = await cacheOperations.get(cacheKey);

    if (isMember === null) {
      // If not in cache, check database
      // This would typically involve a database query
      // For now, we'll implement a basic check
      
      try {
        // Import Team model dynamically to avoid circular dependencies
        const { Team } = await import('../models/Team.js');
        const team = await Team.findById(teamId);
        
        if (!team) {
          return res.status(404).json({
            success: false,
            error: {
              message: 'Team not found',
              code: 'TEAM_NOT_FOUND'
            }
          });
        }

        isMember = team.members.some(member => 
          member.userId.toString() === userId || member.userId === userId
        ) || team.admins.some(admin => 
          admin.userId.toString() === userId || admin.userId === userId
        );

        // Cache the result for 5 minutes
        await cacheOperations.set(cacheKey, isMember, 300);

      } catch (dbError) {
        logger.error('❌ Database error in team member check:', dbError);
        return res.status(500).json({
          success: false,
          error: {
            message: 'Database error',
            code: 'DATABASE_ERROR'
          }
        });
      }
    }

    if (!isMember) {
      logHelpers.logSecurity('unauthorized_team_access', {
        userId,
        teamId,
        ip: req.ip,
        endpoint: req.originalUrl
      });

      return res.status(403).json({
        success: false,
        error: {
          message: 'Access denied. You are not a member of this team.',
          code: 'NOT_TEAM_MEMBER'
        }
      });
    }

    // Attach team info to request
    req.teamId = teamId;
    req.isMember = true;

    next();

  } catch (error) {
    logger.error('❌ Team member middleware error:', error);
    return res.status(500).json({
      success: false,
      error: {
        message: 'Authorization service error',
        code: 'AUTH_SERVICE_ERROR'
      }
    });
  }
};

// Team admin authorization middleware
const teamAdminMiddleware = async (req, res, next) => {
  try {
    const { teamId } = req.params;
    const userId = req.user?.id;

    if (!teamId || !userId) {
      return res.status(400).json({
        success: false,
        error: {
          message: 'Team ID and authentication required',
          code: 'MISSING_REQUIREMENTS'
        }
      });
    }

    // Check if user is an admin of the team
    const cacheKey = `team:${teamId}:admin:${userId}`;
    let isAdmin = await cacheOperations.get(cacheKey);

    if (isAdmin === null) {
      try {
        const { Team } = await import('../models/Team.js');
        const team = await Team.findById(teamId);
        
        if (!team) {
          return res.status(404).json({
            success: false,
            error: {
              message: 'Team not found',
              code: 'TEAM_NOT_FOUND'
            }
          });
        }

        isAdmin = team.admins.some(admin => 
          admin.userId.toString() === userId || admin.userId === userId
        ) || team.createdBy.toString() === userId || team.createdBy === userId;

        // Cache the result for 5 minutes
        await cacheOperations.set(cacheKey, isAdmin, 300);

      } catch (dbError) {
        logger.error('❌ Database error in team admin check:', dbError);
        return res.status(500).json({
          success: false,
          error: {
            message: 'Database error',
            code: 'DATABASE_ERROR'
          }
        });
      }
    }

    if (!isAdmin) {
      logHelpers.logSecurity('unauthorized_admin_access', {
        userId,
        teamId,
        ip: req.ip,
        endpoint: req.originalUrl
      });

      return res.status(403).json({
        success: false,
        error: {
          message: 'Access denied. Admin privileges required.',
          code: 'NOT_TEAM_ADMIN'
        }
      });
    }

    req.teamId = teamId;
    req.isAdmin = true;

    next();

  } catch (error) {
    logger.error('❌ Team admin middleware error:', error);
    return res.status(500).json({
      success: false,
      error: {
        message: 'Authorization service error',
        code: 'AUTH_SERVICE_ERROR'
      }
    });
  }
};

// Rate limiting middleware for specific operations
const operationRateLimit = (operation, maxRequests = 10, windowMs = 60000) => {
  return async (req, res, next) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return next();
      }

      const key = `rate_limit:${operation}:${userId}`;
      const current = await cacheOperations.get(key) || 0;

      if (current >= maxRequests) {
        logHelpers.logSecurity('rate_limit_exceeded', {
          userId,
          operation,
          current,
          maxRequests,
          ip: req.ip
        });

        return res.status(429).json({
          success: false,
          error: {
            message: `Too many ${operation} requests. Please try again later.`,
            code: 'RATE_LIMIT_EXCEEDED'
          }
        });
      }

      // Increment counter
      await cacheOperations.set(key, current + 1, Math.ceil(windowMs / 1000));

      next();
    } catch (error) {
      logger.error('❌ Rate limit middleware error:', error);
      next(); // Continue on error
    }
  };
};

export {
  authMiddleware,
  optionalAuthMiddleware,
  teamMemberMiddleware,
  teamAdminMiddleware,
  operationRateLimit
};

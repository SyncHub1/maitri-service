import express from 'express';
import { param, query, validationResult } from 'express-validator';
import { authMiddleware, teamMemberMiddleware } from '../middleware/auth.js';
import { asyncHandler, createNotFoundError } from '../middleware/errorHandler.js';
import { cacheOperations } from '../config/redis.js';
import { Team } from '../models/Team.js';

const router = express.Router();

const validateRequest = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: {
        message: 'Validation failed',
        code: 'VALIDATION_ERROR',
        details: errors.array()
      }
    });
  }
  next();
};

// GET /api/collaboration/:teamId/status - Get team collaboration status
router.get('/:teamId/status',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId } = req.params;

    // Try cache first
    const cacheKey = `collaboration:${teamId}:status`;
    let collaborationStatus = await cacheOperations.get(cacheKey);

    if (!collaborationStatus) {
      const team = await Team.findById(teamId);
      if (!team) {
        throw createNotFoundError('Team');
      }

      // Get online members from cache
      const onlineMembers = [];
      for (const member of team.members) {
        const isOnline = await cacheOperations.exists(`user:${member.userId}:online`);
        if (isOnline) {
          const lastSeen = await cacheOperations.get(`user:${member.userId}:lastSeen`);
          onlineMembers.push({
            userId: member.userId,
            userName: member.name,
            avatar: member.avatar,
            lastSeen: lastSeen || new Date().toISOString()
          });
        }
      }

      // Get active collaboration sessions
      const activeSessions = {
        chat: onlineMembers.length,
        ide: 0,
        whiteboard: 0,
        video: 0
      };

      // Check for active IDE sessions
      const ideKeys = await cacheOperations.get(`team:${teamId}:active_ide_sessions`) || [];
      activeSessions.ide = ideKeys.length;

      // Check for active whiteboard sessions
      const whiteboardKeys = await cacheOperations.get(`team:${teamId}:active_whiteboard_sessions`) || [];
      activeSessions.whiteboard = whiteboardKeys.length;

      // Check for active video calls
      const videoKeys = await cacheOperations.get(`team:${teamId}:active_video_calls`) || [];
      activeSessions.video = videoKeys.length;

      collaborationStatus = {
        teamId,
        onlineMembers,
        totalOnline: onlineMembers.length,
        activeSessions,
        lastUpdated: new Date().toISOString()
      };

      // Cache for 30 seconds (short TTL for real-time data)
      await cacheOperations.set(cacheKey, collaborationStatus, 30);
    }

    res.json({
      success: true,
      data: collaborationStatus
    });
  })
);

// GET /api/collaboration/:teamId/activity - Get recent collaboration activity
router.get('/:teamId/activity',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId } = req.params;
    const { limit = 50, type } = req.query;

    const cacheKey = `collaboration:${teamId}:activity:${limit}:${type || 'all'}`;
    let recentActivity = await cacheOperations.get(cacheKey);

    if (!recentActivity) {
      // Get recent activity from various sources
      const activities = [];

      // Get recent chat messages
      if (!type || type === 'chat') {
        const recentMessages = await cacheOperations.get(`team:${teamId}:recent_messages`) || [];
        activities.push(...recentMessages.slice(0, 20).map(msg => ({
          type: 'chat',
          action: 'message_sent',
          userId: msg.userId,
          userName: msg.userName,
          timestamp: msg.createdAt,
          details: {
            messageId: msg._id,
            messageType: msg.type,
            preview: msg.message.substring(0, 100)
          }
        })));
      }

      // Get recent IDE activity
      if (!type || type === 'ide') {
        const ideActivity = await cacheOperations.get(`team:${teamId}:recent_ide_activity`) || [];
        activities.push(...ideActivity.slice(0, 10).map(activity => ({
          type: 'ide',
          action: activity.action,
          userId: activity.userId,
          userName: activity.userName,
          timestamp: activity.timestamp,
          details: activity.details
        })));
      }

      // Get recent whiteboard activity
      if (!type || type === 'whiteboard') {
        const whiteboardActivity = await cacheOperations.get(`team:${teamId}:recent_whiteboard_activity`) || [];
        activities.push(...whiteboardActivity.slice(0, 10).map(activity => ({
          type: 'whiteboard',
          action: activity.action,
          userId: activity.userId,
          userName: activity.userName,
          timestamp: activity.timestamp,
          details: activity.details
        })));
      }

      // Get recent video call activity
      if (!type || type === 'video') {
        const videoActivity = await cacheOperations.get(`team:${teamId}:recent_video_activity`) || [];
        activities.push(...videoActivity.slice(0, 10).map(activity => ({
          type: 'video',
          action: activity.action,
          userId: activity.userId,
          userName: activity.userName,
          timestamp: activity.timestamp,
          details: activity.details
        })));
      }

      // Sort by timestamp and limit
      recentActivity = activities
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, parseInt(limit));

      // Cache for 2 minutes
      await cacheOperations.set(cacheKey, recentActivity, 120);
    }

    res.json({
      success: true,
      data: recentActivity
    });
  })
);

// GET /api/collaboration/:teamId/presence - Get team member presence
router.get('/:teamId/presence',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId } = req.params;

    const team = await Team.findById(teamId);
    if (!team) {
      throw createNotFoundError('Team');
    }

    const memberPresence = [];

    for (const member of team.members) {
      if (!member.isActive) continue;

      const isOnline = await cacheOperations.exists(`user:${member.userId}:online`);
      const lastSeen = await cacheOperations.get(`user:${member.userId}:lastSeen`);
      
      // Get current activity
      const currentActivity = {
        chat: false,
        ide: false,
        whiteboard: false,
        video: false
      };

      // Check if user is in any active sessions
      const activeSessions = await cacheOperations.get(`user:${member.userId}:active_sessions`) || {};
      Object.keys(currentActivity).forEach(key => {
        currentActivity[key] = activeSessions[key] || false;
      });

      memberPresence.push({
        userId: member.userId,
        userName: member.name,
        avatar: member.avatar,
        role: member.role,
        isOnline,
        lastSeen: lastSeen || member.lastActive,
        currentActivity,
        status: isOnline ? 'online' : 'offline'
      });
    }

    // Sort by online status and last seen
    memberPresence.sort((a, b) => {
      if (a.isOnline && !b.isOnline) return -1;
      if (!a.isOnline && b.isOnline) return 1;
      return new Date(b.lastSeen) - new Date(a.lastSeen);
    });

    res.json({
      success: true,
      data: {
        teamId,
        members: memberPresence,
        summary: {
          totalMembers: memberPresence.length,
          onlineMembers: memberPresence.filter(m => m.isOnline).length,
          offlineMembers: memberPresence.filter(m => !m.isOnline).length
        }
      }
    });
  })
);

// GET /api/collaboration/:teamId/sessions - Get active collaboration sessions
router.get('/:teamId/sessions',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId } = req.params;
    const { type } = req.query;

    const sessions = {};

    if (!type || type === 'ide') {
      const ideSessions = await cacheOperations.get(`team:${teamId}:active_ide_sessions`) || [];
      sessions.ide = ideSessions;
    }

    if (!type || type === 'whiteboard') {
      const whiteboardSessions = await cacheOperations.get(`team:${teamId}:active_whiteboard_sessions`) || [];
      sessions.whiteboard = whiteboardSessions;
    }

    if (!type || type === 'video') {
      const videoSessions = await cacheOperations.get(`team:${teamId}:active_video_calls`) || [];
      sessions.video = videoSessions;
    }

    res.json({
      success: true,
      data: {
        teamId,
        sessions,
        summary: {
          totalSessions: Object.values(sessions).reduce((sum, sessionList) => sum + sessionList.length, 0),
          sessionTypes: Object.keys(sessions).filter(key => sessions[key].length > 0)
        }
      }
    });
  })
);

export default router;

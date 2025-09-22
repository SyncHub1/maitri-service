import express from 'express';
import { param, query, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import { authMiddleware, teamMemberMiddleware } from '../middleware/auth.js';
import { asyncHandler, createNotFoundError } from '../middleware/errorHandler.js';
import { Team } from '../models/Team.js';
import { ChatMessage } from '../models/Chat.js';
import { cacheOperations } from '../config/redis.js';

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

// GET /api/analytics/:teamId/overview - Get team analytics overview
router.get('/:teamId/overview',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId } = req.params;
    const { period = '30d' } = req.query;

    // Try cache first
    const cacheKey = `analytics:${teamId}:overview:${period}`;
    let analytics = await cacheOperations.get(cacheKey);

    if (!analytics) {
      const team = await Team.findById(teamId);
      if (!team) {
        throw createNotFoundError('Team');
      }

      // Calculate date range
      let startDate;
      switch (period) {
        case '7d':
          startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
          break;
        case '30d':
          startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
          break;
        case '90d':
          startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
          break;
        default:
          startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      }

      // Get message analytics
      const messageStats = await ChatMessage.aggregate([
        {
          $match: {
            teamId: new mongoose.Types.ObjectId(teamId),
            createdAt: { $gte: startDate },
            isDeleted: false
          }
        },
        {
          $group: {
            _id: {
              date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
              userId: '$userId'
            },
            messageCount: { $sum: 1 }
          }
        },
        {
          $group: {
            _id: '$_id.date',
            totalMessages: { $sum: '$messageCount' },
            activeUsers: { $addToSet: '$_id.userId' }
          }
        },
        {
          $project: {
            date: '$_id',
            totalMessages: 1,
            activeUserCount: { $size: '$activeUsers' }
          }
        },
        { $sort: { date: 1 } }
      ]);

      // Get user activity stats
      const userActivityStats = await ChatMessage.aggregate([
        {
          $match: {
            teamId: new mongoose.Types.ObjectId(teamId),
            createdAt: { $gte: startDate },
            isDeleted: false
          }
        },
        {
          $group: {
            _id: '$userId',
            userName: { $first: '$userName' },
            messageCount: { $sum: 1 },
            lastActivity: { $max: '$createdAt' }
          }
        },
        { $sort: { messageCount: -1 } },
        { $limit: 10 }
      ]);

      analytics = {
        team: {
          id: team._id,
          name: team.name,
          memberCount: team.memberCount,
          createdAt: team.createdAt
        },
        period,
        overview: {
          totalMessages: team.stats.totalMessages || 0,
          totalTasks: team.stats.totalTasks || 0,
          completedTasks: team.stats.completedTasks || 0,
          totalMeetings: team.stats.totalMeetings || 0,
          totalMeetingMinutes: team.stats.totalMeetingMinutes || 0,
          taskCompletionRate: team.stats.totalTasks > 0 
            ? Math.round((team.stats.completedTasks / team.stats.totalTasks) * 100) 
            : 0
        },
        activity: {
          dailyMessages: messageStats,
          topUsers: userActivityStats
        },
        growth: {
          memberGrowth: [], // Would be calculated from member join dates
          activityTrend: messageStats.map(stat => ({
            date: stat.date,
            value: stat.totalMessages
          }))
        }
      };

      // Cache for 1 hour
      await cacheOperations.set(cacheKey, analytics, 3600);
    }

    res.json({
      success: true,
      data: analytics
    });
  })
);

// GET /api/analytics/:teamId/messages - Get message analytics
router.get('/:teamId/messages',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId } = req.params;
    const { period = '30d', groupBy = 'day' } = req.query;

    const cacheKey = `analytics:${teamId}:messages:${period}:${groupBy}`;
    let messageAnalytics = await cacheOperations.get(cacheKey);

    if (!messageAnalytics) {
      // Calculate date range
      let startDate;
      switch (period) {
        case '7d':
          startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
          break;
        case '30d':
          startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
          break;
        case '90d':
          startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
          break;
        default:
          startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      }

      // Group by format
      let dateFormat;
      switch (groupBy) {
        case 'hour':
          dateFormat = '%Y-%m-%d %H:00';
          break;
        case 'day':
          dateFormat = '%Y-%m-%d';
          break;
        case 'week':
          dateFormat = '%Y-W%U';
          break;
        case 'month':
          dateFormat = '%Y-%m';
          break;
        default:
          dateFormat = '%Y-%m-%d';
      }

      const pipeline = [
        {
          $match: {
            teamId: new mongoose.Types.ObjectId(teamId),
            createdAt: { $gte: startDate },
            isDeleted: false
          }
        },
        {
          $group: {
            _id: {
              period: { $dateToString: { format: dateFormat, date: '$createdAt' } },
              type: '$type'
            },
            count: { $sum: 1 },
            users: { $addToSet: '$userId' }
          }
        },
        {
          $group: {
            _id: '$_id.period',
            totalMessages: { $sum: '$count' },
            messagesByType: {
              $push: {
                type: '$_id.type',
                count: '$count'
              }
            },
            uniqueUsers: { $addToSet: '$users' }
          }
        },
        {
          $project: {
            period: '$_id',
            totalMessages: 1,
            messagesByType: 1,
            uniqueUserCount: { $size: { $reduce: { input: '$uniqueUsers', initialValue: [], in: { $setUnion: ['$$value', '$$this'] } } } }
          }
        },
        { $sort: { period: 1 } }
      ];

      const results = await ChatMessage.aggregate(pipeline);

      // Get top users for the period
      const topUsers = await ChatMessage.aggregate([
        {
          $match: {
            teamId: new mongoose.Types.ObjectId(teamId),
            createdAt: { $gte: startDate },
            isDeleted: false
          }
        },
        {
          $group: {
            _id: '$userId',
            userName: { $first: '$userName' },
            messageCount: { $sum: 1 },
            messageTypes: { $addToSet: '$type' }
          }
        },
        { $sort: { messageCount: -1 } },
        { $limit: 10 }
      ]);

      messageAnalytics = {
        period,
        groupBy,
        timeline: results,
        topUsers,
        summary: {
          totalMessages: results.reduce((sum, item) => sum + item.totalMessages, 0),
          averageMessagesPerPeriod: results.length > 0 
            ? Math.round(results.reduce((sum, item) => sum + item.totalMessages, 0) / results.length)
            : 0,
          peakActivity: results.length > 0 
            ? results.reduce((max, item) => item.totalMessages > max.totalMessages ? item : max)
            : null
        }
      };

      // Cache for 30 minutes
      await cacheOperations.set(cacheKey, messageAnalytics, 1800);
    }

    res.json({
      success: true,
      data: messageAnalytics
    });
  })
);

// GET /api/analytics/:teamId/members - Get member analytics
router.get('/:teamId/members',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId } = req.params;

    const cacheKey = `analytics:${teamId}:members`;
    let memberAnalytics = await cacheOperations.get(cacheKey);

    if (!memberAnalytics) {
      const team = await Team.findById(teamId);
      if (!team) {
        throw createNotFoundError('Team');
      }

      // Get member activity from messages
      const memberActivity = await ChatMessage.aggregate([
        {
          $match: {
            teamId: new mongoose.Types.ObjectId(teamId),
            isDeleted: false
          }
        },
        {
          $group: {
            _id: '$userId',
            userName: { $first: '$userName' },
            totalMessages: { $sum: 1 },
            firstMessage: { $min: '$createdAt' },
            lastMessage: { $max: '$createdAt' },
            messageTypes: { $addToSet: '$type' }
          }
        }
      ]);

      // Combine with team member data
      const memberStats = team.members.map(member => {
        const activity = memberActivity.find(a => a._id === member.userId) || {};
        
        return {
          userId: member.userId,
          userName: member.name,
          role: member.role,
          joinedAt: member.joinedAt,
          lastActive: member.lastActive,
          isActive: member.isActive,
          permissions: member.permissions,
          activity: {
            totalMessages: activity.totalMessages || 0,
            firstMessage: activity.firstMessage,
            lastMessage: activity.lastMessage,
            messageTypes: activity.messageTypes || [],
            daysSinceJoined: Math.floor((Date.now() - member.joinedAt.getTime()) / (1000 * 60 * 60 * 24)),
            daysSinceLastActive: member.lastActive 
              ? Math.floor((Date.now() - member.lastActive.getTime()) / (1000 * 60 * 60 * 24))
              : null
          }
        };
      });

      // Calculate member distribution
      const roleDistribution = {};
      const activityLevels = { high: 0, medium: 0, low: 0, inactive: 0 };

      memberStats.forEach(member => {
        // Role distribution
        roleDistribution[member.role] = (roleDistribution[member.role] || 0) + 1;

        // Activity levels
        const messageCount = member.activity.totalMessages;
        if (messageCount === 0) {
          activityLevels.inactive++;
        } else if (messageCount >= 100) {
          activityLevels.high++;
        } else if (messageCount >= 20) {
          activityLevels.medium++;
        } else {
          activityLevels.low++;
        }
      });

      memberAnalytics = {
        totalMembers: team.memberCount,
        activeMembers: team.members.filter(m => m.isActive).length,
        memberStats: memberStats.sort((a, b) => b.activity.totalMessages - a.activity.totalMessages),
        distribution: {
          byRole: roleDistribution,
          byActivity: activityLevels
        },
        growth: {
          // Member join timeline (last 30 days)
          recentJoins: team.members
            .filter(m => m.joinedAt > new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
            .map(m => ({
              userId: m.userId,
              userName: m.name,
              joinedAt: m.joinedAt
            }))
            .sort((a, b) => b.joinedAt - a.joinedAt)
        }
      };

      // Cache for 1 hour
      await cacheOperations.set(cacheKey, memberAnalytics, 3600);
    }

    res.json({
      success: true,
      data: memberAnalytics
    });
  })
);

// GET /api/analytics/:teamId/engagement - Get engagement analytics
router.get('/:teamId/engagement',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId } = req.params;
    const { period = '30d' } = req.query;

    const cacheKey = `analytics:${teamId}:engagement:${period}`;
    let engagementAnalytics = await cacheOperations.get(cacheKey);

    if (!engagementAnalytics) {
      // Calculate date range
      let startDate;
      switch (period) {
        case '7d':
          startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
          break;
        case '30d':
          startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
          break;
        case '90d':
          startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
          break;
        default:
          startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      }

      // Get daily active users
      const dailyActiveUsers = await ChatMessage.aggregate([
        {
          $match: {
            teamId: new mongoose.Types.ObjectId(teamId),
            createdAt: { $gte: startDate },
            isDeleted: false
          }
        },
        {
          $group: {
            _id: {
              date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
              userId: '$userId'
            }
          }
        },
        {
          $group: {
            _id: '$_id.date',
            activeUsers: { $addToSet: '$_id.userId' }
          }
        },
        {
          $project: {
            date: '$_id',
            activeUserCount: { $size: '$activeUsers' }
          }
        },
        { $sort: { date: 1 } }
      ]);

      // Get message reactions and engagement
      const engagementStats = await ChatMessage.aggregate([
        {
          $match: {
            teamId: new mongoose.Types.ObjectId(teamId),
            createdAt: { $gte: startDate },
            isDeleted: false
          }
        },
        {
          $project: {
            hasReactions: { $gt: [{ $size: { $ifNull: ['$reactions', []] } }, 0] },
            reactionCount: { $size: { $ifNull: ['$reactions', []] } },
            hasReplies: { $ne: ['$replyTo', null] },
            messageLength: { $strLenCP: '$message' }
          }
        },
        {
          $group: {
            _id: null,
            totalMessages: { $sum: 1 },
            messagesWithReactions: { $sum: { $cond: ['$hasReactions', 1, 0] } },
            totalReactions: { $sum: '$reactionCount' },
            repliesCount: { $sum: { $cond: ['$hasReplies', 1, 0] } },
            averageMessageLength: { $avg: '$messageLength' }
          }
        }
      ]);

      const stats = engagementStats[0] || {
        totalMessages: 0,
        messagesWithReactions: 0,
        totalReactions: 0,
        repliesCount: 0,
        averageMessageLength: 0
      };

      engagementAnalytics = {
        period,
        dailyActiveUsers,
        engagement: {
          totalMessages: stats.totalMessages,
          messagesWithReactions: stats.messagesWithReactions,
          totalReactions: stats.totalReactions,
          repliesCount: stats.repliesCount,
          averageMessageLength: Math.round(stats.averageMessageLength || 0),
          engagementRate: stats.totalMessages > 0 
            ? Math.round((stats.messagesWithReactions / stats.totalMessages) * 100)
            : 0,
          reactionRate: stats.totalMessages > 0
            ? Math.round((stats.totalReactions / stats.totalMessages) * 100)
            : 0
        },
        trends: {
          averageDailyActiveUsers: dailyActiveUsers.length > 0
            ? Math.round(dailyActiveUsers.reduce((sum, day) => sum + day.activeUserCount, 0) / dailyActiveUsers.length)
            : 0,
          peakActiveUsers: dailyActiveUsers.length > 0
            ? Math.max(...dailyActiveUsers.map(day => day.activeUserCount))
            : 0
        }
      };

      // Cache for 30 minutes
      await cacheOperations.set(cacheKey, engagementAnalytics, 1800);
    }

    res.json({
      success: true,
      data: engagementAnalytics
    });
  })
);

export default router;

import express from 'express';
import { body, param, query, validationResult } from 'express-validator';
import { Team } from '../models/Team.js';
import { authMiddleware, teamMemberMiddleware, teamAdminMiddleware, operationRateLimit } from '../middleware/auth.js';
import { asyncHandler, AppError, createValidationError, createNotFoundError, createAuthError } from '../middleware/errorHandler.js';
import { logger, logHelpers } from '../config/logger.js';
import { cacheOperations } from '../config/redis.js';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

// Validation rules
const createTeamValidation = [
  body('name')
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage('Team name must be between 2 and 100 characters'),
  body('description')
    .optional()
    .trim()
    .isLength({ max: 1000 })
    .withMessage('Description cannot exceed 1000 characters'),
  body('category')
    .isIn(['Web Development', 'Mobile Apps', 'AI/ML', 'Blockchain', 'IoT', 'Game Development', 'Design', 'Data Science', 'DevOps', 'Cybersecurity', 'Other'])
    .withMessage('Invalid category'),
  body('visibility')
    .optional()
    .isIn(['public', 'private', 'invite-only'])
    .withMessage('Invalid visibility setting'),
  body('location')
    .optional()
    .trim()
    .isLength({ max: 100 })
    .withMessage('Location cannot exceed 100 characters'),
  body('skills')
    .optional()
    .isArray()
    .withMessage('Skills must be an array'),
  body('skills.*')
    .optional()
    .trim()
    .isLength({ max: 50 })
    .withMessage('Each skill cannot exceed 50 characters'),
  body('lookingFor')
    .optional()
    .isArray()
    .withMessage('Looking for must be an array'),
  body('lookingFor.*')
    .optional()
    .trim()
    .isLength({ max: 50 })
    .withMessage('Each role cannot exceed 50 characters'),
  body('maxMembers')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('Max members must be between 1 and 100')
];

const updateTeamValidation = [
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  body('name')
    .optional()
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage('Team name must be between 2 and 100 characters'),
  body('description')
    .optional()
    .trim()
    .isLength({ max: 1000 })
    .withMessage('Description cannot exceed 1000 characters'),
  body('category')
    .optional()
    .isIn(['Web Development', 'Mobile Apps', 'AI/ML', 'Blockchain', 'IoT', 'Game Development', 'Design', 'Data Science', 'DevOps', 'Cybersecurity', 'Other'])
    .withMessage('Invalid category'),
  body('visibility')
    .optional()
    .isIn(['public', 'private', 'invite-only'])
    .withMessage('Invalid visibility setting'),
  body('location')
    .optional()
    .trim()
    .isLength({ max: 100 })
    .withMessage('Location cannot exceed 100 characters')
];

// Helper function to validate request
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

// Helper function to get user info from auth service
const getUserInfo = async (userId, token) => {
  try {
    // Try cache first
    const cachedUser = await cacheOperations.get(`user:${userId}:info`);
    if (cachedUser) {
      return cachedUser;
    }

    // Fetch from auth service
    const authServiceUrl = process.env.AUTH_SERVICE_URL || 'http://localhost:8000';
    const response = await axios.get(`${authServiceUrl}/auth/user/${userId}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 5000
    });

    const userInfo = response.data.user || response.data;
    
    // Cache for 15 minutes
    await cacheOperations.set(`user:${userId}:info`, userInfo, 900);
    
    return userInfo;
  } catch (error) {
    logger.error('❌ Failed to fetch user info:', error.message);
    return {
      id: userId,
      name: 'Unknown User',
      email: 'unknown@example.com'
    };
  }
};

// GET /api/teams - Get all teams with filtering and pagination
router.get('/', asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 20,
    category,
    visibility = 'public',
    search,
    skills,
    location,
    sortBy = 'createdAt',
    sortOrder = 'desc'
  } = req.query;

  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);
  const skip = (pageNum - 1) * limitNum;

  // Build query
  let query = {
    status: 'active',
    isArchived: false
  };

  // Only show public teams for non-authenticated users
  if (!req.user) {
    query.visibility = 'public';
  } else if (visibility) {
    query.visibility = visibility;
  }

  if (category) {
    query.category = category;
  }

  if (location) {
    query.location = new RegExp(location, 'i');
  }

  if (skills) {
    const skillsArray = Array.isArray(skills) ? skills : [skills];
    query.skills = { $in: skillsArray };
  }

  // Handle search
  let teams;
  if (search) {
    teams = await Team.searchTeams(search, query)
      .limit(limitNum)
      .skip(skip);
  } else {
    // Build sort object
    const sortObj = {};
    sortObj[sortBy] = sortOrder === 'desc' ? -1 : 1;

    teams = await Team.find(query)
      .sort(sortObj)
      .limit(limitNum)
      .skip(skip);
  }

  // Get total count for pagination
  const total = await Team.countDocuments(query);

  // Cache the results for 5 minutes
  const cacheKey = `teams:list:${JSON.stringify(req.query)}`;
  await cacheOperations.set(cacheKey, { teams, total }, 300);

  res.json({
    success: true,
    data: teams,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      pages: Math.ceil(total / limitNum)
    }
  });
}));

// GET /api/teams/my - Get user's teams
router.get('/my', authMiddleware, asyncHandler(async (req, res) => {
  const userId = req.user.id;

  // Try cache first
  const cacheKey = `user:${userId}:teams`;
  let teams = await cacheOperations.get(cacheKey);

  if (!teams) {
    teams = await Team.findByMember(userId);
    // Cache for 10 minutes
    await cacheOperations.set(cacheKey, teams, 600);
  }

  res.json({
    success: true,
    data: teams
  });
}));

// GET /api/teams/categories - Get team categories with counts
router.get('/categories', asyncHandler(async (req, res) => {
  const cacheKey = 'teams:categories';
  let categories = await cacheOperations.get(cacheKey);

  if (!categories) {
    const pipeline = [
      {
        $match: {
          status: 'active',
          isArchived: false,
          visibility: 'public'
        }
      },
      {
        $group: {
          _id: '$category',
          count: { $sum: 1 }
        }
      },
      {
        $sort: { count: -1 }
      }
    ];

    const results = await Team.aggregate(pipeline);
    
    categories = results.map(result => ({
      category: result._id,
      count: result.count
    }));

    // Cache for 1 hour
    await cacheOperations.set(cacheKey, categories, 3600);
  }

  res.json({
    success: true,
    data: categories
  });
}));

// POST /api/teams - Create a new team
router.post('/', 
  authMiddleware, 
  operationRateLimit('create_team', 5, 3600000), // 5 teams per hour
  createTeamValidation,
  validateRequest,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const userInfo = await getUserInfo(userId, req.user.token);

    const teamData = {
      ...req.body,
      createdBy: userId,
      members: [{
        userId,
        name: userInfo.name,
        email: userInfo.email,
        avatar: userInfo.avatar,
        role: 'owner',
        permissions: {
          canInvite: true,
          canManageTasks: true,
          canManageFiles: true,
          canModerateChat: true
        }
      }]
    };

    // Set default settings based on team type
    if (!teamData.settings) {
      teamData.settings = {
        maxMembers: req.body.maxMembers || 10,
        allowPublicJoin: teamData.visibility === 'public',
        requireApproval: teamData.visibility === 'private'
      };
    }

    const team = new Team(teamData);
    await team.save();

    // Clear user's teams cache
    await cacheOperations.del(`user:${userId}:teams`);
    
    // Clear categories cache
    await cacheOperations.del('teams:categories');

    logHelpers.logTeam('team_created', team._id, userId, {
      teamName: team.name,
      category: team.category,
      visibility: team.visibility
    });

    res.status(201).json({
      success: true,
      data: team,
      message: 'Team created successfully'
    });
  })
);

// GET /api/teams/:teamId - Get team details
router.get('/:teamId', 
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId } = req.params;
    const userId = req.user?.id;

    // Try cache first
    const cacheKey = `team:${teamId}:details`;
    let team = await cacheOperations.get(cacheKey);

    if (!team) {
      team = await Team.findById(teamId);
      
      if (!team) {
        throw createNotFoundError('Team');
      }

      // Cache for 10 minutes
      await cacheOperations.set(cacheKey, team, 600);
    }

    // Check if user can view this team
    if (team.visibility === 'private' && userId) {
      const isMember = team.isMember(userId);
      if (!isMember) {
        throw createAuthError('Access denied. This is a private team.');
      }
    }

    // Remove sensitive information for non-members
    if (!userId || !team.isMember(userId)) {
      team = team.toObject();
      delete team.invitations;
      delete team.settings;
      
      // Limit member information
      team.members = team.members.map(member => ({
        userId: member.userId,
        name: member.name,
        avatar: member.avatar,
        role: member.role,
        joinedAt: member.joinedAt
      }));
    }

    res.json({
      success: true,
      data: team
    });
  })
);

// PUT /api/teams/:teamId - Update team
router.put('/:teamId',
  authMiddleware,
  teamAdminMiddleware,
  updateTeamValidation,
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId } = req.params;
    const userId = req.user.id;

    const team = await Team.findById(teamId);
    if (!team) {
      throw createNotFoundError('Team');
    }

    // Update team fields
    const allowedFields = ['name', 'description', 'category', 'visibility', 'location', 'skills', 'lookingFor', 'tags', 'socialLinks'];
    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        team[field] = req.body[field];
      }
    });

    await team.save();

    // Clear caches
    await cacheOperations.del(`team:${teamId}:details`);
    await cacheOperations.del(`teams:list:*`);

    logHelpers.logTeam('team_updated', teamId, userId, {
      updatedFields: Object.keys(req.body)
    });

    res.json({
      success: true,
      data: team,
      message: 'Team updated successfully'
    });
  })
);

// POST /api/teams/:teamId/join - Join a team
router.post('/:teamId/join',
  authMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  validateRequest,
  operationRateLimit('join_team', 10, 3600000), // 10 joins per hour
  asyncHandler(async (req, res) => {
    const { teamId } = req.params;
    const userId = req.user.id;

    const team = await Team.findById(teamId);
    if (!team) {
      throw createNotFoundError('Team');
    }

    // Check if team is active
    if (team.status !== 'active' || team.isArchived) {
      throw new AppError('This team is not accepting new members', 400, 'TEAM_INACTIVE');
    }

    // Check if user is already a member
    if (team.isMember(userId)) {
      throw new AppError('You are already a member of this team', 400, 'ALREADY_MEMBER');
    }

    // Check team capacity
    if (team.memberCount >= team.settings.maxMembers) {
      throw new AppError('Team has reached maximum capacity', 400, 'TEAM_FULL');
    }

    // Check visibility and join permissions
    if (team.visibility === 'private' || team.visibility === 'invite-only') {
      throw new AppError('This team requires an invitation to join', 403, 'INVITATION_REQUIRED');
    }

    // Get user info and add to team
    const userInfo = await getUserInfo(userId, req.user.token);
    team.addMember({
      userId,
      name: userInfo.name,
      email: userInfo.email,
      avatar: userInfo.avatar
    });

    await team.save();

    // Clear caches
    await cacheOperations.del(`user:${userId}:teams`);
    await cacheOperations.del(`team:${teamId}:details`);
    await cacheOperations.del(`team:${teamId}:member:${userId}`);

    logHelpers.logTeam('user_joined_team', teamId, userId, {
      teamName: team.name,
      memberCount: team.memberCount
    });

    res.json({
      success: true,
      data: team,
      message: 'Successfully joined the team'
    });
  })
);

// POST /api/teams/:teamId/leave - Leave a team
router.post('/:teamId/leave',
  authMiddleware,
  teamMemberMiddleware,
  asyncHandler(async (req, res) => {
    const { teamId } = req.params;
    const userId = req.user.id;

    const team = await Team.findById(teamId);
    if (!team) {
      throw createNotFoundError('Team');
    }

    // Check if user is the owner
    if (team.isOwner(userId)) {
      throw new AppError('Team owner cannot leave the team. Transfer ownership first.', 400, 'OWNER_CANNOT_LEAVE');
    }

    team.removeMember(userId);
    await team.save();

    // Clear caches
    await cacheOperations.del(`user:${userId}:teams`);
    await cacheOperations.del(`team:${teamId}:details`);
    await cacheOperations.del(`team:${teamId}:member:${userId}`);

    logHelpers.logTeam('user_left_team', teamId, userId, {
      teamName: team.name,
      memberCount: team.memberCount
    });

    res.json({
      success: true,
      message: 'Successfully left the team'
    });
  })
);

// DELETE /api/teams/:teamId - Delete/Archive a team
router.delete('/:teamId',
  authMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId } = req.params;
    const userId = req.user.id;

    const team = await Team.findById(teamId);
    if (!team) {
      throw createNotFoundError('Team');
    }

    // Only owner can delete team
    if (!team.isOwner(userId)) {
      throw createAuthError('Only team owner can delete the team');
    }

    // Archive instead of hard delete
    team.isArchived = true;
    team.archivedAt = new Date();
    team.archivedBy = userId;
    team.status = 'inactive';

    await team.save();

    // Clear all related caches
    await cacheOperations.del(`team:${teamId}:details`);
    await cacheOperations.del(`user:${userId}:teams`);
    
    // Clear member caches
    team.members.forEach(async (member) => {
      await cacheOperations.del(`user:${member.userId}:teams`);
      await cacheOperations.del(`team:${teamId}:member:${member.userId}`);
    });

    logHelpers.logTeam('team_archived', teamId, userId, {
      teamName: team.name,
      memberCount: team.memberCount
    });

    res.json({
      success: true,
      message: 'Team archived successfully'
    });
  })
);

// GET /api/teams/:teamId/members - Get team members
router.get('/:teamId/members',
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  validateRequest,
  teamMemberMiddleware,
  asyncHandler(async (req, res) => {
    const { teamId } = req.params;

    const team = await Team.findById(teamId).select('members');
    if (!team) {
      throw createNotFoundError('Team');
    }

    const activeMembers = team.members.filter(member => member.isActive);

    res.json({
      success: true,
      data: activeMembers
    });
  })
);

// PUT /api/teams/:teamId/members/:memberId/role - Update member role
router.put('/:teamId/members/:memberId/role',
  authMiddleware,
  teamAdminMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  body('role').isIn(['member', 'admin']).withMessage('Invalid role'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId, memberId } = req.params;
    const { role } = req.body;
    const userId = req.user.id;

    const team = await Team.findById(teamId);
    if (!team) {
      throw createNotFoundError('Team');
    }

    team.updateMemberRole(memberId, role);
    await team.save();

    // Clear caches
    await cacheOperations.del(`team:${teamId}:details`);
    await cacheOperations.del(`team:${teamId}:member:${memberId}`);
    await cacheOperations.del(`team:${teamId}:admin:${memberId}`);

    logHelpers.logTeam('member_role_updated', teamId, userId, {
      targetUserId: memberId,
      newRole: role
    });

    res.json({
      success: true,
      message: 'Member role updated successfully'
    });
  })
);

// DELETE /api/teams/:teamId/members/:memberId - Remove team member
router.delete('/:teamId/members/:memberId',
  authMiddleware,
  teamAdminMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId, memberId } = req.params;
    const userId = req.user.id;

    const team = await Team.findById(teamId);
    if (!team) {
      throw createNotFoundError('Team');
    }

    // Cannot remove owner
    if (team.isOwner(memberId)) {
      throw new AppError('Cannot remove team owner', 400, 'CANNOT_REMOVE_OWNER');
    }

    team.removeMember(memberId);
    await team.save();

    // Clear caches
    await cacheOperations.del(`team:${teamId}:details`);
    await cacheOperations.del(`team:${teamId}:member:${memberId}`);
    await cacheOperations.del(`user:${memberId}:teams`);

    logHelpers.logTeam('member_removed', teamId, userId, {
      removedUserId: memberId,
      memberCount: team.memberCount
    });

    res.json({
      success: true,
      message: 'Member removed successfully'
    });
  })
);

export default router;

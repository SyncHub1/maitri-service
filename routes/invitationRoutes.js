import express from 'express';
import { body, param, query, validationResult } from 'express-validator';
import { Team } from '../models/Team.js';
import { authMiddleware, teamAdminMiddleware, operationRateLimit } from '../middleware/auth.js';
import { asyncHandler, AppError, createNotFoundError, createValidationError } from '../middleware/errorHandler.js';
import { logger, logHelpers } from '../config/logger.js';
import { cacheOperations } from '../config/redis.js';
import nodemailer from 'nodemailer';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';

const router = express.Router();

// Email transporter configuration
const createEmailTransporter = () => {
  return nodemailer.createTransporter({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD
    }
  });
};

// Validation rules
const inviteUsersValidation = [
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  body('emails')
    .isArray({ min: 1, max: 10 })
    .withMessage('Emails must be an array with 1-10 email addresses'),
  body('emails.*')
    .isEmail()
    .normalizeEmail()
    .withMessage('Invalid email address'),
  body('message')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Message cannot exceed 500 characters')
];

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

// Helper function to search users in auth service
const searchUsersInAuthService = async (query, token) => {
  try {
    const authServiceUrl = process.env.AUTH_SERVICE_URL || 'http://localhost:8000';
    const response = await axios.get(`${authServiceUrl}/auth/users/search`, {
      params: { q: query, limit: 20 },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 5000
    });

    return response.data.users || response.data || [];
  } catch (error) {
    logger.error('❌ Failed to search users in auth service:', error.message);
    
    // Return mock users for development/testing
    const mockUsers = [
      { id: 'user_1', name: 'Alex Johnson', email: 'alex@example.com', avatar: null },
      { id: 'user_2', name: 'Sarah Chen', email: 'sarah@example.com', avatar: null },
      { id: 'user_3', name: 'Mike Rodriguez', email: 'mike@example.com', avatar: null },
      { id: 'user_4', name: 'Emma Wilson', email: 'emma@example.com', avatar: null },
      { id: 'user_5', name: 'David Kim', email: 'david@example.com', avatar: null }
    ];

    return mockUsers.filter(user => 
      user.name.toLowerCase().includes(query.toLowerCase()) ||
      user.email.toLowerCase().includes(query.toLowerCase())
    );
  }
};

// Helper function to send invitation email
const sendInvitationEmail = async (invitation, team, inviterName) => {
  try {
    const transporter = createEmailTransporter();
    
    const inviteUrl = `${process.env.MATRI_FRONTEND_URL || 'http://localhost:5175'}/invite/${invitation.token}`;
    
    const emailTemplate = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Team Invitation - ${team.name}</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
          .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
          .team-info { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #667eea; }
          .button { display: inline-block; background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; }
          .footer { text-align: center; margin-top: 30px; color: #666; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🎉 You're Invited to Join a Team!</h1>
          </div>
          <div class="content">
            <p>Hi there!</p>
            <p><strong>${inviterName}</strong> has invited you to join their team on Synchubb Matri.</p>
            
            <div class="team-info">
              <h3>📋 Team Details</h3>
              <p><strong>Team Name:</strong> ${team.name}</p>
              <p><strong>Category:</strong> ${team.category}</p>
              ${team.description ? `<p><strong>Description:</strong> ${team.description}</p>` : ''}
              ${team.location ? `<p><strong>Location:</strong> ${team.location}</p>` : ''}
              ${team.skills && team.skills.length > 0 ? `<p><strong>Skills:</strong> ${team.skills.join(', ')}</p>` : ''}
            </div>

            <p>Ready to collaborate? Click the button below to accept the invitation:</p>
            
            <div style="text-align: center;">
              <a href="${inviteUrl}" class="button">Accept Invitation</a>
            </div>
            
            <p><small>Or copy and paste this link in your browser: <br>${inviteUrl}</small></p>
            
            <p>This invitation will expire on ${new Date(invitation.expiresAt).toLocaleDateString()}.</p>
            
            <div class="footer">
              <p>Best regards,<br>The Synchubb Matri Team</p>
              <p><small>If you didn't expect this invitation, you can safely ignore this email.</small></p>
            </div>
          </div>
        </div>
      </body>
      </html>
    `;

    const mailOptions = {
      from: `"Synchubb Matri" <${process.env.EMAIL_USER}>`,
      to: invitation.email,
      subject: `You're invited to join "${team.name}" on Synchubb Matri`,
      html: emailTemplate
    };

    await transporter.sendMail(mailOptions);
    return true;
  } catch (error) {
    logger.error('❌ Failed to send invitation email:', error);
    return false;
  }
};

// GET /api/invitations/users/search - Search users for invitations
router.get('/users/search',
  authMiddleware,
  query('q')
    .trim()
    .isLength({ min: 2, max: 50 })
    .withMessage('Search query must be between 2 and 50 characters'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { q: query } = req.query;
    const userId = req.user.id;

    // Try cache first
    const cacheKey = `user_search:${query}`;
    let users = await cacheOperations.get(cacheKey);

    if (!users) {
      users = await searchUsersInAuthService(query, req.user.token);
      
      // Cache results for 5 minutes
      await cacheOperations.set(cacheKey, users, 300);
    }

    // Filter out the current user
    users = users.filter(user => user.id !== userId);

    res.json({
      success: true,
      data: users
    });
  })
);

// POST /api/invitations/:teamId/invite - Send team invitations
router.post('/:teamId/invite',
  authMiddleware,
  teamAdminMiddleware,
  operationRateLimit('send_invitations', 20, 3600000), // 20 invitations per hour
  inviteUsersValidation,
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId } = req.params;
    const { emails, message } = req.body;
    const userId = req.user.id;

    const team = await Team.findById(teamId);
    if (!team) {
      throw createNotFoundError('Team');
    }

    // Check if team has space for new members
    const availableSlots = team.settings.maxMembers - team.memberCount;
    if (availableSlots <= 0) {
      throw new AppError('Team has reached maximum capacity', 400, 'TEAM_FULL');
    }

    if (emails.length > availableSlots) {
      throw new AppError(`Team only has ${availableSlots} available slots`, 400, 'INSUFFICIENT_SLOTS');
    }

    const invitations = [];
    const failedEmails = [];
    const duplicateEmails = [];

    for (const email of emails) {
      // Check if user is already a member
      const existingMember = team.members.find(member => member.email === email);
      if (existingMember) {
        duplicateEmails.push({ email, reason: 'Already a team member' });
        continue;
      }

      // Check if there's already a pending invitation
      const existingInvitation = team.invitations.find(inv => 
        inv.email === email && 
        inv.status === 'pending' && 
        inv.expiresAt > new Date()
      );

      if (existingInvitation) {
        duplicateEmails.push({ email, reason: 'Invitation already sent' });
        continue;
      }

      // Create new invitation
      const invitation = {
        email,
        invitedBy: userId,
        token: uuidv4(),
        status: 'pending',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
      };

      team.invitations.push(invitation);
      invitations.push(invitation);

      // Send invitation email
      const emailSent = await sendInvitationEmail(invitation, team, req.user.name);
      if (!emailSent) {
        failedEmails.push({ email, reason: 'Failed to send email' });
      }
    }

    // Save team with new invitations
    await team.save();

    // Clear team cache
    await cacheOperations.del(`team:${teamId}:details`);

    logHelpers.logTeam('invitations_sent', teamId, userId, {
      invitationCount: invitations.length,
      failedCount: failedEmails.length,
      duplicateCount: duplicateEmails.length
    });

    res.status(201).json({
      success: true,
      data: {
        sent: invitations.length,
        failed: failedEmails,
        duplicates: duplicateEmails
      },
      message: `${invitations.length} invitation(s) sent successfully`
    });
  })
);

// GET /api/invitations/:teamId - Get team invitations
router.get('/:teamId',
  authMiddleware,
  teamAdminMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId } = req.params;
    const { status = 'pending' } = req.query;

    const team = await Team.findById(teamId).select('invitations');
    if (!team) {
      throw createNotFoundError('Team');
    }

    let invitations = team.invitations;

    // Filter by status if specified
    if (status && status !== 'all') {
      invitations = invitations.filter(inv => inv.status === status);
    }

    // Filter out expired invitations for pending status
    if (status === 'pending') {
      invitations = invitations.filter(inv => inv.expiresAt > new Date());
    }

    // Sort by creation date (newest first)
    invitations.sort((a, b) => new Date(b.invitedAt) - new Date(a.invitedAt));

    res.json({
      success: true,
      data: invitations
    });
  })
);

// POST /api/invitations/accept/:token - Accept invitation
router.post('/accept/:token',
  authMiddleware,
  param('token').isUUID().withMessage('Invalid invitation token'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { token } = req.params;
    const userId = req.user.id;
    const userEmail = req.user.email;

    // Find team with this invitation token
    const team = await Team.findOne({
      'invitations.token': token,
      'invitations.status': 'pending',
      'invitations.expiresAt': { $gt: new Date() }
    });

    if (!team) {
      throw createNotFoundError('Invitation not found or expired');
    }

    const invitation = team.invitations.find(inv => inv.token === token);

    // Verify email matches (case insensitive)
    if (invitation.email.toLowerCase() !== userEmail.toLowerCase()) {
      throw new AppError('This invitation was sent to a different email address', 403, 'EMAIL_MISMATCH');
    }

    // Check if user is already a member
    if (team.isMember(userId)) {
      throw new AppError('You are already a member of this team', 400, 'ALREADY_MEMBER');
    }

    // Check team capacity
    if (team.memberCount >= team.settings.maxMembers) {
      throw new AppError('Team has reached maximum capacity', 400, 'TEAM_FULL');
    }

    // Add user to team
    team.addMember({
      userId,
      name: req.user.name,
      email: req.user.email,
      avatar: req.user.avatar
    });

    // Update invitation status
    invitation.status = 'accepted';

    await team.save();

    // Clear caches
    await cacheOperations.del(`user:${userId}:teams`);
    await cacheOperations.del(`team:${team._id}:details`);
    await cacheOperations.del(`team:${team._id}:member:${userId}`);

    logHelpers.logTeam('invitation_accepted', team._id, userId, {
      teamName: team.name,
      invitedBy: invitation.invitedBy,
      memberCount: team.memberCount
    });

    res.json({
      success: true,
      data: team,
      message: 'Successfully joined the team'
    });
  })
);

// POST /api/invitations/decline/:token - Decline invitation
router.post('/decline/:token',
  param('token').isUUID().withMessage('Invalid invitation token'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { token } = req.params;

    // Find team with this invitation token
    const team = await Team.findOne({
      'invitations.token': token,
      'invitations.status': 'pending'
    });

    if (!team) {
      throw createNotFoundError('Invitation not found');
    }

    const invitation = team.invitations.find(inv => inv.token === token);
    invitation.status = 'declined';

    await team.save();

    logHelpers.logTeam('invitation_declined', team._id, 'anonymous', {
      teamName: team.name,
      invitedEmail: invitation.email,
      invitedBy: invitation.invitedBy
    });

    res.json({
      success: true,
      message: 'Invitation declined'
    });
  })
);

// DELETE /api/invitations/:teamId/:invitationId - Cancel invitation
router.delete('/:teamId/:invitationId',
  authMiddleware,
  teamAdminMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId, invitationId } = req.params;
    const userId = req.user.id;

    const team = await Team.findById(teamId);
    if (!team) {
      throw createNotFoundError('Team');
    }

    const invitationIndex = team.invitations.findIndex(inv => 
      inv._id.toString() === invitationId
    );

    if (invitationIndex === -1) {
      throw createNotFoundError('Invitation');
    }

    const invitation = team.invitations[invitationIndex];

    // Only allow canceling pending invitations
    if (invitation.status !== 'pending') {
      throw new AppError('Can only cancel pending invitations', 400, 'INVALID_STATUS');
    }

    // Remove invitation
    team.invitations.splice(invitationIndex, 1);
    await team.save();

    // Clear team cache
    await cacheOperations.del(`team:${teamId}:details`);

    logHelpers.logTeam('invitation_cancelled', teamId, userId, {
      invitedEmail: invitation.email,
      invitationId
    });

    res.json({
      success: true,
      message: 'Invitation cancelled successfully'
    });
  })
);

// POST /api/invitations/:teamId/resend/:invitationId - Resend invitation
router.post('/:teamId/resend/:invitationId',
  authMiddleware,
  teamAdminMiddleware,
  operationRateLimit('resend_invitation', 5, 3600000), // 5 resends per hour
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId, invitationId } = req.params;
    const userId = req.user.id;

    const team = await Team.findById(teamId);
    if (!team) {
      throw createNotFoundError('Team');
    }

    const invitation = team.invitations.find(inv => 
      inv._id.toString() === invitationId
    );

    if (!invitation) {
      throw createNotFoundError('Invitation');
    }

    // Only allow resending pending invitations
    if (invitation.status !== 'pending') {
      throw new AppError('Can only resend pending invitations', 400, 'INVALID_STATUS');
    }

    // Update expiration date
    invitation.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    // Send invitation email
    const emailSent = await sendInvitationEmail(invitation, team, req.user.name);
    
    if (!emailSent) {
      throw new AppError('Failed to send invitation email', 500, 'EMAIL_SEND_FAILED');
    }

    await team.save();

    logHelpers.logTeam('invitation_resent', teamId, userId, {
      invitedEmail: invitation.email,
      invitationId
    });

    res.json({
      success: true,
      message: 'Invitation resent successfully'
    });
  })
);

// GET /api/invitations/my - Get user's pending invitations
router.get('/my',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const userEmail = req.user.email;

    // Find all teams with pending invitations for this user
    const teams = await Team.find({
      'invitations.email': userEmail,
      'invitations.status': 'pending',
      'invitations.expiresAt': { $gt: new Date() }
    }).select('name description category location skills invitations createdAt');

    const invitations = [];

    teams.forEach(team => {
      const userInvitations = team.invitations.filter(inv => 
        inv.email === userEmail && 
        inv.status === 'pending' && 
        inv.expiresAt > new Date()
      );

      userInvitations.forEach(invitation => {
        invitations.push({
          invitationId: invitation._id,
          token: invitation.token,
          team: {
            id: team._id,
            name: team.name,
            description: team.description,
            category: team.category,
            location: team.location,
            skills: team.skills,
            createdAt: team.createdAt
          },
          invitedAt: invitation.invitedAt,
          expiresAt: invitation.expiresAt
        });
      });
    });

    // Sort by invitation date (newest first)
    invitations.sort((a, b) => new Date(b.invitedAt) - new Date(a.invitedAt));

    res.json({
      success: true,
      data: invitations
    });
  })
);

export default router;

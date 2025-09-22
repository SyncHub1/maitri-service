import express from 'express';
import { body, param, query, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import { authMiddleware, teamMemberMiddleware, operationRateLimit } from '../middleware/auth.js';
import { asyncHandler, AppError, createNotFoundError } from '../middleware/errorHandler.js';
import { logger, logHelpers } from '../config/logger.js';
import { cacheOperations, pubSubOperations } from '../config/redis.js';
import { Team } from '../models/Team.js';

const router = express.Router();

// Video Call Session Schema
const videoCallSchema = new mongoose.Schema({
  teamId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Team',
    required: true,
    index: true
  },
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 200
  },
  description: {
    type: String,
    trim: true,
    maxlength: 1000
  },
  status: {
    type: String,
    enum: ['scheduled', 'active', 'ended', 'cancelled'],
    default: 'scheduled',
    index: true
  },
  type: {
    type: String,
    enum: ['meeting', 'standup', 'presentation', 'brainstorm', 'interview'],
    default: 'meeting'
  },
  participants: [{
    userId: {
      type: String,
      required: true
    },
    userName: {
      type: String,
      required: true
    },
    role: {
      type: String,
      enum: ['host', 'moderator', 'participant'],
      default: 'participant'
    },
    joinedAt: Date,
    leftAt: Date,
    duration: Number, // in minutes
    isAudioEnabled: {
      type: Boolean,
      default: true
    },
    isVideoEnabled: {
      type: Boolean,
      default: true
    },
    isScreenSharing: {
      type: Boolean,
      default: false
    }
  }],
  settings: {
    maxParticipants: {
      type: Number,
      default: 10,
      min: 2,
      max: 50
    },
    requireApproval: {
      type: Boolean,
      default: false
    },
    allowScreenShare: {
      type: Boolean,
      default: true
    },
    allowRecording: {
      type: Boolean,
      default: false
    },
    muteOnJoin: {
      type: Boolean,
      default: false
    },
    waitingRoom: {
      type: Boolean,
      default: false
    }
  },
  scheduledAt: {
    type: Date,
    index: true
  },
  startedAt: Date,
  endedAt: Date,
  duration: Number, // in minutes
  recordingUrl: String,
  createdBy: {
    userId: {
      type: String,
      required: true
    },
    userName: {
      type: String,
      required: true
    }
  },
  agenda: [{
    id: String,
    title: String,
    duration: Number,
    completed: {
      type: Boolean,
      default: false
    }
  }],
  notes: {
    type: String,
    maxlength: 5000
  },
  actionItems: [{
    id: String,
    description: String,
    assignedTo: String,
    dueDate: Date,
    completed: {
      type: Boolean,
      default: false
    }
  }]
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes
videoCallSchema.index({ teamId: 1, scheduledAt: -1 });
videoCallSchema.index({ teamId: 1, status: 1 });
videoCallSchema.index({ 'participants.userId': 1 });

// Virtuals
videoCallSchema.virtual('participantCount').get(function() {
  return this.participants ? this.participants.length : 0;
});

videoCallSchema.virtual('activeParticipants').get(function() {
  if (!this.participants) return [];
  return this.participants.filter(p => p.joinedAt && !p.leftAt);
});

const VideoCall = mongoose.model('VideoCall', videoCallSchema);

// Validation rules
const createCallValidation = [
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  body('title').trim().isLength({ min: 1, max: 200 }).withMessage('Title must be between 1 and 200 characters'),
  body('scheduledAt').optional().isISO8601().withMessage('Invalid scheduled date'),
  body('type').optional().isIn(['meeting', 'standup', 'presentation', 'brainstorm', 'interview']).withMessage('Invalid call type')
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

// GET /api/video/:teamId - Get team video calls
router.get('/:teamId',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId } = req.params;
    const {
      page = 1,
      limit = 20,
      status,
      type,
      upcoming = false
    } = req.query;

    const pageNum = parseInt(page);
    const limitNum = Math.min(parseInt(limit), 100);
    const skip = (pageNum - 1) * limitNum;

    const query = { teamId: new mongoose.Types.ObjectId(teamId) };

    if (status) {
      query.status = status;
    }

    if (type) {
      query.type = type;
    }

    if (upcoming === 'true') {
      query.scheduledAt = { $gte: new Date() };
      query.status = { $in: ['scheduled', 'active'] };
    }

    const calls = await VideoCall.find(query)
      .sort({ scheduledAt: -1 })
      .limit(limitNum)
      .skip(skip);

    const total = await VideoCall.countDocuments(query);

    res.json({
      success: true,
      data: calls,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });
  })
);

// POST /api/video/:teamId - Create/Schedule video call
router.post('/:teamId',
  authMiddleware,
  teamMemberMiddleware,
  operationRateLimit('create_video_call', 10, 3600000),
  createCallValidation,
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId } = req.params;
    const userId = req.user.id;

    const callData = {
      ...req.body,
      teamId,
      createdBy: {
        userId,
        userName: req.user.name
      },
      participants: [{
        userId,
        userName: req.user.name,
        role: 'host'
      }]
    };

    // If no scheduled time, start immediately
    if (!callData.scheduledAt) {
      callData.scheduledAt = new Date();
      callData.status = 'active';
      callData.startedAt = new Date();
    }

    const videoCall = new VideoCall(callData);
    await videoCall.save();

    // Update team stats
    await Team.findByIdAndUpdate(teamId, {
      $inc: { 'stats.totalMeetings': 1 }
    });

    // Publish call creation to real-time subscribers
    await pubSubOperations.publish(`team:${teamId}:video`, {
      type: 'call_created',
      data: videoCall
    });

    logHelpers.logCollaboration('video_call_created', teamId, userId, 'video', {
      callId: videoCall._id,
      callTitle: videoCall.title,
      scheduledAt: videoCall.scheduledAt
    });

    res.status(201).json({
      success: true,
      data: videoCall,
      message: 'Video call created successfully'
    });
  })
);

// GET /api/video/:teamId/:callId - Get video call details
router.get('/:teamId/:callId',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  param('callId').isMongoId().withMessage('Invalid call ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId, callId } = req.params;

    const videoCall = await VideoCall.findOne({
      _id: callId,
      teamId
    });

    if (!videoCall) {
      throw createNotFoundError('Video Call');
    }

    res.json({
      success: true,
      data: videoCall
    });
  })
);

// POST /api/video/:teamId/:callId/join - Join video call
router.post('/:teamId/:callId/join',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  param('callId').isMongoId().withMessage('Invalid call ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId, callId } = req.params;
    const userId = req.user.id;

    const videoCall = await VideoCall.findOne({
      _id: callId,
      teamId
    });

    if (!videoCall) {
      throw createNotFoundError('Video Call');
    }

    if (videoCall.status === 'ended' || videoCall.status === 'cancelled') {
      throw new AppError('This call has ended', 400, 'CALL_ENDED');
    }

    // Check if user is already a participant
    let participant = videoCall.participants.find(p => p.userId === userId);

    if (!participant) {
      // Check participant limit
      const activeParticipants = videoCall.participants.filter(p => p.joinedAt && !p.leftAt);
      if (activeParticipants.length >= videoCall.settings.maxParticipants) {
        throw new AppError('Call has reached maximum participants', 400, 'CALL_FULL');
      }

      // Add new participant
      participant = {
        userId,
        userName: req.user.name,
        role: 'participant',
        joinedAt: new Date()
      };
      videoCall.participants.push(participant);
    } else {
      // Rejoin existing participant
      participant.joinedAt = new Date();
      participant.leftAt = undefined;
    }

    // Start call if it's scheduled and this is the first join
    if (videoCall.status === 'scheduled') {
      videoCall.status = 'active';
      videoCall.startedAt = new Date();
    }

    await videoCall.save();

    // Publish join event to real-time subscribers
    await pubSubOperations.publish(`team:${teamId}:video:${callId}`, {
      type: 'participant_joined',
      data: {
        participant: {
          userId,
          userName: req.user.name,
          joinedAt: participant.joinedAt
        }
      }
    });

    logHelpers.logCollaboration('video_call_joined', teamId, userId, 'video', {
      callId: videoCall._id
    });

    res.json({
      success: true,
      data: {
        call: videoCall,
        participant
      },
      message: 'Joined video call successfully'
    });
  })
);

// POST /api/video/:teamId/:callId/leave - Leave video call
router.post('/:teamId/:callId/leave',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  param('callId').isMongoId().withMessage('Invalid call ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId, callId } = req.params;
    const userId = req.user.id;

    const videoCall = await VideoCall.findOne({
      _id: callId,
      teamId
    });

    if (!videoCall) {
      throw createNotFoundError('Video Call');
    }

    const participant = videoCall.participants.find(p => p.userId === userId);
    if (!participant) {
      throw new AppError('You are not a participant in this call', 400, 'NOT_PARTICIPANT');
    }

    // Mark participant as left
    participant.leftAt = new Date();
    if (participant.joinedAt) {
      participant.duration = Math.round((participant.leftAt - participant.joinedAt) / (1000 * 60));
    }

    // Check if all participants have left
    const activeParticipants = videoCall.participants.filter(p => p.joinedAt && !p.leftAt);
    if (activeParticipants.length === 0 && videoCall.status === 'active') {
      videoCall.status = 'ended';
      videoCall.endedAt = new Date();
      if (videoCall.startedAt) {
        videoCall.duration = Math.round((videoCall.endedAt - videoCall.startedAt) / (1000 * 60));
        
        // Update team stats
        await Team.findByIdAndUpdate(teamId, {
          $inc: { 'stats.totalMeetingMinutes': videoCall.duration }
        });
      }
    }

    await videoCall.save();

    // Publish leave event to real-time subscribers
    await pubSubOperations.publish(`team:${teamId}:video:${callId}`, {
      type: 'participant_left',
      data: {
        userId,
        userName: req.user.name,
        leftAt: participant.leftAt
      }
    });

    res.json({
      success: true,
      message: 'Left video call successfully'
    });
  })
);

// POST /api/video/:teamId/:callId/end - End video call
router.post('/:teamId/:callId/end',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  param('callId').isMongoId().withMessage('Invalid call ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId, callId } = req.params;
    const userId = req.user.id;

    const videoCall = await VideoCall.findOne({
      _id: callId,
      teamId
    });

    if (!videoCall) {
      throw createNotFoundError('Video Call');
    }

    // Check if user can end the call (host or moderator)
    const participant = videoCall.participants.find(p => p.userId === userId);
    if (!participant || (participant.role !== 'host' && participant.role !== 'moderator')) {
      throw new AppError('Only hosts and moderators can end the call', 403, 'INSUFFICIENT_PERMISSIONS');
    }

    if (videoCall.status === 'ended') {
      throw new AppError('Call has already ended', 400, 'CALL_ALREADY_ENDED');
    }

    // End the call
    videoCall.status = 'ended';
    videoCall.endedAt = new Date();

    // Calculate duration and update participant times
    if (videoCall.startedAt) {
      videoCall.duration = Math.round((videoCall.endedAt - videoCall.startedAt) / (1000 * 60));
      
      // Update team stats
      await Team.findByIdAndUpdate(teamId, {
        $inc: { 'stats.totalMeetingMinutes': videoCall.duration }
      });
    }

    // Mark all active participants as left
    videoCall.participants.forEach(p => {
      if (p.joinedAt && !p.leftAt) {
        p.leftAt = videoCall.endedAt;
        if (p.joinedAt) {
          p.duration = Math.round((p.leftAt - p.joinedAt) / (1000 * 60));
        }
      }
    });

    await videoCall.save();

    // Publish call end event to real-time subscribers
    await pubSubOperations.publish(`team:${teamId}:video:${callId}`, {
      type: 'call_ended',
      data: {
        endedBy: userId,
        endedAt: videoCall.endedAt,
        duration: videoCall.duration
      }
    });

    logHelpers.logCollaboration('video_call_ended', teamId, userId, 'video', {
      callId: videoCall._id,
      duration: videoCall.duration
    });

    res.json({
      success: true,
      data: videoCall,
      message: 'Video call ended successfully'
    });
  })
);

// POST /api/video/:teamId/:callId/signaling - Handle WebRTC signaling
router.post('/:teamId/:callId/signaling',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  param('callId').isMongoId().withMessage('Invalid call ID'),
  body('type').isIn(['offer', 'answer', 'ice-candidate']).withMessage('Invalid signaling type'),
  body('targetUserId').optional().isString().withMessage('Target user ID must be a string'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId, callId } = req.params;
    const { type, payload, targetUserId } = req.body;
    const userId = req.user.id;

    const videoCall = await VideoCall.findOne({
      _id: callId,
      teamId
    });

    if (!videoCall) {
      throw createNotFoundError('Video Call');
    }

    // Check if user is a participant
    const participant = videoCall.participants.find(p => p.userId === userId);
    if (!participant) {
      throw new AppError('You are not a participant in this call', 403, 'NOT_PARTICIPANT');
    }

    const signalingData = {
      type,
      payload,
      fromUserId: userId,
      fromUserName: req.user.name,
      timestamp: new Date()
    };

    // Send signaling data to specific user or broadcast to all participants
    if (targetUserId) {
      await pubSubOperations.publish(`team:${teamId}:video:${callId}:user:${targetUserId}`, {
        type: 'webrtc_signaling',
        data: signalingData
      });
    } else {
      await pubSubOperations.publish(`team:${teamId}:video:${callId}`, {
        type: 'webrtc_signaling',
        data: signalingData
      });
    }

    res.json({
      success: true,
      message: 'Signaling data sent successfully'
    });
  })
);

// PUT /api/video/:teamId/:callId/participant - Update participant status
router.put('/:teamId/:callId/participant',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  param('callId').isMongoId().withMessage('Invalid call ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId, callId } = req.params;
    const { isAudioEnabled, isVideoEnabled, isScreenSharing } = req.body;
    const userId = req.user.id;

    const videoCall = await VideoCall.findOne({
      _id: callId,
      teamId
    });

    if (!videoCall) {
      throw createNotFoundError('Video Call');
    }

    const participant = videoCall.participants.find(p => p.userId === userId);
    if (!participant) {
      throw new AppError('You are not a participant in this call', 400, 'NOT_PARTICIPANT');
    }

    // Update participant status
    if (typeof isAudioEnabled === 'boolean') {
      participant.isAudioEnabled = isAudioEnabled;
    }
    if (typeof isVideoEnabled === 'boolean') {
      participant.isVideoEnabled = isVideoEnabled;
    }
    if (typeof isScreenSharing === 'boolean') {
      participant.isScreenSharing = isScreenSharing;
    }

    await videoCall.save();

    // Publish participant update to real-time subscribers
    await pubSubOperations.publish(`team:${teamId}:video:${callId}`, {
      type: 'participant_updated',
      data: {
        userId,
        userName: req.user.name,
        isAudioEnabled: participant.isAudioEnabled,
        isVideoEnabled: participant.isVideoEnabled,
        isScreenSharing: participant.isScreenSharing
      }
    });

    res.json({
      success: true,
      data: participant,
      message: 'Participant status updated successfully'
    });
  })
);

export default router;

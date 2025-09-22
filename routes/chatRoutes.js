import express from 'express';
import { body, param, query, validationResult } from 'express-validator';
import { ChatMessage } from '../models/Chat.js';
import { Team } from '../models/Team.js';
import { authMiddleware, teamMemberMiddleware, operationRateLimit } from '../middleware/auth.js';
import { asyncHandler, AppError, createNotFoundError } from '../middleware/errorHandler.js';
import { logger, logHelpers } from '../config/logger.js';
import { cacheOperations, pubSubOperations } from '../config/redis.js';
import multer from 'multer';
// Mock cloudinary service for development
const mockCloudinaryService = {
  uploadFile: async (file) => ({
    secure_url: `http://localhost:3003/uploads/${file.originalname}`,
    public_id: `mock_${Date.now()}`
  }),
  deleteFile: async () => true
};

// Use mock service for now - will be replaced with actual shared-utils integration
const cloudinaryService = mockCloudinaryService;

const router = express.Router();

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
    files: 5
  },
  fileFilter: (req, file, cb) => {
    // Allow images, videos, audio, and documents
    const allowedTypes = /jpeg|jpg|png|gif|webp|mp4|mov|avi|mp3|wav|pdf|doc|docx|txt|zip/;
    const extname = allowedTypes.test(file.originalname.toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Invalid file type'));
    }
  }
});

// Validation rules
const sendMessageValidation = [
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  body('message')
    .trim()
    .isLength({ min: 1, max: 4000 })
    .withMessage('Message must be between 1 and 4000 characters'),
  body('type')
    .optional()
    .isIn(['text', 'image', 'video', 'audio', 'file', 'code'])
    .withMessage('Invalid message type'),
  body('replyTo')
    .optional()
    .isMongoId()
    .withMessage('Invalid reply message ID')
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

// Helper function to process file attachments
const processAttachments = async (files) => {
  if (!files || files.length === 0) return [];

  const attachments = [];

  for (const file of files) {
    try {
      let uploadResult;
      const fileType = file.mimetype.split('/')[0];

      // Upload to Cloudinary based on file type
      switch (fileType) {
        case 'image':
          uploadResult = await cloudinaryService.uploadImage(file.buffer, {
            mimetype: file.mimetype,
            folder: 'matri/chat/images'
          });
          break;
        case 'video':
          uploadResult = await cloudinaryService.uploadVideo(file.buffer, {
            mimetype: file.mimetype,
            folder: 'matri/chat/videos'
          });
          break;
        case 'audio':
          uploadResult = await cloudinaryService.uploadAudio(file.buffer, {
            mimetype: file.mimetype,
            folder: 'matri/chat/audio'
          });
          break;
        default:
          // For documents and other files, upload as raw
          uploadResult = await cloudinaryService.uploadImage(file.buffer, {
            mimetype: file.mimetype,
            folder: 'matri/chat/files',
            resource_type: 'raw'
          });
      }

      if (uploadResult.success) {
        attachments.push({
          type: fileType === 'application' ? 'document' : fileType,
          url: uploadResult.url,
          name: file.originalname,
          size: file.size,
          mimeType: file.mimetype,
          thumbnail: uploadResult.thumbnail,
          duration: uploadResult.duration,
          dimensions: uploadResult.width && uploadResult.height ? {
            width: uploadResult.width,
            height: uploadResult.height
          } : undefined
        });
      }
    } catch (error) {
      logger.error('❌ Error uploading file attachment:', error);
      // Continue with other files, don't fail the entire message
    }
  }

  return attachments;
};

// Helper function to extract mentions from message
const extractMentions = (message) => {
  const mentionRegex = /@(\w+)/g;
  const mentions = [];
  let match;

  while ((match = mentionRegex.exec(message)) !== null) {
    mentions.push({
      userName: match[1],
      startIndex: match.index,
      endIndex: match.index + match[0].length
    });
  }

  return mentions;
};

// GET /api/chat/:teamId/messages - Get chat messages for a team
router.get('/:teamId/messages',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId } = req.params;
    const {
      page = 1,
      limit = 50,
      type,
      userId,
      startDate,
      endDate,
      search
    } = req.query;

    const pageNum = parseInt(page);
    const limitNum = Math.min(parseInt(limit), 100); // Max 100 messages per request
    const skip = (pageNum - 1) * limitNum;

    // Try cache first for recent messages
    if (pageNum === 1 && !type && !userId && !startDate && !endDate && !search) {
      const cacheKey = `team:${teamId}:recent_messages`;
      const cachedMessages = await cacheOperations.get(cacheKey);
      
      if (cachedMessages && cachedMessages.length > 0) {
        return res.json({
          success: true,
          data: cachedMessages.slice(0, limitNum),
          pagination: {
            page: pageNum,
            limit: limitNum,
            hasMore: cachedMessages.length > limitNum
          }
        });
      }
    }

    let messages;

    if (search) {
      // Search messages
      messages = await ChatMessage.searchMessages(teamId, search, {
        limit: limitNum,
        skip,
        userId,
        startDate,
        endDate
      });
    } else {
      // Get messages with filters
      messages = await ChatMessage.findByTeam(teamId, {
        limit: limitNum,
        skip,
        messageType: type,
        userId,
        startDate,
        endDate
      });
    }

    // Mark messages as read for the requesting user
    const unreadMessages = messages.filter(msg => 
      !msg.readBy.some(read => read.userId === req.user.id)
    );

    if (unreadMessages.length > 0) {
      await Promise.all(unreadMessages.map(async (msg) => {
        msg.markAsRead(req.user.id);
        await msg.save();
      }));
    }

    res.json({
      success: true,
      data: messages,
      pagination: {
        page: pageNum,
        limit: limitNum,
        hasMore: messages.length === limitNum
      }
    });
  })
);

// POST /api/chat/:teamId/messages - Send a message
router.post('/:teamId/messages',
  authMiddleware,
  teamMemberMiddleware,
  operationRateLimit('send_message', 60, 60000), // 60 messages per minute
  upload.array('attachments', 5),
  sendMessageValidation,
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId } = req.params;
    const { message, type = 'text', replyTo } = req.body;
    const userId = req.user.id;

    // Process file attachments if any
    const attachments = await processAttachments(req.files);

    // Extract mentions from message
    const mentions = extractMentions(message);

    // Create message data
    const messageData = {
      teamId,
      userId,
      userName: req.user.name,
      userAvatar: req.user.avatar,
      message,
      type: attachments.length > 0 ? attachments[0].type : type,
      attachments,
      mentions,
      metadata: {
        platform: 'web',
        ipAddress: req.ip,
        userAgent: req.get('User-Agent')
      }
    };

    // Handle reply
    if (replyTo) {
      const replyMessage = await ChatMessage.findById(replyTo);
      if (replyMessage && replyMessage.teamId.toString() === teamId) {
        messageData.replyTo = {
          messageId: replyMessage._id,
          userId: replyMessage.userId,
          userName: replyMessage.userName,
          message: replyMessage.message.substring(0, 100), // Truncate for preview
          createdAt: replyMessage.createdAt
        };
      }
    }

    // Create and save message
    const chatMessage = new ChatMessage(messageData);
    await chatMessage.save();

    // Update team stats
    await Team.findByIdAndUpdate(teamId, {
      $inc: { 'stats.totalMessages': 1 }
    });

    // Publish message to real-time subscribers
    await pubSubOperations.publish(`team:${teamId}:chat`, {
      type: 'new_message',
      data: chatMessage
    });

    // Update recent messages cache
    const cacheKey = `team:${teamId}:recent_messages`;
    const recentMessages = await cacheOperations.get(cacheKey) || [];
    recentMessages.unshift(chatMessage);
    
    // Keep only last 50 messages in cache
    if (recentMessages.length > 50) {
      recentMessages.splice(50);
    }
    
    await cacheOperations.set(cacheKey, recentMessages, 3600); // 1 hour TTL

    logHelpers.logCollaboration('message_sent', teamId, userId, 'chat', {
      messageId: chatMessage._id,
      messageType: type,
      hasAttachments: attachments.length > 0,
      mentionCount: mentions.length
    });

    res.status(201).json({
      success: true,
      data: chatMessage,
      message: 'Message sent successfully'
    });
  })
);

// PUT /api/chat/:teamId/messages/:messageId - Edit a message
router.put('/:teamId/messages/:messageId',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  param('messageId').isMongoId().withMessage('Invalid message ID'),
  body('message')
    .trim()
    .isLength({ min: 1, max: 4000 })
    .withMessage('Message must be between 1 and 4000 characters'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId, messageId } = req.params;
    const { message } = req.body;
    const userId = req.user.id;

    const chatMessage = await ChatMessage.findOne({
      _id: messageId,
      teamId,
      isDeleted: false
    });

    if (!chatMessage) {
      throw createNotFoundError('Message');
    }

    // Only message author can edit (within 24 hours)
    if (chatMessage.userId !== userId) {
      throw new AppError('You can only edit your own messages', 403, 'NOT_MESSAGE_AUTHOR');
    }

    const hoursSinceCreated = (Date.now() - chatMessage.createdAt.getTime()) / (1000 * 60 * 60);
    if (hoursSinceCreated > 24) {
      throw new AppError('Messages can only be edited within 24 hours', 400, 'EDIT_TIME_EXPIRED');
    }

    // Store original message in edit history
    if (!chatMessage.editHistory) {
      chatMessage.editHistory = [];
    }
    chatMessage.editHistory.push({
      message: chatMessage.message,
      editedAt: new Date()
    });

    // Update message
    chatMessage.message = message;
    chatMessage.mentions = extractMentions(message);
    chatMessage.isEdited = true;
    chatMessage.editedAt = new Date();

    await chatMessage.save();

    // Publish update to real-time subscribers
    await pubSubOperations.publish(`team:${teamId}:chat`, {
      type: 'message_edited',
      data: chatMessage
    });

    // Update cache
    const cacheKey = `team:${teamId}:recent_messages`;
    const recentMessages = await cacheOperations.get(cacheKey);
    if (recentMessages) {
      const messageIndex = recentMessages.findIndex(msg => msg._id.toString() === messageId);
      if (messageIndex !== -1) {
        recentMessages[messageIndex] = chatMessage;
        await cacheOperations.set(cacheKey, recentMessages, 3600);
      }
    }

    logHelpers.logCollaboration('message_edited', teamId, userId, 'chat', {
      messageId: chatMessage._id
    });

    res.json({
      success: true,
      data: chatMessage,
      message: 'Message updated successfully'
    });
  })
);

// DELETE /api/chat/:teamId/messages/:messageId - Delete a message
router.delete('/:teamId/messages/:messageId',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  param('messageId').isMongoId().withMessage('Invalid message ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId, messageId } = req.params;
    const userId = req.user.id;

    const chatMessage = await ChatMessage.findOne({
      _id: messageId,
      teamId,
      isDeleted: false
    });

    if (!chatMessage) {
      throw createNotFoundError('Message');
    }

    // Check permissions - message author or team admin
    const team = await Team.findById(teamId);
    const canDelete = chatMessage.userId === userId || team.isAdmin(userId);

    if (!canDelete) {
      throw new AppError('You can only delete your own messages or need admin privileges', 403, 'INSUFFICIENT_PERMISSIONS');
    }

    // Soft delete the message
    chatMessage.softDelete(userId);
    await chatMessage.save();

    // Publish deletion to real-time subscribers
    await pubSubOperations.publish(`team:${teamId}:chat`, {
      type: 'message_deleted',
      data: { messageId, deletedBy: userId }
    });

    // Update cache
    const cacheKey = `team:${teamId}:recent_messages`;
    const recentMessages = await cacheOperations.get(cacheKey);
    if (recentMessages) {
      const messageIndex = recentMessages.findIndex(msg => msg._id.toString() === messageId);
      if (messageIndex !== -1) {
        recentMessages[messageIndex] = chatMessage;
        await cacheOperations.set(cacheKey, recentMessages, 3600);
      }
    }

    logHelpers.logCollaboration('message_deleted', teamId, userId, 'chat', {
      messageId: chatMessage._id,
      deletedBy: userId
    });

    res.json({
      success: true,
      message: 'Message deleted successfully'
    });
  })
);

// POST /api/chat/:teamId/messages/:messageId/reactions - Add reaction to message
router.post('/:teamId/messages/:messageId/reactions',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  param('messageId').isMongoId().withMessage('Invalid message ID'),
  body('emoji')
    .trim()
    .isLength({ min: 1, max: 10 })
    .withMessage('Emoji must be between 1 and 10 characters'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId, messageId } = req.params;
    const { emoji } = req.body;
    const userId = req.user.id;

    const chatMessage = await ChatMessage.findOne({
      _id: messageId,
      teamId,
      isDeleted: false
    });

    if (!chatMessage) {
      throw createNotFoundError('Message');
    }

    const added = chatMessage.addReaction(emoji, userId, req.user.name);
    
    if (!added) {
      throw new AppError('You have already reacted with this emoji', 400, 'ALREADY_REACTED');
    }

    await chatMessage.save();

    // Publish reaction to real-time subscribers
    await pubSubOperations.publish(`team:${teamId}:chat`, {
      type: 'reaction_added',
      data: {
        messageId,
        emoji,
        userId,
        userName: req.user.name
      }
    });

    res.json({
      success: true,
      data: chatMessage.reactionSummary,
      message: 'Reaction added successfully'
    });
  })
);

// DELETE /api/chat/:teamId/messages/:messageId/reactions/:emoji - Remove reaction
router.delete('/:teamId/messages/:messageId/reactions/:emoji',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  param('messageId').isMongoId().withMessage('Invalid message ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId, messageId, emoji } = req.params;
    const userId = req.user.id;

    const chatMessage = await ChatMessage.findOne({
      _id: messageId,
      teamId,
      isDeleted: false
    });

    if (!chatMessage) {
      throw createNotFoundError('Message');
    }

    const removed = chatMessage.removeReaction(decodeURIComponent(emoji), userId);
    
    if (!removed) {
      throw createNotFoundError('Reaction');
    }

    await chatMessage.save();

    // Publish reaction removal to real-time subscribers
    await pubSubOperations.publish(`team:${teamId}:chat`, {
      type: 'reaction_removed',
      data: {
        messageId,
        emoji: decodeURIComponent(emoji),
        userId
      }
    });

    res.json({
      success: true,
      data: chatMessage.reactionSummary,
      message: 'Reaction removed successfully'
    });
  })
);

// POST /api/chat/:teamId/messages/:messageId/pin - Pin a message
router.post('/:teamId/messages/:messageId/pin',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  param('messageId').isMongoId().withMessage('Invalid message ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId, messageId } = req.params;
    const userId = req.user.id;

    // Check if user has permission to pin messages
    const team = await Team.findById(teamId);
    const member = team.members.find(m => m.userId === userId);
    
    if (!member || (!member.permissions.canModerateChat && !team.isAdmin(userId))) {
      throw new AppError('You do not have permission to pin messages', 403, 'INSUFFICIENT_PERMISSIONS');
    }

    const chatMessage = await ChatMessage.findOne({
      _id: messageId,
      teamId,
      isDeleted: false
    });

    if (!chatMessage) {
      throw createNotFoundError('Message');
    }

    if (chatMessage.isPinned) {
      throw new AppError('Message is already pinned', 400, 'ALREADY_PINNED');
    }

    chatMessage.pin(userId);
    await chatMessage.save();

    // Publish pin event to real-time subscribers
    await pubSubOperations.publish(`team:${teamId}:chat`, {
      type: 'message_pinned',
      data: {
        messageId,
        pinnedBy: userId
      }
    });

    logHelpers.logCollaboration('message_pinned', teamId, userId, 'chat', {
      messageId: chatMessage._id
    });

    res.json({
      success: true,
      data: chatMessage,
      message: 'Message pinned successfully'
    });
  })
);

// DELETE /api/chat/:teamId/messages/:messageId/pin - Unpin a message
router.delete('/:teamId/messages/:messageId/pin',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  param('messageId').isMongoId().withMessage('Invalid message ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId, messageId } = req.params;
    const userId = req.user.id;

    // Check permissions
    const team = await Team.findById(teamId);
    const member = team.members.find(m => m.userId === userId);
    
    if (!member || (!member.permissions.canModerateChat && !team.isAdmin(userId))) {
      throw new AppError('You do not have permission to unpin messages', 403, 'INSUFFICIENT_PERMISSIONS');
    }

    const chatMessage = await ChatMessage.findOne({
      _id: messageId,
      teamId,
      isDeleted: false
    });

    if (!chatMessage) {
      throw createNotFoundError('Message');
    }

    if (!chatMessage.isPinned) {
      throw new AppError('Message is not pinned', 400, 'NOT_PINNED');
    }

    chatMessage.unpin();
    await chatMessage.save();

    // Publish unpin event to real-time subscribers
    await pubSubOperations.publish(`team:${teamId}:chat`, {
      type: 'message_unpinned',
      data: {
        messageId,
        unpinnedBy: userId
      }
    });

    res.json({
      success: true,
      message: 'Message unpinned successfully'
    });
  })
);

// GET /api/chat/:teamId/pinned - Get pinned messages
router.get('/:teamId/pinned',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId } = req.params;

    const pinnedMessages = await ChatMessage.findPinnedMessages(teamId);

    res.json({
      success: true,
      data: pinnedMessages
    });
  })
);

// GET /api/chat/:teamId/stats - Get chat statistics
router.get('/:teamId/stats',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId } = req.params;
    const { startDate, endDate } = req.query;

    const stats = await ChatMessage.getMessageStats(teamId, startDate, endDate);

    res.json({
      success: true,
      data: stats[0] || {
        totalMessages: 0,
        uniqueUsers: 0,
        messagesByType: [],
        messagesByDay: []
      }
    });
  })
);

export default router;

import jwt from 'jsonwebtoken';
import { logger, logHelpers } from './logger.js';
import { cacheOperations, pubSubOperations } from './redis.js';

// Socket.IO event handlers
const socketHandlers = {
  // Handle user connection
  handleConnection: async (socket, io) => {
    try {
      const { userId, teamId } = socket.handshake.auth;
      
      if (!userId) {
        logger.warn('Socket connection rejected: No user ID provided');
        socket.disconnect();
        return;
      }

      // Store user info in socket
      socket.userId = userId;
      socket.teamId = teamId;

      // Join user to their personal room
      socket.join(`user:${userId}`);
      
      // Join team room if teamId is provided
      if (teamId) {
        socket.join(`team:${teamId}`);
        
        // Notify team members about user joining
        socket.to(`team:${teamId}`).emit('user:joined', {
          userId,
          timestamp: new Date().toISOString()
        });
      }

      // Update user online status
      await cacheOperations.set(`user:${userId}:online`, true, 300); // 5 minutes TTL
      await cacheOperations.set(`user:${userId}:lastSeen`, new Date().toISOString(), 86400); // 24 hours TTL

      logHelpers.logCollaboration('user_connected', teamId, userId, 'socket', {
        socketId: socket.id
      });

      logger.info(`✅ User ${userId} connected to socket ${socket.id}`);

      // Send connection confirmation
      socket.emit('connection:confirmed', {
        userId,
        socketId: socket.id,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('❌ Error handling socket connection:', error);
      socket.disconnect();
    }
  },

  // Handle user disconnection
  handleDisconnection: async (socket, io) => {
    try {
      const { userId, teamId } = socket;

      if (userId) {
        // Update user offline status
        await cacheOperations.del(`user:${userId}:online`);
        await cacheOperations.set(`user:${userId}:lastSeen`, new Date().toISOString(), 86400);

        // Notify team members about user leaving
        if (teamId) {
          socket.to(`team:${teamId}`).emit('user:left', {
            userId,
            timestamp: new Date().toISOString()
          });
        }

        logHelpers.logCollaboration('user_disconnected', teamId, userId, 'socket', {
          socketId: socket.id
        });

        logger.info(`👋 User ${userId} disconnected from socket ${socket.id}`);
      }
    } catch (error) {
      logger.error('❌ Error handling socket disconnection:', error);
    }
  },

  // Handle team joining
  handleJoinTeam: async (socket, data) => {
    try {
      const { teamId } = data;
      const { userId } = socket;

      if (!teamId || !userId) {
        socket.emit('error', { message: 'Team ID and User ID are required' });
        return;
      }

      // Leave previous team room if any
      if (socket.teamId) {
        socket.leave(`team:${socket.teamId}`);
        socket.to(`team:${socket.teamId}`).emit('user:left', {
          userId,
          timestamp: new Date().toISOString()
        });
      }

      // Join new team room
      socket.join(`team:${teamId}`);
      socket.teamId = teamId;

      // Notify team members
      socket.to(`team:${teamId}`).emit('user:joined', {
        userId,
        timestamp: new Date().toISOString()
      });

      // Send confirmation
      socket.emit('team:joined', {
        teamId,
        timestamp: new Date().toISOString()
      });

      logHelpers.logTeam('user_joined_team', teamId, userId);

    } catch (error) {
      logger.error('❌ Error handling team join:', error);
      socket.emit('error', { message: 'Failed to join team' });
    }
  },

  // Handle team leaving
  handleLeaveTeam: async (socket, data) => {
    try {
      const { teamId } = data;
      const { userId } = socket;

      if (!teamId || !userId) {
        socket.emit('error', { message: 'Team ID and User ID are required' });
        return;
      }

      // Leave team room
      socket.leave(`team:${teamId}`);
      
      // Notify team members
      socket.to(`team:${teamId}`).emit('user:left', {
        userId,
        timestamp: new Date().toISOString()
      });

      // Clear team ID from socket
      socket.teamId = null;

      // Send confirmation
      socket.emit('team:left', {
        teamId,
        timestamp: new Date().toISOString()
      });

      logHelpers.logTeam('user_left_team', teamId, userId);

    } catch (error) {
      logger.error('❌ Error handling team leave:', error);
      socket.emit('error', { message: 'Failed to leave team' });
    }
  },

  // Handle chat messages
  handleChatMessage: async (socket, data) => {
    try {
      const { teamId, message, type = 'text' } = data;
      const { userId } = socket;

      if (!teamId || !message || !userId) {
        socket.emit('error', { message: 'Team ID, message, and User ID are required' });
        return;
      }

      const messageData = {
        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        teamId,
        userId,
        message,
        type,
        timestamp: new Date().toISOString()
      };

      // Broadcast message to team members
      socket.to(`team:${teamId}`).emit('chat:message', messageData);

      // Send confirmation to sender
      socket.emit('chat:message:sent', messageData);

      // Cache recent messages
      const cacheKey = `team:${teamId}:recent_messages`;
      const recentMessages = await cacheOperations.get(cacheKey) || [];
      recentMessages.push(messageData);
      
      // Keep only last 50 messages in cache
      if (recentMessages.length > 50) {
        recentMessages.splice(0, recentMessages.length - 50);
      }
      
      await cacheOperations.set(cacheKey, recentMessages, 3600); // 1 hour TTL

      logHelpers.logCollaboration('chat_message', teamId, userId, 'chat', {
        messageId: messageData.id,
        messageType: type
      });

    } catch (error) {
      logger.error('❌ Error handling chat message:', error);
      socket.emit('error', { message: 'Failed to send message' });
    }
  },

  // Handle typing indicators
  handleTyping: async (socket, data) => {
    try {
      const { teamId, isTyping } = data;
      const { userId } = socket;

      if (!teamId || !userId) {
        return;
      }

      // Broadcast typing status to team members
      socket.to(`team:${teamId}`).emit('chat:typing', {
        userId,
        isTyping,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('❌ Error handling typing indicator:', error);
    }
  },

  // Handle IDE collaboration
  handleIDEOperation: async (socket, data) => {
    try {
      const { teamId, operation, fileId, content, cursor } = data;
      const { userId } = socket;

      if (!teamId || !operation || !userId) {
        socket.emit('error', { message: 'Team ID, operation, and User ID are required' });
        return;
      }

      const operationData = {
        id: `op_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        teamId,
        userId,
        operation,
        fileId,
        content,
        cursor,
        timestamp: new Date().toISOString()
      };

      // Broadcast operation to team members
      socket.to(`team:${teamId}`).emit('ide:operation', operationData);

      // Cache recent operations for conflict resolution
      const cacheKey = `team:${teamId}:ide_operations`;
      const recentOps = await cacheOperations.get(cacheKey) || [];
      recentOps.push(operationData);
      
      // Keep only last 100 operations in cache
      if (recentOps.length > 100) {
        recentOps.splice(0, recentOps.length - 100);
      }
      
      await cacheOperations.set(cacheKey, recentOps, 1800); // 30 minutes TTL

      logHelpers.logCollaboration('ide_operation', teamId, userId, 'ide', {
        operationId: operationData.id,
        operation,
        fileId
      });

    } catch (error) {
      logger.error('❌ Error handling IDE operation:', error);
      socket.emit('error', { message: 'Failed to process IDE operation' });
    }
  },

  // Handle whiteboard operations
  handleWhiteboardOperation: async (socket, data) => {
    try {
      const { teamId, operation, elementId, elementData } = data;
      const { userId } = socket;

      if (!teamId || !operation || !userId) {
        socket.emit('error', { message: 'Team ID, operation, and User ID are required' });
        return;
      }

      const operationData = {
        id: `wb_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        teamId,
        userId,
        operation,
        elementId,
        elementData,
        timestamp: new Date().toISOString()
      };

      // Broadcast operation to team members
      socket.to(`team:${teamId}`).emit('whiteboard:operation', operationData);

      // Cache whiteboard state
      const cacheKey = `team:${teamId}:whiteboard_state`;
      const currentState = await cacheOperations.get(cacheKey) || { elements: [] };
      
      // Apply operation to state (simplified)
      if (operation === 'create' || operation === 'update') {
        const existingIndex = currentState.elements.findIndex(el => el.id === elementId);
        if (existingIndex >= 0) {
          currentState.elements[existingIndex] = elementData;
        } else {
          currentState.elements.push(elementData);
        }
      } else if (operation === 'delete') {
        currentState.elements = currentState.elements.filter(el => el.id !== elementId);
      }
      
      await cacheOperations.set(cacheKey, currentState, 3600); // 1 hour TTL

      logHelpers.logCollaboration('whiteboard_operation', teamId, userId, 'whiteboard', {
        operationId: operationData.id,
        operation,
        elementId
      });

    } catch (error) {
      logger.error('❌ Error handling whiteboard operation:', error);
      socket.emit('error', { message: 'Failed to process whiteboard operation' });
    }
  },

  // Handle video call signaling
  handleVideoSignaling: async (socket, data) => {
    try {
      const { teamId, type, targetUserId, payload } = data;
      const { userId } = socket;

      if (!teamId || !type || !userId) {
        socket.emit('error', { message: 'Team ID, type, and User ID are required' });
        return;
      }

      const signalingData = {
        teamId,
        fromUserId: userId,
        type,
        payload,
        timestamp: new Date().toISOString()
      };

      if (targetUserId) {
        // Send to specific user
        socket.to(`user:${targetUserId}`).emit('video:signaling', signalingData);
      } else {
        // Broadcast to all team members
        socket.to(`team:${teamId}`).emit('video:signaling', signalingData);
      }

      logHelpers.logCollaboration('video_signaling', teamId, userId, 'video', {
        signalingType: type,
        targetUserId
      });

    } catch (error) {
      logger.error('❌ Error handling video signaling:', error);
      socket.emit('error', { message: 'Failed to process video signaling' });
    }
  }
};

// Setup Socket.IO with authentication and event handlers
const setupSocketIO = (io) => {
  // Authentication middleware
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      
      if (!token) {
        return next(new Error('Authentication token required'));
      }

      // Verify JWT token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.userId || decoded.id;
      
      next();
    } catch (error) {
      logger.error('❌ Socket authentication failed:', error);
      next(new Error('Authentication failed'));
    }
  });

  // Connection handler
  io.on('connection', (socket) => {
    socketHandlers.handleConnection(socket, io);

    // Event handlers
    socket.on('team:join', (data) => socketHandlers.handleJoinTeam(socket, data));
    socket.on('team:leave', (data) => socketHandlers.handleLeaveTeam(socket, data));
    socket.on('chat:message', (data) => socketHandlers.handleChatMessage(socket, data));
    socket.on('chat:typing', (data) => socketHandlers.handleTyping(socket, data));
    socket.on('ide:operation', (data) => socketHandlers.handleIDEOperation(socket, data));
    socket.on('whiteboard:operation', (data) => socketHandlers.handleWhiteboardOperation(socket, data));
    socket.on('video:signaling', (data) => socketHandlers.handleVideoSignaling(socket, data));

    // Disconnection handler
    socket.on('disconnect', () => socketHandlers.handleDisconnection(socket, io));
  });

  logger.info('✅ Socket.IO configured with authentication and event handlers');
};

export { setupSocketIO, socketHandlers };

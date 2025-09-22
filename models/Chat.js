import mongoose from 'mongoose';

const { Schema } = mongoose;

// Message reaction schema
const reactionSchema = new Schema({
  emoji: {
    type: String,
    required: true,
    maxlength: [10, 'Emoji cannot exceed 10 characters']
  },
  userId: {
    type: String,
    required: true
  },
  userName: {
    type: String,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  _id: false
});

// Message attachment schema
const attachmentSchema = new Schema({
  type: {
    type: String,
    enum: ['image', 'video', 'audio', 'document', 'code', 'link'],
    required: true
  },
  url: {
    type: String,
    required: true
  },
  name: {
    type: String,
    required: true
  },
  size: {
    type: Number,
    min: 0
  },
  mimeType: {
    type: String
  },
  thumbnail: {
    type: String // For images and videos
  },
  duration: {
    type: Number // For audio and video files
  },
  dimensions: {
    width: Number,
    height: Number
  }
}, {
  _id: false
});

// Message mention schema
const mentionSchema = new Schema({
  userId: {
    type: String,
    required: true
  },
  userName: {
    type: String,
    required: true
  },
  startIndex: {
    type: Number,
    required: true
  },
  endIndex: {
    type: Number,
    required: true
  }
}, {
  _id: false
});

// Chat message schema
const chatMessageSchema = new Schema({
  teamId: {
    type: Schema.Types.ObjectId,
    ref: 'Team',
    required: true,
    index: true
  },
  userId: {
    type: String,
    required: true,
    index: true
  },
  userName: {
    type: String,
    required: true
  },
  userAvatar: {
    type: String,
    default: null
  },
  message: {
    type: String,
    required: true,
    maxlength: [4000, 'Message cannot exceed 4000 characters']
  },
  type: {
    type: String,
    enum: ['text', 'image', 'video', 'audio', 'file', 'code', 'system'],
    default: 'text',
    index: true
  },
  attachments: [attachmentSchema],
  mentions: [mentionSchema],
  reactions: [reactionSchema],
  replyTo: {
    messageId: {
      type: Schema.Types.ObjectId,
      ref: 'ChatMessage'
    },
    userId: String,
    userName: String,
    message: String,
    createdAt: Date
  },
  isEdited: {
    type: Boolean,
    default: false
  },
  editedAt: {
    type: Date,
    default: null
  },
  editHistory: [{
    message: String,
    editedAt: {
      type: Date,
      default: Date.now
    }
  }],
  isDeleted: {
    type: Boolean,
    default: false,
    index: true
  },
  deletedAt: {
    type: Date,
    default: null
  },
  deletedBy: {
    type: String,
    default: null
  },
  isPinned: {
    type: Boolean,
    default: false
  },
  pinnedAt: {
    type: Date,
    default: null
  },
  pinnedBy: {
    type: String,
    default: null
  },
  metadata: {
    platform: {
      type: String,
      default: 'web'
    },
    ipAddress: String,
    userAgent: String,
    language: String
  },
  readBy: [{
    userId: {
      type: String,
      required: true
    },
    readAt: {
      type: Date,
      default: Date.now
    }
  }],
  deliveredTo: [{
    userId: {
      type: String,
      required: true
    },
    deliveredAt: {
      type: Date,
      default: Date.now
    }
  }]
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes for better query performance
chatMessageSchema.index({ teamId: 1, createdAt: -1 });
chatMessageSchema.index({ userId: 1, createdAt: -1 });
chatMessageSchema.index({ teamId: 1, type: 1, createdAt: -1 });
chatMessageSchema.index({ teamId: 1, isPinned: 1, createdAt: -1 });
chatMessageSchema.index({ teamId: 1, isDeleted: 1, createdAt: -1 });
chatMessageSchema.index({ message: 'text' });

// Virtual for reaction count
chatMessageSchema.virtual('reactionCount').get(function() {
  return this.reactions ? this.reactions.length : 0;
});

// Virtual for unique reaction types
chatMessageSchema.virtual('reactionSummary').get(function() {
  if (!this.reactions || this.reactions.length === 0) return {};
  
  const summary = {};
  this.reactions.forEach(reaction => {
    if (!summary[reaction.emoji]) {
      summary[reaction.emoji] = {
        count: 0,
        users: []
      };
    }
    summary[reaction.emoji].count++;
    summary[reaction.emoji].users.push({
      userId: reaction.userId,
      userName: reaction.userName
    });
  });
  
  return summary;
});

// Virtual for read status
chatMessageSchema.virtual('isRead').get(function() {
  // This would be set dynamically based on the requesting user
  return this._isRead || false;
});

// Pre-save middleware
chatMessageSchema.pre('save', function(next) {
  // Update edit timestamp if message is being edited
  if (this.isModified('message') && !this.isNew) {
    this.isEdited = true;
    this.editedAt = new Date();
    
    // Add to edit history
    if (!this.editHistory) {
      this.editHistory = [];
    }
    this.editHistory.push({
      message: this.message,
      editedAt: new Date()
    });
  }

  next();
});

// Instance methods
chatMessageSchema.methods.addReaction = function(emoji, userId, userName) {
  // Check if user already reacted with this emoji
  const existingReaction = this.reactions.find(r => 
    r.emoji === emoji && r.userId === userId
  );

  if (existingReaction) {
    return false; // Already reacted
  }

  this.reactions.push({
    emoji,
    userId,
    userName,
    createdAt: new Date()
  });

  return true;
};

chatMessageSchema.methods.removeReaction = function(emoji, userId) {
  const reactionIndex = this.reactions.findIndex(r => 
    r.emoji === emoji && r.userId === userId
  );

  if (reactionIndex === -1) {
    return false; // Reaction not found
  }

  this.reactions.splice(reactionIndex, 1);
  return true;
};

chatMessageSchema.methods.markAsRead = function(userId) {
  // Check if already marked as read by this user
  const existingRead = this.readBy.find(r => r.userId === userId);
  
  if (existingRead) {
    existingRead.readAt = new Date();
  } else {
    this.readBy.push({
      userId,
      readAt: new Date()
    });
  }
};

chatMessageSchema.methods.markAsDelivered = function(userId) {
  // Check if already marked as delivered to this user
  const existingDelivery = this.deliveredTo.find(d => d.userId === userId);
  
  if (!existingDelivery) {
    this.deliveredTo.push({
      userId,
      deliveredAt: new Date()
    });
  }
};

chatMessageSchema.methods.softDelete = function(deletedBy) {
  this.isDeleted = true;
  this.deletedAt = new Date();
  this.deletedBy = deletedBy;
  this.message = '[This message was deleted]';
  this.attachments = [];
};

chatMessageSchema.methods.pin = function(pinnedBy) {
  this.isPinned = true;
  this.pinnedAt = new Date();
  this.pinnedBy = pinnedBy;
};

chatMessageSchema.methods.unpin = function() {
  this.isPinned = false;
  this.pinnedAt = null;
  this.pinnedBy = null;
};

// Static methods
chatMessageSchema.statics.findByTeam = function(teamId, options = {}) {
  const {
    limit = 50,
    skip = 0,
    includeDeleted = false,
    messageType = null,
    userId = null,
    startDate = null,
    endDate = null
  } = options;

  const query = { teamId };

  if (!includeDeleted) {
    query.isDeleted = false;
  }

  if (messageType) {
    query.type = messageType;
  }

  if (userId) {
    query.userId = userId;
  }

  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) query.createdAt.$gte = new Date(startDate);
    if (endDate) query.createdAt.$lte = new Date(endDate);
  }

  return this.find(query)
    .sort({ createdAt: -1 })
    .limit(limit)
    .skip(skip)
    .populate('replyTo.messageId', 'message userName createdAt');
};

chatMessageSchema.statics.findPinnedMessages = function(teamId) {
  return this.find({
    teamId,
    isPinned: true,
    isDeleted: false
  }).sort({ pinnedAt: -1 });
};

chatMessageSchema.statics.searchMessages = function(teamId, searchTerm, options = {}) {
  const {
    limit = 20,
    skip = 0,
    userId = null,
    startDate = null,
    endDate = null
  } = options;

  const query = {
    teamId,
    isDeleted: false,
    $text: { $search: searchTerm }
  };

  if (userId) {
    query.userId = userId;
  }

  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) query.createdAt.$gte = new Date(startDate);
    if (endDate) query.createdAt.$lte = new Date(endDate);
  }

  return this.find(query, { score: { $meta: 'textScore' } })
    .sort({ score: { $meta: 'textScore' }, createdAt: -1 })
    .limit(limit)
    .skip(skip);
};

chatMessageSchema.statics.getMessageStats = function(teamId, startDate, endDate) {
  const matchStage = {
    teamId: new mongoose.Types.ObjectId(teamId),
    isDeleted: false
  };

  if (startDate || endDate) {
    matchStage.createdAt = {};
    if (startDate) matchStage.createdAt.$gte = new Date(startDate);
    if (endDate) matchStage.createdAt.$lte = new Date(endDate);
  }

  return this.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: null,
        totalMessages: { $sum: 1 },
        totalUsers: { $addToSet: '$userId' },
        messagesByType: {
          $push: {
            type: '$type',
            count: 1
          }
        },
        messagesByDay: {
          $push: {
            date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            count: 1
          }
        }
      }
    },
    {
      $project: {
        totalMessages: 1,
        uniqueUsers: { $size: '$totalUsers' },
        messagesByType: 1,
        messagesByDay: 1
      }
    }
  ]);
};

const ChatMessage = mongoose.model('ChatMessage', chatMessageSchema);

export { ChatMessage };

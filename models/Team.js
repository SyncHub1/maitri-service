import mongoose from 'mongoose';

const { Schema } = mongoose;

// Team member schema
const teamMemberSchema = new Schema({
  userId: {
    type: String,
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true
  },
  email: {
    type: String,
    required: true
  },
  avatar: {
    type: String,
    default: null
  },
  role: {
    type: String,
    enum: ['member', 'admin', 'owner'],
    default: 'member'
  },
  joinedAt: {
    type: Date,
    default: Date.now
  },
  permissions: {
    canInvite: {
      type: Boolean,
      default: false
    },
    canManageTasks: {
      type: Boolean,
      default: false
    },
    canManageFiles: {
      type: Boolean,
      default: false
    },
    canModerateChat: {
      type: Boolean,
      default: false
    }
  },
  isActive: {
    type: Boolean,
    default: true
  },
  lastActive: {
    type: Date,
    default: Date.now
  }
}, {
  _id: false
});

// Team invitation schema
const invitationSchema = new Schema({
  email: {
    type: String,
    required: true
  },
  invitedBy: {
    type: String,
    required: true
  },
  invitedAt: {
    type: Date,
    default: Date.now
  },
  status: {
    type: String,
    enum: ['pending', 'accepted', 'declined', 'expired'],
    default: 'pending'
  },
  token: {
    type: String,
    required: true,
    unique: true
  },
  expiresAt: {
    type: Date,
    required: true,
    default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
  }
}, {
  _id: false
});

// Team settings schema
const teamSettingsSchema = new Schema({
  allowPublicJoin: {
    type: Boolean,
    default: true
  },
  requireApproval: {
    type: Boolean,
    default: false
  },
  maxMembers: {
    type: Number,
    default: 10,
    min: 1,
    max: 100
  },
  allowGuestAccess: {
    type: Boolean,
    default: false
  },
  chatRetentionDays: {
    type: Number,
    default: 30,
    min: 1,
    max: 365
  },
  fileStorageLimit: {
    type: Number,
    default: 1024, // MB
    min: 100,
    max: 10240
  },
  enableVideoCall: {
    type: Boolean,
    default: true
  },
  enableScreenShare: {
    type: Boolean,
    default: true
  },
  enableWhiteboard: {
    type: Boolean,
    default: true
  },
  enableIDE: {
    type: Boolean,
    default: true
  }
}, {
  _id: false
});

// Main team schema
const teamSchema = new Schema({
  name: {
    type: String,
    required: [true, 'Team name is required'],
    trim: true,
    minlength: [2, 'Team name must be at least 2 characters'],
    maxlength: [100, 'Team name cannot exceed 100 characters'],
    index: true
  },
  description: {
    type: String,
    trim: true,
    maxlength: [1000, 'Description cannot exceed 1000 characters']
  },
  category: {
    type: String,
    required: [true, 'Team category is required'],
    enum: [
      'Web Development',
      'Mobile Apps',
      'AI/ML',
      'Blockchain',
      'IoT',
      'Game Development',
      'Design',
      'Data Science',
      'DevOps',
      'Cybersecurity',
      'Other'
    ],
    index: true
  },
  visibility: {
    type: String,
    enum: ['public', 'private', 'invite-only'],
    default: 'public',
    index: true
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'archived'],
    default: 'active',
    index: true
  },
  location: {
    type: String,
    trim: true,
    maxlength: [100, 'Location cannot exceed 100 characters']
  },
  timezone: {
    type: String,
    default: 'UTC'
  },
  skills: [{
    type: String,
    trim: true,
    maxlength: [50, 'Skill name cannot exceed 50 characters']
  }],
  lookingFor: [{
    type: String,
    trim: true,
    maxlength: [50, 'Role name cannot exceed 50 characters']
  }],
  tags: [{
    type: String,
    trim: true,
    lowercase: true,
    maxlength: [30, 'Tag cannot exceed 30 characters']
  }],
  members: [teamMemberSchema],
  invitations: [invitationSchema],
  settings: {
    type: teamSettingsSchema,
    default: () => ({})
  },
  createdBy: {
    type: String,
    required: true,
    index: true
  },
  avatar: {
    type: String,
    default: null
  },
  banner: {
    type: String,
    default: null
  },
  socialLinks: {
    website: String,
    github: String,
    linkedin: String,
    twitter: String,
    discord: String,
    slack: String
  },
  stats: {
    totalMessages: {
      type: Number,
      default: 0
    },
    totalFiles: {
      type: Number,
      default: 0
    },
    totalTasks: {
      type: Number,
      default: 0
    },
    completedTasks: {
      type: Number,
      default: 0
    },
    totalMeetings: {
      type: Number,
      default: 0
    },
    totalMeetingMinutes: {
      type: Number,
      default: 0
    }
  },
  isArchived: {
    type: Boolean,
    default: false,
    index: true
  },
  archivedAt: {
    type: Date,
    default: null
  },
  archivedBy: {
    type: String,
    default: null
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes for better query performance
teamSchema.index({ name: 'text', description: 'text', skills: 'text' });
teamSchema.index({ category: 1, visibility: 1, status: 1 });
teamSchema.index({ createdBy: 1, createdAt: -1 });
teamSchema.index({ 'members.userId': 1 });
teamSchema.index({ 'invitations.email': 1, 'invitations.status': 1 });

// Virtual for member count
teamSchema.virtual('memberCount').get(function() {
  return this.members ? this.members.filter(member => member.isActive).length : 0;
});

// Virtual for admin count
teamSchema.virtual('adminCount').get(function() {
  return this.members ? this.members.filter(member => 
    member.isActive && (member.role === 'admin' || member.role === 'owner')
  ).length : 0;
});

// Virtual for pending invitations count
teamSchema.virtual('pendingInvitationsCount').get(function() {
  return this.invitations ? this.invitations.filter(inv => 
    inv.status === 'pending' && inv.expiresAt > new Date()
  ).length : 0;
});

// Pre-save middleware
teamSchema.pre('save', function(next) {
  // Ensure creator is in members list as owner
  if (this.isNew) {
    const creatorExists = this.members.some(member => member.userId === this.createdBy);
    if (!creatorExists) {
      // Note: In a real implementation, you'd fetch user details from auth service
      this.members.push({
        userId: this.createdBy,
        name: 'Team Creator',
        email: 'creator@example.com',
        role: 'owner',
        permissions: {
          canInvite: true,
          canManageTasks: true,
          canManageFiles: true,
          canModerateChat: true
        }
      });
    }
  }

  // Clean up expired invitations
  if (this.invitations) {
    this.invitations = this.invitations.filter(inv => 
      inv.status !== 'pending' || inv.expiresAt > new Date()
    );
  }

  next();
});

// Instance methods
teamSchema.methods.addMember = function(userInfo) {
  const existingMember = this.members.find(member => member.userId === userInfo.userId);
  
  if (existingMember) {
    if (!existingMember.isActive) {
      existingMember.isActive = true;
      existingMember.joinedAt = new Date();
    }
    return existingMember;
  }

  const newMember = {
    userId: userInfo.userId,
    name: userInfo.name,
    email: userInfo.email,
    avatar: userInfo.avatar,
    role: 'member'
  };

  this.members.push(newMember);
  return newMember;
};

teamSchema.methods.removeMember = function(userId) {
  const memberIndex = this.members.findIndex(member => member.userId === userId);
  
  if (memberIndex === -1) {
    return false;
  }

  // Don't allow removing the owner
  if (this.members[memberIndex].role === 'owner') {
    throw new Error('Cannot remove team owner');
  }

  this.members.splice(memberIndex, 1);
  return true;
};

teamSchema.methods.updateMemberRole = function(userId, newRole) {
  const member = this.members.find(member => member.userId === userId);
  
  if (!member) {
    throw new Error('Member not found');
  }

  // Don't allow changing owner role
  if (member.role === 'owner' || newRole === 'owner') {
    throw new Error('Cannot change owner role');
  }

  member.role = newRole;
  
  // Update permissions based on role
  if (newRole === 'admin') {
    member.permissions = {
      canInvite: true,
      canManageTasks: true,
      canManageFiles: true,
      canModerateChat: true
    };
  } else {
    member.permissions = {
      canInvite: false,
      canManageTasks: false,
      canManageFiles: false,
      canModerateChat: false
    };
  }

  return member;
};

teamSchema.methods.isMember = function(userId) {
  return this.members.some(member => member.userId === userId && member.isActive);
};

teamSchema.methods.isAdmin = function(userId) {
  const member = this.members.find(member => member.userId === userId && member.isActive);
  return member && (member.role === 'admin' || member.role === 'owner');
};

teamSchema.methods.isOwner = function(userId) {
  return this.createdBy === userId || this.members.some(member => 
    member.userId === userId && member.role === 'owner' && member.isActive
  );
};

// Static methods
teamSchema.statics.findByMember = function(userId) {
  return this.find({
    'members.userId': userId,
    'members.isActive': true,
    isArchived: false
  });
};

teamSchema.statics.findPublicTeams = function(filters = {}) {
  const query = {
    visibility: 'public',
    status: 'active',
    isArchived: false,
    ...filters
  };
  
  return this.find(query).sort({ createdAt: -1 });
};

teamSchema.statics.searchTeams = function(searchTerm, filters = {}) {
  const query = {
    $text: { $search: searchTerm },
    visibility: 'public',
    status: 'active',
    isArchived: false,
    ...filters
  };
  
  return this.find(query, { score: { $meta: 'textScore' } })
    .sort({ score: { $meta: 'textScore' } });
};

const Team = mongoose.model('Team', teamSchema);

export { Team };

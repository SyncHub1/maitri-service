import express from 'express';
import { body, param, query, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import { authMiddleware, teamMemberMiddleware, operationRateLimit } from '../middleware/auth.js';
import { asyncHandler, AppError, createNotFoundError } from '../middleware/errorHandler.js';
import { logger, logHelpers } from '../config/logger.js';
import { cacheOperations, pubSubOperations } from '../config/redis.js';
import { Team } from '../models/Team.js';

const router = express.Router();

// Task Schema
const taskSchema = new mongoose.Schema({
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
    maxlength: 2000
  },
  status: {
    type: String,
    enum: ['todo', 'in-progress', 'review', 'completed', 'cancelled'],
    default: 'todo',
    index: true
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium',
    index: true
  },
  assignedTo: [{
    userId: {
      type: String,
      required: true
    },
    userName: {
      type: String,
      required: true
    },
    assignedAt: {
      type: Date,
      default: Date.now
    }
  }],
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
  tags: [{
    type: String,
    trim: true,
    lowercase: true,
    maxlength: 30
  }],
  dueDate: {
    type: Date,
    index: true
  },
  estimatedHours: {
    type: Number,
    min: 0,
    max: 1000
  },
  actualHours: {
    type: Number,
    min: 0,
    default: 0
  },
  attachments: [{
    name: String,
    url: String,
    type: String,
    size: Number,
    uploadedBy: String,
    uploadedAt: {
      type: Date,
      default: Date.now
    }
  }],
  comments: [{
    userId: {
      type: String,
      required: true
    },
    userName: {
      type: String,
      required: true
    },
    comment: {
      type: String,
      required: true,
      maxlength: 1000
    },
    createdAt: {
      type: Date,
      default: Date.now
    },
    isEdited: {
      type: Boolean,
      default: false
    },
    editedAt: Date
  }],
  checklist: [{
    id: {
      type: String,
      required: true
    },
    text: {
      type: String,
      required: true,
      maxlength: 200
    },
    completed: {
      type: Boolean,
      default: false
    },
    completedBy: String,
    completedAt: Date
  }],
  dependencies: [{
    taskId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Task'
    },
    type: {
      type: String,
      enum: ['blocks', 'blocked-by', 'related'],
      default: 'related'
    }
  }],
  timeTracking: [{
    userId: String,
    userName: String,
    startTime: Date,
    endTime: Date,
    duration: Number, // in minutes
    description: String,
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  completedAt: Date,
  completedBy: {
    userId: String,
    userName: String
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes
taskSchema.index({ teamId: 1, status: 1, createdAt: -1 });
taskSchema.index({ teamId: 1, 'assignedTo.userId': 1 });
taskSchema.index({ teamId: 1, priority: 1, dueDate: 1 });
taskSchema.index({ title: 'text', description: 'text' });

// Virtuals
taskSchema.virtual('isOverdue').get(function() {
  return this.dueDate && this.dueDate < new Date() && this.status !== 'completed' && this.status !== 'cancelled';
});

taskSchema.virtual('completionPercentage').get(function() {
  if (!this.checklist || this.checklist.length === 0) {
    return this.status === 'completed' ? 100 : 0;
  }
  
  const completedItems = this.checklist.filter(item => item.completed).length;
  return Math.round((completedItems / this.checklist.length) * 100);
});

const Task = mongoose.model('Task', taskSchema);

// Validation rules
const createTaskValidation = [
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  body('title')
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('Title must be between 1 and 200 characters'),
  body('description')
    .optional()
    .trim()
    .isLength({ max: 2000 })
    .withMessage('Description cannot exceed 2000 characters'),
  body('priority')
    .optional()
    .isIn(['low', 'medium', 'high', 'urgent'])
    .withMessage('Invalid priority'),
  body('assignedTo')
    .optional()
    .isArray()
    .withMessage('Assigned to must be an array'),
  body('dueDate')
    .optional()
    .isISO8601()
    .withMessage('Invalid due date format'),
  body('estimatedHours')
    .optional()
    .isFloat({ min: 0, max: 1000 })
    .withMessage('Estimated hours must be between 0 and 1000'),
  body('tags')
    .optional()
    .isArray()
    .withMessage('Tags must be an array')
];

const updateTaskValidation = [
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  param('taskId').isMongoId().withMessage('Invalid task ID'),
  body('title')
    .optional()
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('Title must be between 1 and 200 characters'),
  body('description')
    .optional()
    .trim()
    .isLength({ max: 2000 })
    .withMessage('Description cannot exceed 2000 characters'),
  body('status')
    .optional()
    .isIn(['todo', 'in-progress', 'review', 'completed', 'cancelled'])
    .withMessage('Invalid status'),
  body('priority')
    .optional()
    .isIn(['low', 'medium', 'high', 'urgent'])
    .withMessage('Invalid priority')
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

// Helper function to check task permissions
const checkTaskPermissions = async (teamId, userId, action = 'read') => {
  const team = await Team.findById(teamId);
  if (!team) {
    throw createNotFoundError('Team');
  }

  const member = team.members.find(m => m.userId === userId && m.isActive);
  if (!member) {
    throw new AppError('You are not a member of this team', 403, 'NOT_TEAM_MEMBER');
  }

  // Check specific permissions for task management
  if (action === 'manage' && !member.permissions.canManageTasks && !team.isAdmin(userId)) {
    throw new AppError('You do not have permission to manage tasks', 403, 'INSUFFICIENT_PERMISSIONS');
  }

  return { team, member };
};

// GET /api/tasks/:teamId - Get team tasks
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
      priority,
      assignedTo,
      search,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      dueDate,
      overdue
    } = req.query;

    const pageNum = parseInt(page);
    const limitNum = Math.min(parseInt(limit), 100);
    const skip = (pageNum - 1) * limitNum;

    // Build query
    const query = { teamId: new mongoose.Types.ObjectId(teamId) };

    if (status) {
      query.status = status;
    }

    if (priority) {
      query.priority = priority;
    }

    if (assignedTo) {
      query['assignedTo.userId'] = assignedTo;
    }

    if (dueDate) {
      const date = new Date(dueDate);
      query.dueDate = {
        $gte: new Date(date.setHours(0, 0, 0, 0)),
        $lt: new Date(date.setHours(23, 59, 59, 999))
      };
    }

    if (overdue === 'true') {
      query.dueDate = { $lt: new Date() };
      query.status = { $nin: ['completed', 'cancelled'] };
    }

    // Handle search
    let tasks;
    if (search) {
      query.$text = { $search: search };
      tasks = await Task.find(query, { score: { $meta: 'textScore' } })
        .sort({ score: { $meta: 'textScore' } })
        .limit(limitNum)
        .skip(skip);
    } else {
      const sortObj = {};
      sortObj[sortBy] = sortOrder === 'desc' ? -1 : 1;

      tasks = await Task.find(query)
        .sort(sortObj)
        .limit(limitNum)
        .skip(skip);
    }

    const total = await Task.countDocuments(query);

    res.json({
      success: true,
      data: tasks,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });
  })
);

// POST /api/tasks/:teamId - Create a new task
router.post('/:teamId',
  authMiddleware,
  operationRateLimit('create_task', 50, 3600000), // 50 tasks per hour
  createTaskValidation,
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId } = req.params;
    const userId = req.user.id;

    await checkTaskPermissions(teamId, userId, 'manage');

    const taskData = {
      ...req.body,
      teamId,
      createdBy: {
        userId,
        userName: req.user.name
      }
    };

    // Process assigned users
    if (req.body.assignedTo && req.body.assignedTo.length > 0) {
      const team = await Team.findById(teamId);
      taskData.assignedTo = req.body.assignedTo.map(assigneeId => {
        const member = team.members.find(m => m.userId === assigneeId);
        return {
          userId: assigneeId,
          userName: member ? member.name : 'Unknown User'
        };
      });
    }

    const task = new Task(taskData);
    await task.save();

    // Update team stats
    await Team.findByIdAndUpdate(teamId, {
      $inc: { 'stats.totalTasks': 1 }
    });

    // Publish task creation to real-time subscribers
    await pubSubOperations.publish(`team:${teamId}:tasks`, {
      type: 'task_created',
      data: task
    });

    // Clear cache
    await cacheOperations.del(`team:${teamId}:tasks:*`);

    logHelpers.logCollaboration('task_created', teamId, userId, 'tasks', {
      taskId: task._id,
      taskTitle: task.title,
      priority: task.priority
    });

    res.status(201).json({
      success: true,
      data: task,
      message: 'Task created successfully'
    });
  })
);

// GET /api/tasks/:teamId/:taskId - Get task details
router.get('/:teamId/:taskId',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  param('taskId').isMongoId().withMessage('Invalid task ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId, taskId } = req.params;

    const task = await Task.findOne({
      _id: taskId,
      teamId
    }).populate('dependencies.taskId', 'title status priority');

    if (!task) {
      throw createNotFoundError('Task');
    }

    res.json({
      success: true,
      data: task
    });
  })
);

// PUT /api/tasks/:teamId/:taskId - Update task
router.put('/:teamId/:taskId',
  authMiddleware,
  updateTaskValidation,
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId, taskId } = req.params;
    const userId = req.user.id;

    const task = await Task.findOne({ _id: taskId, teamId });
    if (!task) {
      throw createNotFoundError('Task');
    }

    // Check if user can update this task
    const isAssigned = task.assignedTo.some(assignee => assignee.userId === userId);
    const isCreator = task.createdBy.userId === userId;
    
    if (!isAssigned && !isCreator) {
      await checkTaskPermissions(teamId, userId, 'manage');
    }

    // Handle status change to completed
    if (req.body.status === 'completed' && task.status !== 'completed') {
      task.completedAt = new Date();
      task.completedBy = {
        userId,
        userName: req.user.name
      };

      // Update team stats
      await Team.findByIdAndUpdate(teamId, {
        $inc: { 'stats.completedTasks': 1 }
      });
    }

    // Update task fields
    const allowedFields = ['title', 'description', 'status', 'priority', 'dueDate', 'estimatedHours', 'actualHours', 'tags'];
    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        task[field] = req.body[field];
      }
    });

    // Handle assignedTo updates
    if (req.body.assignedTo) {
      const team = await Team.findById(teamId);
      task.assignedTo = req.body.assignedTo.map(assigneeId => {
        const member = team.members.find(m => m.userId === assigneeId);
        return {
          userId: assigneeId,
          userName: member ? member.name : 'Unknown User'
        };
      });
    }

    await task.save();

    // Publish task update to real-time subscribers
    await pubSubOperations.publish(`team:${teamId}:tasks`, {
      type: 'task_updated',
      data: task
    });

    // Clear cache
    await cacheOperations.del(`team:${teamId}:tasks:*`);

    logHelpers.logCollaboration('task_updated', teamId, userId, 'tasks', {
      taskId: task._id,
      updatedFields: Object.keys(req.body)
    });

    res.json({
      success: true,
      data: task,
      message: 'Task updated successfully'
    });
  })
);

// DELETE /api/tasks/:teamId/:taskId - Delete task
router.delete('/:teamId/:taskId',
  authMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  param('taskId').isMongoId().withMessage('Invalid task ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId, taskId } = req.params;
    const userId = req.user.id;

    const task = await Task.findOne({ _id: taskId, teamId });
    if (!task) {
      throw createNotFoundError('Task');
    }

    // Only task creator or team admin can delete
    const isCreator = task.createdBy.userId === userId;
    if (!isCreator) {
      await checkTaskPermissions(teamId, userId, 'manage');
    }

    await Task.findByIdAndDelete(taskId);

    // Update team stats
    const updateStats = { $inc: { 'stats.totalTasks': -1 } };
    if (task.status === 'completed') {
      updateStats.$inc['stats.completedTasks'] = -1;
    }
    await Team.findByIdAndUpdate(teamId, updateStats);

    // Publish task deletion to real-time subscribers
    await pubSubOperations.publish(`team:${teamId}:tasks`, {
      type: 'task_deleted',
      data: { taskId, deletedBy: userId }
    });

    // Clear cache
    await cacheOperations.del(`team:${teamId}:tasks:*`);

    logHelpers.logCollaboration('task_deleted', teamId, userId, 'tasks', {
      taskId: task._id,
      taskTitle: task.title
    });

    res.json({
      success: true,
      message: 'Task deleted successfully'
    });
  })
);

// POST /api/tasks/:teamId/:taskId/comments - Add comment to task
router.post('/:teamId/:taskId/comments',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  param('taskId').isMongoId().withMessage('Invalid task ID'),
  body('comment')
    .trim()
    .isLength({ min: 1, max: 1000 })
    .withMessage('Comment must be between 1 and 1000 characters'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId, taskId } = req.params;
    const { comment } = req.body;
    const userId = req.user.id;

    const task = await Task.findOne({ _id: taskId, teamId });
    if (!task) {
      throw createNotFoundError('Task');
    }

    const newComment = {
      userId,
      userName: req.user.name,
      comment,
      createdAt: new Date()
    };

    task.comments.push(newComment);
    await task.save();

    // Publish comment to real-time subscribers
    await pubSubOperations.publish(`team:${teamId}:tasks`, {
      type: 'task_comment_added',
      data: {
        taskId,
        comment: newComment
      }
    });

    res.status(201).json({
      success: true,
      data: newComment,
      message: 'Comment added successfully'
    });
  })
);

// POST /api/tasks/:teamId/:taskId/time - Log time for task
router.post('/:teamId/:taskId/time',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  param('taskId').isMongoId().withMessage('Invalid task ID'),
  body('duration')
    .isInt({ min: 1, max: 1440 })
    .withMessage('Duration must be between 1 and 1440 minutes'),
  body('description')
    .optional()
    .trim()
    .isLength({ max: 200 })
    .withMessage('Description cannot exceed 200 characters'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId, taskId } = req.params;
    const { duration, description } = req.body;
    const userId = req.user.id;

    const task = await Task.findOne({ _id: taskId, teamId });
    if (!task) {
      throw createNotFoundError('Task');
    }

    const timeEntry = {
      userId,
      userName: req.user.name,
      duration,
      description,
      startTime: new Date(Date.now() - duration * 60 * 1000),
      endTime: new Date(),
      createdAt: new Date()
    };

    task.timeTracking.push(timeEntry);
    
    // Update actual hours
    task.actualHours = (task.actualHours || 0) + (duration / 60);
    
    await task.save();

    // Publish time log to real-time subscribers
    await pubSubOperations.publish(`team:${teamId}:tasks`, {
      type: 'task_time_logged',
      data: {
        taskId,
        timeEntry
      }
    });

    res.status(201).json({
      success: true,
      data: timeEntry,
      message: 'Time logged successfully'
    });
  })
);

// GET /api/tasks/:teamId/stats - Get task statistics
router.get('/:teamId/stats',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId } = req.params;
    const { startDate, endDate } = req.query;

    const matchStage = {
      teamId: new mongoose.Types.ObjectId(teamId)
    };

    if (startDate || endDate) {
      matchStage.createdAt = {};
      if (startDate) matchStage.createdAt.$gte = new Date(startDate);
      if (endDate) matchStage.createdAt.$lte = new Date(endDate);
    }

    const stats = await Task.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: null,
          totalTasks: { $sum: 1 },
          completedTasks: {
            $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
          },
          inProgressTasks: {
            $sum: { $cond: [{ $eq: ['$status', 'in-progress'] }, 1, 0] }
          },
          overdueTasks: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $lt: ['$dueDate', new Date()] },
                    { $nin: ['$status', ['completed', 'cancelled']] }
                  ]
                },
                1,
                0
              ]
            }
          },
          tasksByPriority: {
            $push: '$priority'
          },
          tasksByStatus: {
            $push: '$status'
          },
          totalEstimatedHours: { $sum: '$estimatedHours' },
          totalActualHours: { $sum: '$actualHours' }
        }
      }
    ]);

    const result = stats[0] || {
      totalTasks: 0,
      completedTasks: 0,
      inProgressTasks: 0,
      overdueTasks: 0,
      tasksByPriority: [],
      tasksByStatus: [],
      totalEstimatedHours: 0,
      totalActualHours: 0
    };

    // Process priority and status distributions
    const priorityCount = {};
    const statusCount = {};

    result.tasksByPriority.forEach(priority => {
      priorityCount[priority] = (priorityCount[priority] || 0) + 1;
    });

    result.tasksByStatus.forEach(status => {
      statusCount[status] = (statusCount[status] || 0) + 1;
    });

    result.priorityDistribution = priorityCount;
    result.statusDistribution = statusCount;
    result.completionRate = result.totalTasks > 0 
      ? Math.round((result.completedTasks / result.totalTasks) * 100) 
      : 0;

    delete result.tasksByPriority;
    delete result.tasksByStatus;

    res.json({
      success: true,
      data: result
    });
  })
);

export default router;

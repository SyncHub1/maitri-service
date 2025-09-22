import express from 'express';
import { body, param, query, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import { authMiddleware, teamMemberMiddleware, operationRateLimit } from '../middleware/auth.js';
import { asyncHandler, AppError, createNotFoundError } from '../middleware/errorHandler.js';
import { logger, logHelpers } from '../config/logger.js';
import { cacheOperations, pubSubOperations } from '../config/redis.js';
import { Team } from '../models/Team.js';

const router = express.Router();

// IDE Project Schema
const ideProjectSchema = new mongoose.Schema({
  teamId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Team',
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100
  },
  description: {
    type: String,
    trim: true,
    maxlength: 500
  },
  language: {
    type: String,
    enum: ['javascript', 'typescript', 'python', 'java', 'cpp', 'html', 'css', 'json', 'markdown'],
    default: 'javascript'
  },
  files: [{
    id: {
      type: String,
      required: true
    },
    name: {
      type: String,
      required: true
    },
    path: {
      type: String,
      required: true
    },
    content: {
      type: String,
      default: ''
    },
    language: String,
    isDirectory: {
      type: Boolean,
      default: false
    },
    parentId: String,
    size: {
      type: Number,
      default: 0
    },
    lastModified: {
      type: Date,
      default: Date.now
    },
    lastModifiedBy: {
      userId: String,
      userName: String
    },
    isLocked: {
      type: Boolean,
      default: false
    },
    lockedBy: {
      userId: String,
      userName: String,
      lockedAt: Date
    }
  }],
  collaborators: [{
    userId: {
      type: String,
      required: true
    },
    userName: {
      type: String,
      required: true
    },
    cursor: {
      fileId: String,
      line: Number,
      column: Number,
      lastSeen: {
        type: Date,
        default: Date.now
      }
    },
    color: {
      type: String,
      default: '#007bff'
    },
    isActive: {
      type: Boolean,
      default: true
    },
    permissions: {
      canEdit: {
        type: Boolean,
        default: true
      },
      canDelete: {
        type: Boolean,
        default: false
      },
      canManageFiles: {
        type: Boolean,
        default: false
      }
    }
  }],
  settings: {
    theme: {
      type: String,
      enum: ['light', 'dark', 'auto'],
      default: 'auto'
    },
    fontSize: {
      type: Number,
      default: 14,
      min: 10,
      max: 24
    },
    tabSize: {
      type: Number,
      default: 2,
      min: 1,
      max: 8
    },
    wordWrap: {
      type: Boolean,
      default: true
    },
    autoSave: {
      type: Boolean,
      default: true
    },
    liveShare: {
      type: Boolean,
      default: true
    }
  },
  version: {
    type: Number,
    default: 1
  },
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
  lastActivity: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: true
});

// Indexes
ideProjectSchema.index({ teamId: 1, lastActivity: -1 });
ideProjectSchema.index({ teamId: 1, createdBy: 1 });

const IDEProject = mongoose.model('IDEProject', ideProjectSchema);

// Validation rules
const createProjectValidation = [
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  body('name').trim().isLength({ min: 1, max: 100 }).withMessage('Name must be between 1 and 100 characters'),
  body('language').optional().isIn(['javascript', 'typescript', 'python', 'java', 'cpp', 'html', 'css', 'json', 'markdown']).withMessage('Invalid language')
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

// GET /api/ide/:teamId - Get team IDE projects
router.get('/:teamId',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId } = req.params;
    const { page = 1, limit = 20 } = req.query;

    const pageNum = parseInt(page);
    const limitNum = Math.min(parseInt(limit), 100);
    const skip = (pageNum - 1) * limitNum;

    const projects = await IDEProject.find({ teamId })
      .select('-files.content') // Exclude file content for list view
      .sort({ lastActivity: -1 })
      .limit(limitNum)
      .skip(skip);

    const total = await IDEProject.countDocuments({ teamId });

    res.json({
      success: true,
      data: projects,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });
  })
);

// POST /api/ide/:teamId - Create new IDE project
router.post('/:teamId',
  authMiddleware,
  teamMemberMiddleware,
  operationRateLimit('create_ide_project', 10, 3600000),
  createProjectValidation,
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId } = req.params;
    const userId = req.user.id;

    const projectData = {
      ...req.body,
      teamId,
      createdBy: {
        userId,
        userName: req.user.name
      },
      files: [{
        id: 'root',
        name: 'root',
        path: '/',
        isDirectory: true,
        parentId: null
      }],
      collaborators: [{
        userId,
        userName: req.user.name,
        permissions: {
          canEdit: true,
          canDelete: true,
          canManageFiles: true
        }
      }]
    };

    const project = new IDEProject(projectData);
    await project.save();

    logHelpers.logCollaboration('ide_project_created', teamId, userId, 'ide', {
      projectId: project._id,
      projectName: project.name
    });

    res.status(201).json({
      success: true,
      data: project,
      message: 'IDE project created successfully'
    });
  })
);

// GET /api/ide/:teamId/:projectId - Get IDE project details
router.get('/:teamId/:projectId',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  param('projectId').isMongoId().withMessage('Invalid project ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId, projectId } = req.params;
    const userId = req.user.id;

    const project = await IDEProject.findOne({
      _id: projectId,
      teamId
    });

    if (!project) {
      throw createNotFoundError('IDE Project');
    }

    // Add user as collaborator if not present
    const existingCollaborator = project.collaborators.find(c => c.userId === userId);
    if (!existingCollaborator) {
      project.collaborators.push({
        userId,
        userName: req.user.name,
        permissions: { canEdit: true, canDelete: false, canManageFiles: false }
      });
      await project.save();
    }

    project.lastActivity = new Date();
    await project.save();

    res.json({
      success: true,
      data: project
    });
  })
);

// POST /api/ide/:teamId/:projectId/files - Create/Update file
router.post('/:teamId/:projectId/files',
  authMiddleware,
  teamMemberMiddleware,
  operationRateLimit('ide_file_operation', 200, 60000),
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  param('projectId').isMongoId().withMessage('Invalid project ID'),
  body('name').trim().isLength({ min: 1, max: 100 }).withMessage('File name required'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId, projectId } = req.params;
    const { name, content = '', path, parentId, isDirectory = false } = req.body;
    const userId = req.user.id;

    const project = await IDEProject.findOne({ _id: projectId, teamId });
    if (!project) {
      throw createNotFoundError('IDE Project');
    }

    const fileId = `file_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const newFile = {
      id: fileId,
      name,
      path: path || `/${name}`,
      content,
      isDirectory,
      parentId: parentId || 'root',
      size: content.length,
      lastModified: new Date(),
      lastModifiedBy: {
        userId,
        userName: req.user.name
      }
    };

    project.files.push(newFile);
    project.version += 1;
    project.lastActivity = new Date();
    await project.save();

    // Publish file creation to real-time subscribers
    await pubSubOperations.publish(`team:${teamId}:ide:${projectId}`, {
      type: 'file_created',
      data: { file: newFile, userId, version: project.version }
    });

    res.status(201).json({
      success: true,
      data: newFile,
      message: 'File created successfully'
    });
  })
);

export default router;

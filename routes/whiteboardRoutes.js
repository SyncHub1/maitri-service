import express from 'express';
import { body, param, query, validationResult } from 'express-validator';
import mongoose from 'mongoose';
import { authMiddleware, teamMemberMiddleware, operationRateLimit } from '../middleware/auth.js';
import { asyncHandler, AppError, createNotFoundError } from '../middleware/errorHandler.js';
import { logger, logHelpers } from '../config/logger.js';
import { cacheOperations, pubSubOperations } from '../config/redis.js';
import { Team } from '../models/Team.js';

const router = express.Router();

// Whiteboard Schema
const whiteboardSchema = new mongoose.Schema({
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
  elements: [{
    id: {
      type: String,
      required: true
    },
    type: {
      type: String,
      enum: ['rectangle', 'ellipse', 'diamond', 'arrow', 'line', 'text', 'image', 'sticky-note', 'freehand'],
      required: true
    },
    x: {
      type: Number,
      required: true
    },
    y: {
      type: Number,
      required: true
    },
    width: {
      type: Number,
      required: true
    },
    height: {
      type: Number,
      required: true
    },
    angle: {
      type: Number,
      default: 0
    },
    strokeColor: {
      type: String,
      default: '#000000'
    },
    backgroundColor: {
      type: String,
      default: 'transparent'
    },
    fillStyle: {
      type: String,
      enum: ['solid', 'hachure', 'cross-hatch', 'dots'],
      default: 'solid'
    },
    strokeWidth: {
      type: Number,
      default: 1,
      min: 1,
      max: 20
    },
    strokeStyle: {
      type: String,
      enum: ['solid', 'dashed', 'dotted'],
      default: 'solid'
    },
    roughness: {
      type: Number,
      default: 1,
      min: 0,
      max: 5
    },
    opacity: {
      type: Number,
      default: 100,
      min: 0,
      max: 100
    },
    text: {
      type: String,
      maxlength: 1000
    },
    fontSize: {
      type: Number,
      default: 16,
      min: 8,
      max: 72
    },
    fontFamily: {
      type: String,
      default: 'Arial'
    },
    textAlign: {
      type: String,
      enum: ['left', 'center', 'right'],
      default: 'left'
    },
    points: [{
      x: Number,
      y: Number
    }],
    imageUrl: String,
    locked: {
      type: Boolean,
      default: false
    },
    groupId: String,
    zIndex: {
      type: Number,
      default: 0
    },
    createdBy: {
      userId: String,
      userName: String,
      createdAt: {
        type: Date,
        default: Date.now
      }
    },
    lastModifiedBy: {
      userId: String,
      userName: String,
      modifiedAt: {
        type: Date,
        default: Date.now
      }
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
      x: Number,
      y: Number,
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
    joinedAt: {
      type: Date,
      default: Date.now
    }
  }],
  settings: {
    canvasWidth: {
      type: Number,
      default: 2000
    },
    canvasHeight: {
      type: Number,
      default: 1500
    },
    backgroundColor: {
      type: String,
      default: '#ffffff'
    },
    gridEnabled: {
      type: Boolean,
      default: true
    },
    gridSize: {
      type: Number,
      default: 20
    },
    snapToGrid: {
      type: Boolean,
      default: false
    },
    showRulers: {
      type: Boolean,
      default: false
    },
    zoomLevel: {
      type: Number,
      default: 100,
      min: 10,
      max: 500
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
  isTemplate: {
    type: Boolean,
    default: false
  },
  templateCategory: {
    type: String,
    enum: ['flowchart', 'wireframe', 'brainstorm', 'diagram', 'planning', 'other']
  },
  tags: [{
    type: String,
    trim: true,
    lowercase: true,
    maxlength: 30
  }],
  lastActivity: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes
whiteboardSchema.index({ teamId: 1, lastActivity: -1 });
whiteboardSchema.index({ teamId: 1, createdBy: 1 });
whiteboardSchema.index({ name: 'text', description: 'text' });

// Virtuals
whiteboardSchema.virtual('elementCount').get(function() {
  return this.elements ? this.elements.length : 0;
});

whiteboardSchema.virtual('activeCollaborators').get(function() {
  if (!this.collaborators) return [];
  
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  return this.collaborators.filter(collab => 
    collab.isActive && collab.cursor && collab.cursor.lastSeen > fiveMinutesAgo
  );
});

const Whiteboard = mongoose.model('Whiteboard', whiteboardSchema);

// Validation rules
const createWhiteboardValidation = [
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  body('name')
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Name must be between 1 and 100 characters'),
  body('description')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Description cannot exceed 500 characters'),
  body('templateCategory')
    .optional()
    .isIn(['flowchart', 'wireframe', 'brainstorm', 'diagram', 'planning', 'other'])
    .withMessage('Invalid template category')
];

const updateWhiteboardValidation = [
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  param('whiteboardId').isMongoId().withMessage('Invalid whiteboard ID'),
  body('name')
    .optional()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Name must be between 1 and 100 characters'),
  body('description')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Description cannot exceed 500 characters')
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

// Helper function to generate random color for collaborators
const generateCollaboratorColor = () => {
  const colors = [
    '#007bff', '#28a745', '#dc3545', '#ffc107', '#17a2b8',
    '#6f42c1', '#e83e8c', '#fd7e14', '#20c997', '#6c757d'
  ];
  return colors[Math.floor(Math.random() * colors.length)];
};

// GET /api/whiteboard/:teamId - Get team whiteboards
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
      search,
      sortBy = 'lastActivity',
      sortOrder = 'desc',
      templateCategory
    } = req.query;

    const pageNum = parseInt(page);
    const limitNum = Math.min(parseInt(limit), 100);
    const skip = (pageNum - 1) * limitNum;

    // Build query
    const query = { teamId: new mongoose.Types.ObjectId(teamId) };

    if (templateCategory) {
      query.templateCategory = templateCategory;
    }

    // Handle search
    let whiteboards;
    if (search) {
      query.$text = { $search: search };
      whiteboards = await Whiteboard.find(query, { score: { $meta: 'textScore' } })
        .sort({ score: { $meta: 'textScore' } })
        .limit(limitNum)
        .skip(skip)
        .select('-elements'); // Exclude elements for list view
    } else {
      const sortObj = {};
      sortObj[sortBy] = sortOrder === 'desc' ? -1 : 1;

      whiteboards = await Whiteboard.find(query)
        .sort(sortObj)
        .limit(limitNum)
        .skip(skip)
        .select('-elements'); // Exclude elements for list view
    }

    const total = await Whiteboard.countDocuments(query);

    res.json({
      success: true,
      data: whiteboards,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });
  })
);

// POST /api/whiteboard/:teamId - Create a new whiteboard
router.post('/:teamId',
  authMiddleware,
  teamMemberMiddleware,
  operationRateLimit('create_whiteboard', 20, 3600000), // 20 whiteboards per hour
  createWhiteboardValidation,
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId } = req.params;
    const userId = req.user.id;

    const whiteboardData = {
      ...req.body,
      teamId,
      createdBy: {
        userId,
        userName: req.user.name
      },
      elements: [],
      collaborators: [{
        userId,
        userName: req.user.name,
        color: generateCollaboratorColor(),
        isActive: true
      }]
    };

    const whiteboard = new Whiteboard(whiteboardData);
    await whiteboard.save();

    // Publish whiteboard creation to real-time subscribers
    await pubSubOperations.publish(`team:${teamId}:whiteboard`, {
      type: 'whiteboard_created',
      data: whiteboard
    });

    logHelpers.logCollaboration('whiteboard_created', teamId, userId, 'whiteboard', {
      whiteboardId: whiteboard._id,
      whiteboardName: whiteboard.name
    });

    res.status(201).json({
      success: true,
      data: whiteboard,
      message: 'Whiteboard created successfully'
    });
  })
);

// GET /api/whiteboard/:teamId/:whiteboardId - Get whiteboard details
router.get('/:teamId/:whiteboardId',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  param('whiteboardId').isMongoId().withMessage('Invalid whiteboard ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId, whiteboardId } = req.params;
    const userId = req.user.id;

    const whiteboard = await Whiteboard.findOne({
      _id: whiteboardId,
      teamId
    });

    if (!whiteboard) {
      throw createNotFoundError('Whiteboard');
    }

    // Add user as collaborator if not already present
    const existingCollaborator = whiteboard.collaborators.find(c => c.userId === userId);
    if (!existingCollaborator) {
      whiteboard.collaborators.push({
        userId,
        userName: req.user.name,
        color: generateCollaboratorColor(),
        isActive: true
      });
      await whiteboard.save();
    } else if (!existingCollaborator.isActive) {
      existingCollaborator.isActive = true;
      existingCollaborator.joinedAt = new Date();
      await whiteboard.save();
    }

    // Update last activity
    whiteboard.lastActivity = new Date();
    await whiteboard.save();

    res.json({
      success: true,
      data: whiteboard
    });
  })
);

// PUT /api/whiteboard/:teamId/:whiteboardId - Update whiteboard
router.put('/:teamId/:whiteboardId',
  authMiddleware,
  teamMemberMiddleware,
  updateWhiteboardValidation,
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId, whiteboardId } = req.params;
    const userId = req.user.id;

    const whiteboard = await Whiteboard.findOne({
      _id: whiteboardId,
      teamId
    });

    if (!whiteboard) {
      throw createNotFoundError('Whiteboard');
    }

    // Update whiteboard fields
    const allowedFields = ['name', 'description', 'tags', 'settings'];
    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        whiteboard[field] = req.body[field];
      }
    });

    whiteboard.lastActivity = new Date();
    await whiteboard.save();

    // Publish whiteboard update to real-time subscribers
    await pubSubOperations.publish(`team:${teamId}:whiteboard`, {
      type: 'whiteboard_updated',
      data: whiteboard
    });

    logHelpers.logCollaboration('whiteboard_updated', teamId, userId, 'whiteboard', {
      whiteboardId: whiteboard._id,
      updatedFields: Object.keys(req.body)
    });

    res.json({
      success: true,
      data: whiteboard,
      message: 'Whiteboard updated successfully'
    });
  })
);

// DELETE /api/whiteboard/:teamId/:whiteboardId - Delete whiteboard
router.delete('/:teamId/:whiteboardId',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  param('whiteboardId').isMongoId().withMessage('Invalid whiteboard ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId, whiteboardId } = req.params;
    const userId = req.user.id;

    const whiteboard = await Whiteboard.findOne({
      _id: whiteboardId,
      teamId
    });

    if (!whiteboard) {
      throw createNotFoundError('Whiteboard');
    }

    // Check if user can delete (creator or team admin)
    const team = await Team.findById(teamId);
    const canDelete = whiteboard.createdBy.userId === userId || team.isAdmin(userId);

    if (!canDelete) {
      throw new AppError('You can only delete whiteboards you created or need admin privileges', 403, 'INSUFFICIENT_PERMISSIONS');
    }

    await Whiteboard.findByIdAndDelete(whiteboardId);

    // Publish whiteboard deletion to real-time subscribers
    await pubSubOperations.publish(`team:${teamId}:whiteboard`, {
      type: 'whiteboard_deleted',
      data: { whiteboardId, deletedBy: userId }
    });

    logHelpers.logCollaboration('whiteboard_deleted', teamId, userId, 'whiteboard', {
      whiteboardId: whiteboard._id,
      whiteboardName: whiteboard.name
    });

    res.json({
      success: true,
      message: 'Whiteboard deleted successfully'
    });
  })
);

// POST /api/whiteboard/:teamId/:whiteboardId/elements - Add/Update elements
router.post('/:teamId/:whiteboardId/elements',
  authMiddleware,
  teamMemberMiddleware,
  operationRateLimit('whiteboard_elements', 1000, 60000), // 1000 operations per minute
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  param('whiteboardId').isMongoId().withMessage('Invalid whiteboard ID'),
  body('elements').isArray().withMessage('Elements must be an array'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId, whiteboardId } = req.params;
    const { elements, operation = 'update' } = req.body;
    const userId = req.user.id;

    const whiteboard = await Whiteboard.findOne({
      _id: whiteboardId,
      teamId
    });

    if (!whiteboard) {
      throw createNotFoundError('Whiteboard');
    }

    const timestamp = new Date();
    const userInfo = {
      userId,
      userName: req.user.name,
      modifiedAt: timestamp
    };

    // Process elements based on operation
    elements.forEach(element => {
      const existingIndex = whiteboard.elements.findIndex(e => e.id === element.id);

      if (operation === 'delete') {
        if (existingIndex !== -1) {
          whiteboard.elements.splice(existingIndex, 1);
        }
      } else {
        // Add creation info for new elements
        if (existingIndex === -1) {
          element.createdBy = userInfo;
        }
        
        // Always update last modified info
        element.lastModifiedBy = userInfo;

        if (existingIndex !== -1) {
          // Update existing element
          whiteboard.elements[existingIndex] = { ...whiteboard.elements[existingIndex].toObject(), ...element };
        } else {
          // Add new element
          whiteboard.elements.push(element);
        }
      }
    });

    whiteboard.version += 1;
    whiteboard.lastActivity = timestamp;
    await whiteboard.save();

    // Publish element changes to real-time subscribers
    await pubSubOperations.publish(`team:${teamId}:whiteboard:${whiteboardId}`, {
      type: 'elements_updated',
      data: {
        elements,
        operation,
        userId,
        version: whiteboard.version
      }
    });

    res.json({
      success: true,
      data: {
        elements: whiteboard.elements,
        version: whiteboard.version
      },
      message: 'Elements updated successfully'
    });
  })
);

// POST /api/whiteboard/:teamId/:whiteboardId/cursor - Update cursor position
router.post('/:teamId/:whiteboardId/cursor',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  param('whiteboardId').isMongoId().withMessage('Invalid whiteboard ID'),
  body('x').isNumeric().withMessage('X coordinate must be a number'),
  body('y').isNumeric().withMessage('Y coordinate must be a number'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId, whiteboardId } = req.params;
    const { x, y } = req.body;
    const userId = req.user.id;

    // Update cursor in cache for real-time updates
    const cacheKey = `whiteboard:${whiteboardId}:cursor:${userId}`;
    const cursorData = {
      userId,
      userName: req.user.name,
      x: parseFloat(x),
      y: parseFloat(y),
      lastSeen: new Date()
    };

    await cacheOperations.set(cacheKey, cursorData, 30); // 30 seconds TTL

    // Publish cursor update to real-time subscribers
    await pubSubOperations.publish(`team:${teamId}:whiteboard:${whiteboardId}`, {
      type: 'cursor_updated',
      data: cursorData
    });

    res.json({
      success: true,
      message: 'Cursor position updated'
    });
  })
);

// POST /api/whiteboard/:teamId/:whiteboardId/leave - Leave whiteboard collaboration
router.post('/:teamId/:whiteboardId/leave',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  param('whiteboardId').isMongoId().withMessage('Invalid whiteboard ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId, whiteboardId } = req.params;
    const userId = req.user.id;

    const whiteboard = await Whiteboard.findOne({
      _id: whiteboardId,
      teamId
    });

    if (!whiteboard) {
      throw createNotFoundError('Whiteboard');
    }

    // Mark collaborator as inactive
    const collaborator = whiteboard.collaborators.find(c => c.userId === userId);
    if (collaborator) {
      collaborator.isActive = false;
      await whiteboard.save();
    }

    // Remove cursor from cache
    await cacheOperations.del(`whiteboard:${whiteboardId}:cursor:${userId}`);

    // Publish leave event to real-time subscribers
    await pubSubOperations.publish(`team:${teamId}:whiteboard:${whiteboardId}`, {
      type: 'collaborator_left',
      data: { userId }
    });

    res.json({
      success: true,
      message: 'Left whiteboard collaboration'
    });
  })
);

// GET /api/whiteboard/:teamId/:whiteboardId/export - Export whiteboard
router.get('/:teamId/:whiteboardId/export',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  param('whiteboardId').isMongoId().withMessage('Invalid whiteboard ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { teamId, whiteboardId } = req.params;
    const { format = 'json' } = req.query;

    const whiteboard = await Whiteboard.findOne({
      _id: whiteboardId,
      teamId
    });

    if (!whiteboard) {
      throw createNotFoundError('Whiteboard');
    }

    let exportData;

    switch (format) {
      case 'json':
        exportData = {
          name: whiteboard.name,
          description: whiteboard.description,
          elements: whiteboard.elements,
          settings: whiteboard.settings,
          exportedAt: new Date(),
          exportedBy: req.user.name
        };
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${whiteboard.name}.json"`);
        break;

      case 'svg':
        // Generate SVG representation (simplified)
        const svgElements = whiteboard.elements.map(element => {
          switch (element.type) {
            case 'rectangle':
              return `<rect x="${element.x}" y="${element.y}" width="${element.width}" height="${element.height}" fill="${element.backgroundColor}" stroke="${element.strokeColor}" stroke-width="${element.strokeWidth}" />`;
            case 'ellipse':
              return `<ellipse cx="${element.x + element.width/2}" cy="${element.y + element.height/2}" rx="${element.width/2}" ry="${element.height/2}" fill="${element.backgroundColor}" stroke="${element.strokeColor}" stroke-width="${element.strokeWidth}" />`;
            case 'text':
              return `<text x="${element.x}" y="${element.y}" font-size="${element.fontSize}" font-family="${element.fontFamily}" fill="${element.strokeColor}">${element.text}</text>`;
            default:
              return '';
          }
        }).join('\n');

        exportData = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${whiteboard.settings.canvasWidth}" height="${whiteboard.settings.canvasHeight}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="${whiteboard.settings.backgroundColor}"/>
  ${svgElements}
</svg>`;
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Content-Disposition', `attachment; filename="${whiteboard.name}.svg"`);
        break;

      default:
        throw new AppError('Unsupported export format', 400, 'INVALID_FORMAT');
    }

    logHelpers.logCollaboration('whiteboard_exported', teamId, req.user.id, 'whiteboard', {
      whiteboardId: whiteboard._id,
      format
    });

    res.send(exportData);
  })
);

// GET /api/whiteboard/:teamId/templates - Get whiteboard templates
router.get('/:teamId/templates',
  authMiddleware,
  teamMemberMiddleware,
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { category } = req.query;

    const query = { isTemplate: true };
    if (category) {
      query.templateCategory = category;
    }

    const templates = await Whiteboard.find(query)
      .select('name description templateCategory elements settings createdAt')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: templates
    });
  })
);

export default router;

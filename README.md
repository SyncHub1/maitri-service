# Matri Service - Team Collaboration Backend

A production-grade microservice for the Synchubb Matri platform, providing comprehensive team collaboration features including real-time chat, collaborative IDE, whiteboard, video conferencing, task management, and analytics.

## 🚀 Features

### Core Team Management
- **Team Discovery & Creation**: Create and discover teams across various categories
- **Member Management**: Invite, manage, and organize team members with role-based permissions
- **Team Settings**: Configurable team settings for privacy, capacity, and collaboration features

### Real-time Collaboration Tools
- **Chat System**: Real-time messaging with reactions, replies, file attachments, and message threading
- **Collaborative IDE**: Multi-user code editing with real-time synchronization and conflict resolution
- **Interactive Whiteboard**: Shared drawing canvas with real-time collaboration and element management
- **Video Conferencing**: WebRTC-based video calls with screen sharing and recording capabilities
- **Task Management**: Comprehensive project management with assignments, deadlines, and progress tracking

### Advanced Features
- **Team Analytics**: Detailed insights into team activity, engagement, and productivity metrics
- **Email Invitations**: Automated invitation system with customizable email templates
- **Real-time Presence**: Live user status and activity tracking across all collaboration tools
- **File Management**: Secure file uploads and sharing with Cloudinary integration

## 🏗️ Architecture

### Microservice Integration
- **Authentication**: Integrates with SynchubbAuth service (port 8000)
- **Media Processing**: Leverages media-api-service (port 3001) for file handling
- **Real-time Communication**: Uses WebSocket service (port 3002) for live updates
- **Shared Utilities**: Utilizes shared-utils for Redis, Cloudinary, and queue management

### Technology Stack
- **Runtime**: Node.js with ES Modules
- **Framework**: Express.js with comprehensive middleware
- **Database**: MongoDB with Mongoose ODM
- **Caching**: Redis for session management and real-time data
- **Real-time**: Socket.IO for WebSocket communication
- **File Storage**: Cloudinary for media assets
- **Email**: Nodemailer with Gmail integration
- **Validation**: Express-validator for request validation
- **Logging**: Winston for structured logging
- **Security**: Helmet, CORS, rate limiting, and JWT authentication

## 📁 Project Structure

```
matri-service/
├── config/
│   ├── database.js          # MongoDB connection and configuration
│   ├── redis.js             # Redis client and pub/sub operations
│   ├── logger.js            # Winston logging configuration
│   └── socket.js            # Socket.IO setup and event handlers
├── middleware/
│   ├── auth.js              # Authentication and authorization middleware
│   └── errorHandler.js      # Global error handling and custom errors
├── models/
│   ├── Team.js              # Team schema with members and settings
│   └── Chat.js              # Chat message schema with reactions
├── routes/
│   ├── teamRoutes.js        # Team CRUD and member management
│   ├── chatRoutes.js        # Real-time messaging and reactions
│   ├── invitationRoutes.js  # Email invitations and user search
│   ├── taskRoutes.js        # Task management and time tracking
│   ├── whiteboardRoutes.js  # Collaborative whiteboard operations
│   ├── ideRoutes.js         # Collaborative IDE and file management
│   ├── videoRoutes.js       # Video conferencing and WebRTC signaling
│   ├── analyticsRoutes.js   # Team analytics and insights
│   └── collaborationRoutes.js # Real-time collaboration status
├── logs/                    # Application logs
├── .env                     # Environment configuration
├── .env.example             # Environment template
├── package.json             # Dependencies and scripts
├── server.js                # Main application entry point
└── README.md                # This file
```

## 🚦 Getting Started

### Prerequisites
- Node.js 18+ 
- MongoDB 5.0+
- Redis 6.0+
- Cloudinary account
- Gmail account for email services

### Installation

1. **Clone and navigate to the service**
   ```bash
   cd matri-service
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

4. **Start the service**
   ```bash
   # Development
   npm run dev
   
   # Production
   npm start
   ```

### Environment Configuration

Key environment variables to configure:

```env
# Server
PORT=3003
NODE_ENV=development

# Database
MONGODB_URI=mongodb+srv://your-connection-string

# Redis
REDIS_HOST=your-redis-host
REDIS_PORT=12287
REDIS_PASSWORD=your-redis-password

# JWT
JWT_SECRET=your-super-secret-jwt-key

# Email
EMAIL_USER=your-email@gmail.com
EMAIL_PASSWORD=your-app-password

# Cloudinary
CLOUDINARY_CLOUD_NAME=your-cloud-name
CLOUDINARY_API_KEY=your-api-key
CLOUDINARY_API_SECRET=your-api-secret

# External Services
AUTH_SERVICE_URL=http://localhost:8000
MEDIA_API_URL=http://localhost:3001
WEBSOCKET_SERVICE_URL=http://localhost:3002
```

## 📡 API Endpoints

### Team Management
- `GET /api/v1/teams` - List teams with filtering and pagination
- `POST /api/v1/teams` - Create a new team
- `GET /api/v1/teams/:teamId` - Get team details
- `PUT /api/v1/teams/:teamId` - Update team information
- `POST /api/v1/teams/:teamId/join` - Join a team
- `POST /api/v1/teams/:teamId/leave` - Leave a team
- `DELETE /api/v1/teams/:teamId` - Archive a team

### Chat & Messaging
- `GET /api/v1/chat/:teamId/messages` - Get chat messages
- `POST /api/v1/chat/:teamId/messages` - Send a message
- `PUT /api/v1/chat/:teamId/messages/:messageId` - Edit message
- `DELETE /api/v1/chat/:teamId/messages/:messageId` - Delete message
- `POST /api/v1/chat/:teamId/messages/:messageId/reactions` - Add reaction
- `POST /api/v1/chat/:teamId/messages/:messageId/pin` - Pin message

### Invitations
- `GET /api/v1/invitations/users/search` - Search users for invitations
- `POST /api/v1/invitations/:teamId/invite` - Send team invitations
- `GET /api/v1/invitations/:teamId` - Get team invitations
- `POST /api/v1/invitations/accept/:token` - Accept invitation
- `POST /api/v1/invitations/decline/:token` - Decline invitation

### Task Management
- `GET /api/v1/tasks/:teamId` - Get team tasks
- `POST /api/v1/tasks/:teamId` - Create a new task
- `GET /api/v1/tasks/:teamId/:taskId` - Get task details
- `PUT /api/v1/tasks/:teamId/:taskId` - Update task
- `DELETE /api/v1/tasks/:teamId/:taskId` - Delete task
- `POST /api/v1/tasks/:teamId/:taskId/comments` - Add task comment
- `POST /api/v1/tasks/:teamId/:taskId/time` - Log time for task

### Whiteboard Collaboration
- `GET /api/v1/whiteboard/:teamId` - Get team whiteboards
- `POST /api/v1/whiteboard/:teamId` - Create whiteboard
- `GET /api/v1/whiteboard/:teamId/:whiteboardId` - Get whiteboard
- `POST /api/v1/whiteboard/:teamId/:whiteboardId/elements` - Update elements
- `POST /api/v1/whiteboard/:teamId/:whiteboardId/cursor` - Update cursor
- `GET /api/v1/whiteboard/:teamId/:whiteboardId/export` - Export whiteboard

### IDE Collaboration
- `GET /api/v1/ide/:teamId` - Get IDE projects
- `POST /api/v1/ide/:teamId` - Create IDE project
- `GET /api/v1/ide/:teamId/:projectId` - Get project details
- `POST /api/v1/ide/:teamId/:projectId/files` - Create/update files

### Video Conferencing
- `GET /api/v1/video/:teamId` - Get video calls
- `POST /api/v1/video/:teamId` - Create/schedule video call
- `POST /api/v1/video/:teamId/:callId/join` - Join video call
- `POST /api/v1/video/:teamId/:callId/leave` - Leave video call
- `POST /api/v1/video/:teamId/:callId/signaling` - WebRTC signaling

### Analytics
- `GET /api/v1/analytics/:teamId/overview` - Team analytics overview
- `GET /api/v1/analytics/:teamId/messages` - Message analytics
- `GET /api/v1/analytics/:teamId/members` - Member analytics
- `GET /api/v1/analytics/:teamId/engagement` - Engagement metrics

## 🔧 Development

### Code Quality
- **ESLint**: Code linting with Airbnb configuration
- **Error Handling**: Comprehensive error handling with custom error classes
- **Validation**: Request validation using express-validator
- **Logging**: Structured logging with Winston
- **Security**: Production-ready security middleware

### Testing
```bash
npm test          # Run tests
npm run test:watch # Watch mode
```

### Linting
```bash
npm run lint      # Check code style
npm run lint:fix  # Fix linting issues
```

## 🔒 Security Features

- **JWT Authentication**: Secure token-based authentication
- **Rate Limiting**: API rate limiting to prevent abuse
- **CORS Configuration**: Proper cross-origin resource sharing
- **Helmet Security**: Security headers and protection
- **Input Validation**: Comprehensive request validation
- **Error Sanitization**: Safe error responses without sensitive data

## 📊 Monitoring & Logging

- **Health Checks**: `/health` endpoint for service monitoring
- **Structured Logging**: JSON-formatted logs with Winston
- **Error Tracking**: Comprehensive error logging and tracking
- **Performance Metrics**: Request timing and performance monitoring

## 🚀 Deployment

### Docker Support
```dockerfile
# Dockerfile example
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3003
CMD ["npm", "start"]
```

### Production Considerations
- Use PM2 or similar process manager
- Configure proper logging rotation
- Set up monitoring and alerting
- Use environment-specific configurations
- Implement proper backup strategies

## 🤝 Integration with Synchubb Ecosystem

This service seamlessly integrates with the existing Synchubb microservices:

- **SynchubbAuth**: User authentication and profile management
- **media-api-service**: File uploads and media processing
- **websocket-service**: Real-time communication infrastructure
- **shared-utils**: Common utilities for Redis, Cloudinary, and queues

## 📈 Performance Optimizations

- **Redis Caching**: Aggressive caching for frequently accessed data
- **Database Indexing**: Optimized MongoDB indexes for query performance
- **Connection Pooling**: Efficient database connection management
- **Compression**: Response compression for reduced bandwidth
- **Rate Limiting**: Prevents API abuse and ensures fair usage

## 🔄 Real-time Features

- **Socket.IO Integration**: Real-time bidirectional communication
- **Redis Pub/Sub**: Scalable message broadcasting
- **Presence System**: Live user status and activity tracking
- **Collaborative Editing**: Real-time synchronization for IDE and whiteboard
- **Live Notifications**: Instant updates for team activities

## 📝 License

This project is part of the Synchubb platform and follows the same licensing terms.

## 🆘 Support

For support and questions:
- Check the existing documentation
- Review the API endpoints and examples
- Contact the development team

---

**Built with ❤️ for the Synchubb Matri Platform**

# Matri Service Troubleshooting Guide

## 🚨 Redis Connection Error: ECONNREFUSED 127.0.0.1:6379

### Problem
The error `ECONNREFUSED 127.0.0.1:6379` means Redis is not running or not accessible on the default port 6379.

### ✅ Quick Solutions

#### Option 1: Continue Without Redis (Recommended for Development)
The service now includes mock Redis functionality. Simply run:
```bash
npm run dev
```
The service will automatically detect Redis is unavailable and use mock functionality.

#### Option 2: Install and Start Local Redis

**Windows:**
1. Download Redis from: https://github.com/microsoftarchive/redis/releases
2. Extract and run: `redis-server.exe`
3. Test with: `redis-cli ping` (should return PONG)

**macOS:**
```bash
brew install redis
brew services start redis
redis-cli ping
```

**Linux (Ubuntu/Debian):**
```bash
sudo apt-get update
sudo apt-get install redis-server
sudo systemctl start redis-server
redis-cli ping
```

#### Option 3: Use Cloud Redis
Update your `.env` file with cloud Redis credentials:
```env
REDIS_HOST=your-redis-host.com
REDIS_PORT=12345
REDIS_PASSWORD=your-redis-password
```

### 🔍 Diagnostic Commands

**Check Redis Status:**
```bash
npm run check-redis
```

**Check Service Health:**
```bash
npm run health-check
```

**Manual Redis Test:**
```bash
redis-cli ping
# Should return: PONG
```

## 🔧 Other Common Issues

### Database Connection Failed
```bash
# Check MongoDB connection
mongosh --eval "db.runCommand('ping')"

# Use development mode (continues without DB)
set NODE_ENV=development && npm run dev
```

### Port Already in Use
```bash
# Check what's using port 3003
netstat -ano | findstr :3003

# Kill the process (replace PID)
taskkill /PID <PID> /F

# Use different port
set PORT=3004 && npm run dev
```

### Missing Environment File
```bash
# Copy development template
copy .env.development .env

# Or copy example
copy .env.example .env
```

## 🚀 Development Workflow

### 1. First Time Setup
```bash
cd matri-service
npm install
npm run setup  # Creates .env and logs directory
```

### 2. Check Dependencies
```bash
npm run check-redis  # Check Redis connection
# MongoDB check (if needed)
mongosh --eval "db.runCommand('ping')"
```

### 3. Start Development Server
```bash
npm run dev  # Smart startup with error handling
# OR
npm run dev:watch  # Auto-restart on changes
```

### 4. Verify Service
```bash
npm run health-check
# Should show: Status: healthy
```

## 📊 Service Status Indicators

### ✅ Healthy Service
```
✅ Database connected successfully
✅ Redis connected successfully (or Mock Redis service initialized)
✅ Socket.IO configured successfully
🚀 Matri Service running on port 3003
```

### ⚠️ Degraded Service (Development Mode)
```
❌ Database connection failed: [error]
⚠️ Continuing without database in development mode
❌ Redis connection failed: [error]  
🔄 Using mock Redis service for development
✅ Socket.IO configured successfully
🚀 Matri Service running on port 3003
```

### ❌ Failed Service
```
❌ Database connection failed: [error]
❌ Redis connection failed: [error]
❌ Failed to start server: [error]
```

## 🔄 Mock Services

When external services are unavailable, the Matri service uses mock implementations:

### Mock Redis Features
- ✅ Cache operations (in-memory)
- ✅ Pub/sub operations (no-op)
- ✅ All Redis commands return success
- ⚠️ Data is not persisted between restarts

### Mock Cloudinary Features
- ✅ File upload simulation
- ✅ Returns mock URLs
- ⚠️ Files are not actually stored

## 🛠️ Advanced Troubleshooting

### Enable Debug Logging
```bash
set LOG_LEVEL=debug && npm run dev
```

### Check Network Connectivity
```bash
# Test Redis host
ping 127.0.0.1
telnet 127.0.0.1 6379

# Test MongoDB host
ping your-mongodb-host.com
```

### Clear Node Modules
```bash
rm -rf node_modules package-lock.json
npm install
```

### Reset Environment
```bash
# Backup current .env
copy .env .env.backup

# Reset to development defaults
copy .env.development .env
npm run dev
```

## 📞 Getting Help

### Service Health Check
```bash
curl http://localhost:3003/health
```

### View Logs
```bash
# View latest logs
tail -f logs/matri-service.log

# View error logs
grep "ERROR" logs/matri-service.log
```

### Environment Variables
```bash
# Check current environment
node -e "console.log(process.env.NODE_ENV)"
node -e "console.log(process.env.PORT)"
```

## 🎯 Success Criteria

Your Matri service is working correctly when:

1. ✅ Service starts without errors
2. ✅ Health check returns `status: "healthy"`
3. ✅ API endpoints respond (e.g., `/api/v1/teams`)
4. ✅ Socket.IO connection works
5. ✅ No continuous error logs

The service is designed to work even when Redis or MongoDB are unavailable, making it perfect for development and testing!

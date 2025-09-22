# 🔄 Install Redis Locally (Optional)

The Matri service works perfectly with mock Redis, but if you want to eliminate the Redis connection warning, you can install Redis locally.

## 🪟 Windows

### Option 1: Download Redis for Windows
1. Download from: https://github.com/microsoftarchive/redis/releases
2. Extract the ZIP file
3. Run `redis-server.exe`
4. Test with `redis-cli.exe ping` (should return PONG)

### Option 2: Use Docker
```bash
docker run -d -p 6379:6379 --name redis redis:alpine
```

### Option 3: Use WSL (Windows Subsystem for Linux)
```bash
# In WSL terminal
sudo apt-get update
sudo apt-get install redis-server
redis-server --daemonize yes
```

## 🍎 macOS

### Using Homebrew (Recommended)
```bash
# Install Redis
brew install redis

# Start Redis service
brew services start redis

# Test connection
redis-cli ping
```

### Using Docker
```bash
docker run -d -p 6379:6379 --name redis redis:alpine
```

## 🐧 Linux (Ubuntu/Debian)

### Using APT
```bash
# Update package list
sudo apt-get update

# Install Redis
sudo apt-get install redis-server

# Start Redis service
sudo systemctl start redis-server

# Enable auto-start
sudo systemctl enable redis-server

# Test connection
redis-cli ping
```

### Using Docker
```bash
docker run -d -p 6379:6379 --name redis redis:alpine
```

## ✅ Verify Installation

After installing Redis, verify it's working:

```bash
# Test Redis connection
npm run check-redis

# Should show:
# ✅ Redis connection successful!
# Response: PONG
```

## 🚀 Restart Matri Service

After installing Redis, restart the Matri service:

```bash
npm run dev
```

You should now see:
```
✅ Redis connected successfully
```

Instead of:
```
⚠️ Redis server not available on localhost:6379
🔄 Switching to mock Redis service for development
```

## 🔧 Redis Configuration

If you installed Redis on a different port or with authentication, update your `.env` file:

```env
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=your-password-if-any
```

## 💡 Do You Need Redis?

**For Development:** No, the mock Redis service provides all functionality needed.

**For Production:** Yes, Redis provides:
- Persistent caching
- Real-time pub/sub messaging
- Session storage
- Performance improvements

**For Learning:** Optional, but good to understand how Redis works.

## 🛑 Stop Redis

If you want to stop Redis later:

### Windows
- Close the `redis-server.exe` window
- Or: `redis-cli.exe shutdown`

### macOS
```bash
brew services stop redis
```

### Linux
```bash
sudo systemctl stop redis-server
```

### Docker
```bash
docker stop redis
docker rm redis
```

## 🎯 Summary

- ✅ **Mock Redis works perfectly** - no installation required
- ✅ **Real Redis eliminates warnings** - cleaner logs
- ✅ **Easy to install** - multiple options available
- ✅ **Optional for development** - your choice!

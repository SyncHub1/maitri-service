#!/usr/bin/env node

import Redis from 'ioredis';

console.log('🔍 Checking Redis connection...\n');

const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  connectTimeout: 3000,
  maxRetriesPerRequest: 1,
  lazyConnect: true,
  family: 4
};

console.log(`📋 Redis Configuration:`);
console.log(`   Host: ${redisConfig.host}`);
console.log(`   Port: ${redisConfig.port}`);
console.log(`   Password: ${redisConfig.password ? '***' : 'None'}`);
console.log('');

const redis = new Redis(redisConfig);

try {
  console.log('🔄 Attempting to connect to Redis...');
  
  const pong = await redis.ping();
  console.log(`✅ Redis connection successful!`);
  console.log(`   Response: ${pong}`);
  
  // Test basic operations
  await redis.set('test:connection', 'success', 'EX', 10);
  const testValue = await redis.get('test:connection');
  console.log(`   Test operation: ${testValue}`);
  
  await redis.del('test:connection');
  console.log('   Cleanup: completed');
  
  await redis.quit();
  console.log('\n🎉 Redis is working correctly!');
  
} catch (error) {
  console.log(`❌ Redis connection failed:`);
  console.log(`   Error: ${error.message}`);
  
  if (error.code === 'ECONNREFUSED') {
    console.log('\n💡 Possible solutions:');
    console.log('   1. Install Redis locally:');
    console.log('      - Windows: Download from https://redis.io/download');
    console.log('      - macOS: brew install redis');
    console.log('      - Linux: sudo apt-get install redis-server');
    console.log('');
    console.log('   2. Start Redis service:');
    console.log('      - Windows: redis-server.exe');
    console.log('      - macOS/Linux: redis-server');
    console.log('');
    console.log('   3. Use cloud Redis:');
    console.log('      - Update REDIS_HOST, REDIS_PORT, REDIS_PASSWORD in .env');
    console.log('');
    console.log('   4. Continue without Redis:');
    console.log('      - The service will use mock Redis for development');
  } else if (error.code === 'ENOTFOUND') {
    console.log('\n💡 DNS resolution failed:');
    console.log('   - Check REDIS_HOST in .env file');
    console.log('   - Verify network connectivity');
  } else if (error.message.includes('timeout')) {
    console.log('\n💡 Connection timeout:');
    console.log('   - Check if Redis server is running');
    console.log('   - Verify firewall settings');
  }
  
  console.log('\n⚠️  The Matri service will continue with mock Redis functionality.');
}

process.exit(0);

#!/usr/bin/env node

import http from 'http';

const PORT = process.env.PORT || 3003;
const HOST = 'localhost';

console.log(`🔍 Checking Matri Service health at http://${HOST}:${PORT}/health...`);

const options = {
  hostname: HOST,
  port: PORT,
  path: '/health',
  method: 'GET',
  timeout: 5000
};

const req = http.request(options, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    try {
      const health = JSON.parse(data);
      
      console.log('\n✅ Service Health Check Results:');
      console.log(`   Status: ${health.status}`);
      console.log(`   Service: ${health.service}`);
      console.log(`   Version: ${health.version}`);
      console.log(`   Environment: ${health.environment}`);
      console.log(`   Uptime: ${Math.round(health.uptime)}s`);
      console.log(`   Timestamp: ${health.timestamp}`);
      
      if (health.status === 'healthy') {
        console.log('\n🎉 Matri Service is running successfully!');
        process.exit(0);
      } else {
        console.log('\n⚠️ Service is not healthy');
        process.exit(1);
      }
    } catch (error) {
      console.log('\n❌ Invalid health response:', data);
      process.exit(1);
    }
  });
});

req.on('error', (error) => {
  console.log('\n❌ Health check failed:');
  
  if (error.code === 'ECONNREFUSED') {
    console.log(`   Service is not running on port ${PORT}`);
    console.log('   Try running: npm run dev');
  } else if (error.code === 'ETIMEDOUT') {
    console.log('   Request timed out - service may be starting up');
  } else {
    console.log(`   ${error.message}`);
  }
  
  process.exit(1);
});

req.on('timeout', () => {
  req.destroy();
  console.log('\n⏰ Health check timed out');
  process.exit(1);
});

req.end();

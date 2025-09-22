#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('🚀 Starting Matri Service in Development Mode...\n');

// Check if .env file exists
const envPath = path.join(__dirname, '.env');
const envExamplePath = path.join(__dirname, '.env.example');
const envDevPath = path.join(__dirname, '.env.development');

if (!fs.existsSync(envPath)) {
  console.log('⚠️  .env file not found!');
  
  if (fs.existsSync(envDevPath)) {
    console.log('📋 Copying .env.development to .env...');
    fs.copyFileSync(envDevPath, envPath);
    console.log('✅ Created .env file from .env.development');
  } else if (fs.existsSync(envExamplePath)) {
    console.log('📋 Copying .env.example to .env...');
    fs.copyFileSync(envExamplePath, envPath);
    console.log('✅ Created .env file from .env.example');
    console.log('⚠️  Please update the .env file with your configuration');
  } else {
    console.log('❌ No environment template found!');
    process.exit(1);
  }
}

// Check logs directory
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  console.log('📁 Creating logs directory...');
  fs.mkdirSync(logsDir, { recursive: true });
  console.log('✅ Logs directory created');
}

console.log('\n🔧 Development Setup Complete!');
console.log('📋 Environment file: .env');
console.log('📊 Logs directory: logs/');

// Check if we should run dependency checks
if (!process.argv.includes('--skip-checks')) {
  console.log('\n🔍 Running dependency checks...');
  
  try {
    // Import and run checks
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    console.log('\n📊 Checking MongoDB...');
    try {
      await execAsync('node check-database.js');
    } catch (error) {
      console.log('⚠️  MongoDB check completed with warnings');
    }
    
    console.log('\n🔄 Checking Redis...');
    try {
      await execAsync('node check-redis.js');
    } catch (error) {
      console.log('⚠️  Redis check completed with warnings');
    }
    
  } catch (error) {
    console.log('⚠️  Dependency checks skipped:', error.message);
  }
}

console.log('\n💡 Tips:');
console.log('  - The service will work with or without MongoDB/Redis');
console.log('  - Mock services will be used if dependencies are unavailable');
console.log('  - Check logs/ directory for detailed error information');
console.log('  - Use npm run check-all to test dependencies manually');
console.log('\n🚀 Starting server...\n');

// Import and start the server
import('./server.js').catch(error => {
  console.error('❌ Failed to start server:', error);
  process.exit(1);
});

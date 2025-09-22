#!/usr/bin/env node

import mongoose from 'mongoose';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

console.log('🔍 Checking MongoDB connection...\n');

const mongoURI = process.env.NODE_ENV === 'test' 
  ? process.env.MONGODB_TEST_URI 
  : process.env.MONGODB_URI;

const defaultURI = 'mongodb://localhost:27017/matri-service';
const testURI = mongoURI || defaultURI;

console.log(`📋 MongoDB Configuration:`);
console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
console.log(`   URI: ${testURI.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}`);
console.log(`   Source: ${mongoURI ? 'Environment variable' : 'Default local'}`);
console.log('');

const options = {
  maxPoolSize: 5,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 10000,
  bufferMaxEntries: 0,
  bufferCommands: false,
  retryWrites: true,
  w: 'majority',
  
  // Authentication (only if credentials are provided)
  ...(testURI?.includes('@') && { authSource: 'admin' }),
  
  // SSL/TLS (only for production/cloud)
  ...(process.env.NODE_ENV === 'production' || testURI?.includes('mongodb+srv') ? {
    ssl: true,
    sslValidate: true,
  } : {}),
};

try {
  console.log('🔄 Attempting to connect to MongoDB...');
  
  const conn = await Promise.race([
    mongoose.connect(testURI, options),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Connection timeout after 8 seconds')), 8000)
    )
  ]);
  
  console.log(`✅ MongoDB connection successful!`);
  console.log(`   Host: ${conn.connection.host}`);
  console.log(`   Database: ${conn.connection.name}`);
  console.log(`   Ready State: ${conn.connection.readyState} (1 = connected)`);
  
  // Test basic operations
  console.log('\n🧪 Testing basic operations...');
  
  // Create a test collection
  const TestModel = mongoose.model('Test', new mongoose.Schema({
    message: String,
    timestamp: { type: Date, default: Date.now }
  }));
  
  // Insert test document
  const testDoc = new TestModel({ message: 'Connection test successful' });
  await testDoc.save();
  console.log('   ✅ Document insert: successful');
  
  // Query test document
  const foundDoc = await TestModel.findOne({ message: 'Connection test successful' });
  console.log(`   ✅ Document query: ${foundDoc ? 'successful' : 'failed'}`);
  
  // Clean up test document
  await TestModel.deleteOne({ _id: testDoc._id });
  console.log('   ✅ Document cleanup: successful');
  
  // Drop test collection
  await TestModel.collection.drop().catch(() => {}); // Ignore errors if collection doesn't exist
  
  await mongoose.connection.close();
  console.log('\n🎉 MongoDB is working correctly!');
  console.log('   The Matri service can connect to this database.');
  
} catch (error) {
  console.log(`❌ MongoDB connection failed:`);
  console.log(`   Error: ${error.message}`);
  
  if (error.message.includes('ECONNREFUSED')) {
    console.log('\n💡 Connection refused - possible solutions:');
    console.log('   1. Install MongoDB locally:');
    console.log('      - Download: https://www.mongodb.com/try/download/community');
    console.log('      - Or use Docker: docker run -d -p 27017:27017 mongo');
    console.log('');
    console.log('   2. Start MongoDB service:');
    console.log('      - Windows: net start MongoDB');
    console.log('      - macOS: brew services start mongodb-community');
    console.log('      - Linux: sudo systemctl start mongod');
    console.log('');
    console.log('   3. Use MongoDB Atlas (cloud):');
    console.log('      - Sign up at: https://www.mongodb.com/atlas');
    console.log('      - Update MONGODB_URI in .env file');
    console.log('');
    console.log('   4. Continue without MongoDB:');
    console.log('      - The service will use mock database for development');
    
  } else if (error.message.includes('ENOTFOUND')) {
    console.log('\n💡 DNS resolution failed:');
    console.log('   - Check MONGODB_URI in .env file');
    console.log('   - Verify network connectivity');
    console.log('   - Check if the hostname is correct');
    
  } else if (error.message.includes('timeout')) {
    console.log('\n💡 Connection timeout:');
    console.log('   - Check if MongoDB server is running');
    console.log('   - Verify firewall settings');
    console.log('   - Check network connectivity');
    
  } else if (error.message.includes('authentication')) {
    console.log('\n💡 Authentication failed:');
    console.log('   - Check username and password in MONGODB_URI');
    console.log('   - Verify database permissions');
    console.log('   - Check if authSource is correct');
  }
  
  console.log('\n⚠️  The Matri service will continue with mock database functionality.');
}

process.exit(0);

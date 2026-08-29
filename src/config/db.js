const mongoose = require('mongoose');
const config = require('./env');

let memoryServer;

const connectDB = async () => {
  try {
    let uri = config.mongodb.uri;
    
    // Completely wipe out any retryWrites=true that might be in the string
    uri = uri.replace(/retryWrites=true/gi, 'retryWrites=false');
    
    // If it's still completely missing, append it safely
    if (!uri.includes('retryWrites=false')) {
      uri += uri.includes('?') ? '&retryWrites=false' : '?retryWrites=false';
    }
    
    const conn = await mongoose.connect(uri);
    console.log(`MongoDB Connected: ${conn.connection.host}`);
    return conn;
  } catch (error) {
    if (config.env !== 'development') {
      console.error(`Error connecting to MongoDB: ${error.message}`);
      process.exit(1);
    }

    try {
      const { MongoMemoryServer } = require('mongodb-memory-server');
      memoryServer = await MongoMemoryServer.create();
      const conn = await mongoose.connect(memoryServer.getUri());
      console.warn(
        'MongoDB Atlas/local unreachable — using in-memory database for development.'
      );
      console.log(`MongoDB Connected: ${conn.connection.host}`);
      return conn;
    } catch (memError) {
      console.error(`Error connecting to MongoDB: ${error.message}`);
      console.error(`In-memory fallback failed: ${memError.message}`);
      process.exit(1);
    }
  }
};

module.exports = connectDB;

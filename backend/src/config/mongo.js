const mongoose = require('mongoose');
const config = require('./index');
const logger = require('../utils/logger');

mongoose.set('strictQuery', true);

async function connectMongo() {
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10000 });
  logger.info('MongoDB connected');
  return mongoose.connection;
}

async function disconnectMongo() {
  await mongoose.disconnect();
}

async function pingMongo() {
  if (mongoose.connection.readyState !== 1) throw new Error('MongoDB not connected');
  await mongoose.connection.db.admin().ping();
}

module.exports = { connectMongo, disconnectMongo, pingMongo };

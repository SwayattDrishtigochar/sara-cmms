import mongoose from 'mongoose';
import { env } from './env.js';

mongoose.set('strictQuery', true);

export const connectMongo = async (uri = env.MONGO_URI) => {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  return mongoose.connection;
};

export const disconnectMongo = () => mongoose.disconnect();

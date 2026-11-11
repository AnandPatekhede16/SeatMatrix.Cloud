import dotenv from 'dotenv';
dotenv.config();

export const CONFIG = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT || '3000', 10),
  
  // AWS Configuration
  AWS_REGION: process.env.AWS_REGION || 'us-east-1',
  DYNAMODB_EVENTS_TABLE: process.env.DYNAMODB_EVENTS_TABLE || 'EventsInventory',
  DYNAMODB_BOOKINGS_TABLE: process.env.DYNAMODB_BOOKINGS_TABLE || 'Bookings',
  DYNAMODB_IDEMPOTENCY_TABLE: process.env.DYNAMODB_IDEMPOTENCY_TABLE || 'IdempotencyKeys',
  SQS_QUEUE_URL: process.env.SQS_QUEUE_URL || '',

  // Redis Configuration (Upstash Serverless Redis or AWS ElastiCache / Local Redis)
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',

  // Reservation Lock TTL in seconds (e.g., 300s = 5 minutes hold before release)
  RESERVATION_TTL_SECONDS: parseInt(process.env.RESERVATION_TTL_SECONDS || '300', 10),
};

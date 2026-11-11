import { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { dynamoService } from '../services/dynamoService';
import { redisService } from '../services/redisService';
import { BookingRecord, QueueMessage } from '../types';

export async function processQueueMessage(message: QueueMessage): Promise<void> {
  console.log(`[Worker] Processing reservation for bookingId: ${message.bookingId}, eventId: ${message.eventId}`);

  const bookingRecord: BookingRecord = {
    bookingId: message.bookingId,
    eventId: message.eventId,
    userId: message.userId,
    ticketCount: message.ticketCount,
    status: 'RESERVED',
    createdAt: message.timestamp,
    expiresAt: message.expiresAt,
  };

  // Attempt atomic DynamoDB transaction write
  const transactionSuccess = await dynamoService.createReservationTransaction(bookingRecord);

  if (!transactionSuccess) {
    console.error(`[Worker] DynamoDB Transaction failed for bookingId: ${message.bookingId}. Reverting Redis stock.`);
    // Rollback Redis stock
    await redisService.releaseTickets(message.eventId, message.bookingId, message.ticketCount);
    throw new Error(`Database transaction failed for booking: ${message.bookingId}`);
  }

  console.log(`[Worker] Successfully reserved booking in DynamoDB: ${message.bookingId}`);
}

// AWS Lambda SQS Event Handler
export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      const message: QueueMessage = JSON.parse(record.body);
      await processQueueMessage(message);
    } catch (err) {
      console.error(`Failed processing message ${record.messageId}:`, err);
      // Report failure back to SQS for automatic retry / DLQ
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};

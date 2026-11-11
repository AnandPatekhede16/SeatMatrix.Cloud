import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { CONFIG } from '../config/env';
import { QueueMessage } from '../types';

class SQSService {
  private client: SQSClient | null = null;
  private isAWSAvailable = false;
  // Local mock message handler
  private mockWorkers: ((message: QueueMessage) => Promise<void>)[] = [];

  constructor() {
    this.init();
  }

  private init() {
    try {
      if (CONFIG.SQS_QUEUE_URL && (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE || process.env.AWS_REGION)) {
        this.client = new SQSClient({ region: CONFIG.AWS_REGION });
        this.isAWSAvailable = true;
      }
    } catch (err) {
      this.isAWSAvailable = false;
    }
  }

  /**
   * Register a local worker callback for testing when SQS is not available in local mode
   */
  public registerLocalWorker(handler: (message: QueueMessage) => Promise<void>) {
    this.mockWorkers.push(handler);
  }

  /**
   * Publish a message to SQS Queue (Order Fulfillment)
   */
  async enqueueReservation(message: QueueMessage): Promise<void> {
    if (this.isAWSAvailable && this.client && CONFIG.SQS_QUEUE_URL) {
      await this.client.send(
        new SendMessageCommand({
          QueueUrl: CONFIG.SQS_QUEUE_URL,
          MessageBody: JSON.stringify(message),
          MessageAttributes: {
            EventId: { DataType: 'String', StringValue: message.eventId },
            BookingId: { DataType: 'String', StringValue: message.bookingId },
          },
        })
      );
    } else {
      // Async local mock processing
      setImmediate(async () => {
        for (const worker of this.mockWorkers) {
          try {
            await worker(message);
          } catch (err) {
            console.error('Error in mock SQS worker execution:', err);
          }
        }
      });
    }
  }
}

export const sqsService = new SQSService();

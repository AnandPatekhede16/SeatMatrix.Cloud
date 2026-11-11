import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { CONFIG } from '../config/env';
import { BookingRecord, EventInventory } from '../types';

class DynamoService {
  private docClient: DynamoDBDocumentClient | null = null;
  private isAWSAvailable = false;
  // Local in-memory mock store
  private mockEvents: Map<string, EventInventory> = new Map();
  private mockBookings: Map<string, BookingRecord> = new Map();

  constructor() {
    this.init();
  }

  private init() {
    try {
      if (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE || process.env.AWS_REGION) {
        const client = new DynamoDBClient({ region: CONFIG.AWS_REGION });
        this.docClient = DynamoDBDocumentClient.from(client);
        this.isAWSAvailable = true;
      }
    } catch (err) {
      this.isAWSAvailable = false;
    }
  }

  /**
   * Save or update an event in DynamoDB
   */
  async saveEvent(event: EventInventory): Promise<void> {
    if (this.isAWSAvailable && this.docClient && process.env.USE_LOCAL_MOCK !== 'true') {
      try {
        await this.docClient.send(
          new PutCommand({
            TableName: CONFIG.DYNAMODB_EVENTS_TABLE,
            Item: event,
          })
        );
        return;
      } catch (err: any) {
        console.warn(`⚠️ AWS DynamoDB error (${err.name || err.message}). Using local in-memory store for event.`);
      }
    }
    this.mockEvents.set(event.eventId, { ...event });
  }

  /**
   * Retrieve event details
   */
  async getEvent(eventId: string): Promise<EventInventory | null> {
    if (this.isAWSAvailable && this.docClient && process.env.USE_LOCAL_MOCK !== 'true') {
      try {
        const res = await this.docClient.send(
          new GetCommand({
            TableName: CONFIG.DYNAMODB_EVENTS_TABLE,
            Key: { eventId },
          })
        );
        if (res.Item) {
          return res.Item as EventInventory;
        }
      } catch (err: any) {
        console.warn(`⚠️ AWS DynamoDB error (${err.name || err.message}). Reading from local mock.`);
      }
    }
    return this.mockEvents.get(eventId) || null;
  }

  /**
   * Atomic ACID Transaction: Decrement available seats AND insert new booking record
   * Using DynamoDB TransactWriteItems
   */
  async createReservationTransaction(booking: BookingRecord): Promise<boolean> {
    if (this.isAWSAvailable && this.docClient && process.env.USE_LOCAL_MOCK !== 'true') {
      try {
        await this.docClient.send(
          new TransactWriteCommand({
            TransactItems: [
              // 1. Condition check & decrement availableSeats
              {
                Update: {
                  TableName: CONFIG.DYNAMODB_EVENTS_TABLE,
                  Key: { eventId: booking.eventId },
                  UpdateExpression: 'SET availableSeats = availableSeats - :count',
                  ConditionExpression: 'availableSeats >= :count',
                  ExpressionAttributeValues: {
                    ':count': booking.ticketCount,
                  },
                },
              },
              // 2. Put new booking record
              {
                Put: {
                  TableName: CONFIG.DYNAMODB_BOOKINGS_TABLE,
                  Item: booking,
                },
              },
            ],
          })
        );
        return true;
      } catch (err: any) {
        if (err.name === 'TransactionCanceledException') {
          console.warn('DynamoDB Transaction Cancelled: Insufficient seats or race condition detected.');
          return false;
        }
        console.warn(`⚠️ AWS DynamoDB TransactWrite error (${err.name || err.message}). Falling back to local mock.`);
      }
    }
    
    // Mock transactional behavior locally
    const event = this.mockEvents.get(booking.eventId);
    if (!event || event.availableSeats < booking.ticketCount) {
      return false;
    }
    event.availableSeats -= booking.ticketCount;
    this.mockEvents.set(booking.eventId, event);
    this.mockBookings.set(booking.bookingId, { ...booking });
    return true;
  }

  /**
   * Atomic increment of available seats (e.g. upon cancellation or restock)
   */
  async incrementEventSeats(eventId: string, count: number): Promise<void> {
    if (this.isAWSAvailable && this.docClient && process.env.USE_LOCAL_MOCK !== 'true') {
      try {
        await this.docClient.send(
          new UpdateCommand({
            TableName: CONFIG.DYNAMODB_EVENTS_TABLE,
            Key: { eventId },
            UpdateExpression: 'SET availableSeats = availableSeats + :count',
            ExpressionAttributeValues: { ':count': count },
          })
        );
        return;
      } catch (err: any) {
        console.warn(`⚠️ AWS DynamoDB incrementEventSeats error: ${err.message}`);
      }
    }
    const event = this.mockEvents.get(eventId);
    if (event) {
      event.availableSeats += count;
      this.mockEvents.set(eventId, event);
    }
  }

  /**
   * Update booking status (e.g., CONFIRMED, CANCELLED)
   */
  async updateBookingStatus(
    bookingId: string,
    status: BookingRecord['status']
  ): Promise<BookingRecord | null> {
    if (this.isAWSAvailable && this.docClient && process.env.USE_LOCAL_MOCK !== 'true') {
      try {
        const res = await this.docClient.send(
          new UpdateCommand({
            TableName: CONFIG.DYNAMODB_BOOKINGS_TABLE,
            Key: { bookingId },
            UpdateExpression: 'SET #st = :status',
            ExpressionAttributeNames: { '#st': 'status' },
            ExpressionAttributeValues: { ':status': status },
            ReturnValues: 'ALL_NEW',
          })
        );
        return (res.Attributes as BookingRecord) || null;
      } catch (err: any) {
        console.warn(`⚠️ AWS DynamoDB UpdateCommand error (${err.name || err.message}). Updating local mock.`);
      }
    }
    const booking = this.mockBookings.get(bookingId);
    if (booking) {
      booking.status = status;
      this.mockBookings.set(bookingId, booking);
      return booking;
    }
    return null;
  }

  /**
   * Get booking details
   */
  async getBooking(bookingId: string): Promise<BookingRecord | null> {
    if (this.isAWSAvailable && this.docClient && process.env.USE_LOCAL_MOCK !== 'true') {
      try {
        const res = await this.docClient.send(
          new GetCommand({
            TableName: CONFIG.DYNAMODB_BOOKINGS_TABLE,
            Key: { bookingId },
          })
        );
        if (res.Item) {
          return res.Item as BookingRecord;
        }
      } catch (err: any) {
        console.warn(`⚠️ AWS DynamoDB GetCommand error (${err.name || err.message}). Reading local mock.`);
      }
    }
    return this.mockBookings.get(bookingId) || null;
  }
}

export const dynamoService = new DynamoService();

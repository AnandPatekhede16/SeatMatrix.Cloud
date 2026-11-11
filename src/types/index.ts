export interface ReservationRequest {
  eventId: string;
  userId: string;
  ticketCount: number;
}

export type ReservationStatus = 'PENDING' | 'RESERVED' | 'CONFIRMED' | 'EXPIRED' | 'CANCELLED';

export interface BookingRecord {
  bookingId: string;
  eventId: string;
  userId: string;
  ticketCount: number;
  status: ReservationStatus;
  createdAt: string;
  expiresAt: number; // Unix timestamp in seconds (DynamoDB TTL)
}

export interface EventInventory {
  eventId: string;
  name: string;
  totalSeats: number;
  availableSeats: number;
  pricePerSeat: number;
  version: number; // Optimistic locking
}

export interface IdempotencyRecord {
  idempotencyKey: string;
  statusCode: number;
  responseBody: string;
  createdAt: number;
  ttl: number; // DynamoDB TTL timestamp
}

export interface QueueMessage {
  bookingId: string;
  eventId: string;
  userId: string;
  ticketCount: number;
  expiresAt: number;
  timestamp: string;
}

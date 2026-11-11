import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { CONFIG } from '../config/env';
import { dynamoService } from '../services/dynamoService';
import { idempotencyService } from '../services/idempotencyService';
import { redisService } from '../services/redisService';
import { sqsService } from '../services/sqsService';
import { ReservationRequest, QueueMessage } from '../types';
import { errorResponse, successResponse, ApiResponse } from '../utils/response';

export async function processReservation(
  body: ReservationRequest,
  idempotencyKey?: string
): Promise<ApiResponse> {
  // 1. Check Idempotency Key (Return cached response if already processed)
  if (idempotencyKey) {
    const cachedResponse = await idempotencyService.getCachedResponse(idempotencyKey);
    if (cachedResponse) {
      console.log(`[Idempotency] Returning cached response for key: ${idempotencyKey}`);
      return cachedResponse;
    }
  }

  const { eventId, userId, ticketCount = 1 } = body;

  if (!eventId || !userId || ticketCount <= 0) {
    return errorResponse('Invalid parameters. eventId, userId, and ticketCount > 0 are required', 400);
  }

  const bookingId = uuidv4();
  const expiresAt = Math.floor(Date.now() / 1000) + CONFIG.RESERVATION_TTL_SECONDS;

  // 2. High-speed atomic inventory check and lock via Redis
  let { success, remainingSeats } = await redisService.reserveTickets(
    eventId,
    bookingId,
    ticketCount,
    CONFIG.RESERVATION_TTL_SECONDS
  );

  // Cache-Aside cold start sync: If Redis was empty/cold, check DynamoDB source-of-truth
  if (!success) {
    const event = await dynamoService.getEvent(eventId);
    if (event && event.availableSeats >= ticketCount) {
      await redisService.setInventory(eventId, event.availableSeats);
      const retry = await redisService.reserveTickets(
        eventId,
        bookingId,
        ticketCount,
        CONFIG.RESERVATION_TTL_SECONDS
      );
      success = retry.success;
      remainingSeats = retry.remainingSeats;
    }
  }

  if (!success) {
    const soldOutResponse = errorResponse('Sold Out: Insufficient tickets available', 409, {
      remainingSeats,
    });
    if (idempotencyKey) {
      await idempotencyService.saveResponse(idempotencyKey, soldOutResponse);
    }
    return soldOutResponse;
  }

  // 3. Queue the reservation asynchronously for background persistence (SQS)
  const message: QueueMessage = {
    bookingId,
    eventId,
    userId,
    ticketCount,
    expiresAt,
    timestamp: new Date().toISOString(),
  };

  await sqsService.enqueueReservation(message);

  // Directly write reservation to DynamoDB for instant real-time consistency across all clients
  try {
    await dynamoService.createReservationTransaction({
      bookingId,
      eventId,
      userId,
      ticketCount,
      status: 'RESERVED',
      createdAt: message.timestamp,
      expiresAt,
    });
  } catch (err: any) {
    console.warn(`[Reserve] Immediate DynamoDB write notice: ${err.message}`);
  }

  const response = successResponse(
    {
      message: 'Ticket reservation temporarily held. Please complete payment within the TTL window.',
      bookingId,
      eventId,
      userId,
      ticketCount,
      remainingSeats,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      expiresInSeconds: CONFIG.RESERVATION_TTL_SECONDS,
    },
    202 // 202 Accepted
  );

  // 4. Save response to Idempotency cache
  if (idempotencyKey) {
    await idempotencyService.saveResponse(idempotencyKey, response);
  }

  return response;
}

// AWS Lambda Handler entrypoint
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const idempotencyKey =
      event.headers?.['idempotency-key'] ||
      event.headers?.['Idempotency-Key'] ||
      event.headers?.['IDEMPOTENCY-KEY'];

    const body: ReservationRequest = event.body ? JSON.parse(event.body) : {};
    return await processReservation(body, idempotencyKey);
  } catch (error: any) {
    console.error('Unhandled reservation error:', error);
    return errorResponse('Internal Server Error', 500, error.message);
  }
};

import {
  DeleteItemCommand,
  DynamoDBClient,
  PutItemCommand,
  ScanCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { CONFIG } from '../config/env';
import { dynamoService } from '../services/dynamoService';
import { redisService } from '../services/redisService';
import { EventInventory } from '../types';
import { errorResponse, successResponse } from '../utils/response';

const dynamoClient = new DynamoDBClient({ region: CONFIG.AWS_REGION });

// 1. Fetch all bookings from DynamoDB
export async function getAllBookings() {
  try {
    const res = await dynamoClient.send(
      new ScanCommand({
        TableName: CONFIG.DYNAMODB_BOOKINGS_TABLE,
        Limit: 100,
      })
    );
    const items = (res.Items || []).map((i) => unmarshall(i));
    // Sort recent first
    items.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
    return successResponse(items);
  } catch (err: any) {
    console.error('Scan bookings error:', err);
    return errorResponse(err.message, 500);
  }
}

// 2. Admin: Create a brand new show with custom category, poster image, seats, pricing
export async function createNewEvent(body: any) {
  const { name, category, venue, city, date, price, totalSeats, imageUrl, desc } = body;

  if (!name || !category || !totalSeats) {
    return errorResponse('Name, category, and totalSeats are required', 400);
  }

  const eventId = `event-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}-${Date.now().toString().slice(-4)}`;
  const seats = parseInt(totalSeats, 10);
  const ticketPrice = parseInt(price, 10) || 120;

  const newEvent: any = {
    eventId,
    name,
    category,
    venue: venue || 'Arena Stadium',
    city: city || 'Mumbai',
    date: date || 'Dec 2026',
    pricePerSeat: ticketPrice,
    totalSeats: seats,
    availableSeats: seats,
    imageUrl: imageUrl || '',
    desc: desc || `Live ${category} event featuring ${name}.`,
    version: 1,
    createdAt: new Date().toISOString(),
  };

  // Save to DynamoDB
  await dynamoClient.send(
    new PutItemCommand({
      TableName: CONFIG.DYNAMODB_EVENTS_TABLE,
      Item: marshall(newEvent),
    })
  );

  // Initialize Redis Atomic Cache
  await redisService.setInventory(eventId, seats);

  console.log(`[Admin] Created new event ${eventId} with ${seats} seats.`);
  return successResponse({
    message: `Show '${name}' published live to catalog!`,
    event: newEvent,
  });
}

// 3. Admin: Update capacity or restock
export async function updateEventCapacity(body: any) {
  const { eventId, totalSeats, pricePerSeat } = body;
  if (!eventId || totalSeats === undefined) {
    return errorResponse('eventId and totalSeats are required', 400);
  }

  const existing = (await dynamoService.getEvent(eventId)) || {
    eventId,
    name: body.name || eventId,
    totalSeats,
    availableSeats: totalSeats,
    pricePerSeat: pricePerSeat || 120,
    version: 1,
  };

  existing.totalSeats = totalSeats;
  existing.availableSeats = totalSeats;
  if (pricePerSeat) existing.pricePerSeat = pricePerSeat;

  await dynamoService.saveEvent(existing);
  await redisService.setInventory(eventId, totalSeats);

  return successResponse({
    message: `Event ${eventId} capacity successfully set to ${totalSeats} seats.`,
    event: existing,
  });
}

// 4. Admin: Delete / Cancel a show
export async function deleteEvent(eventId: string) {
  if (!eventId) return errorResponse('eventId is required', 400);

  try {
    await dynamoClient.send(
      new DeleteItemCommand({
        TableName: CONFIG.DYNAMODB_EVENTS_TABLE,
        Key: { eventId: { S: eventId } },
      })
    );
    return successResponse({ message: `Event ${eventId} removed from catalog.` });
  } catch (err: any) {
    return errorResponse(err.message, 500);
  }
}

export const handler = async (event: any): Promise<APIGatewayProxyResult> => {
  const method = event.httpMethod || event.requestContext?.http?.method;
  const path = event.path || event.requestContext?.http?.path;

  // GET /admin/bookings
  if (method === 'GET' && path?.includes('/bookings')) {
    return await getAllBookings();
  }

  // POST /admin/create-event
  if (method === 'POST' && path?.includes('/create-event')) {
    try {
      const body = event.body ? JSON.parse(event.body) : {};
      return await createNewEvent(body);
    } catch (err: any) {
      return errorResponse(err.message, 400);
    }
  }

  // POST /admin/update-event
  if (method === 'POST') {
    try {
      const body = event.body ? JSON.parse(event.body) : {};
      return await updateEventCapacity(body);
    } catch (err: any) {
      return errorResponse(err.message, 400);
    }
  }

  // DELETE /admin/events/{eventId}
  if (method === 'DELETE') {
    const eventId = event.pathParameters?.eventId;
    return await deleteEvent(eventId);
  }

  return errorResponse('Not Found', 404);
};

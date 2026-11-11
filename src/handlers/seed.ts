import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { dynamoService } from '../services/dynamoService';
import { redisService } from '../services/redisService';
import { EventInventory } from '../types';
import { errorResponse, successResponse } from '../utils/response';

export async function processSeed(body: any) {
  const eventId = body?.eventId || 'event-coldplay-2026';
  const totalSeats = body?.totalSeats || 10;
  const name = body?.name || 'Coldplay Music of the Spheres World Tour';
  const pricePerSeat = body?.pricePerSeat || 120;

  const eventData: EventInventory = {
    eventId,
    name,
    totalSeats,
    availableSeats: totalSeats,
    pricePerSeat,
    version: 1,
  };

  await dynamoService.saveEvent(eventData);
  await redisService.setInventory(eventId, totalSeats);

  return successResponse({
    message: 'Event seeded successfully!',
    event: eventData,
  });
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    return await processSeed(body);
  } catch (err: any) {
    console.error('Seed error:', err);
    return errorResponse(err.message, 500);
  }
};

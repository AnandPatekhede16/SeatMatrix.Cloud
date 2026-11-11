import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { CONFIG } from '../config/env';
import { dynamoService } from '../services/dynamoService';
import { redisService } from '../services/redisService';
import { errorResponse, successResponse, ApiResponse } from '../utils/response';

const dynamoClient = new DynamoDBClient({ region: CONFIG.AWS_REGION });

export async function processGetEvent(eventId?: string): Promise<ApiResponse> {
  // If no eventId specified or 'all', return all events from DynamoDB
  if (!eventId || eventId === 'all') {
    try {
      const scanRes = await dynamoClient.send(
        new ScanCommand({
          TableName: CONFIG.DYNAMODB_EVENTS_TABLE,
          Limit: 50,
        })
      );

      let items = (scanRes.Items || []).map((i) => unmarshall(i));

      // If DynamoDB is fresh, seed defaults
      if (items.length === 0) {
        const defaults = [
          { eventId: 'event-coldplay-2026', name: 'Coldplay: Music of the Spheres Tour', category: 'Concerts & Gigs', totalSeats: 10, availableSeats: 10, pricePerSeat: 120, venue: 'DY Patil Stadium, Navi Mumbai', city: 'Mumbai', date: 'Nov 20, 2026', version: 1 },
          { eventId: 'event-diljit-2026', name: 'Diljit Dosanjh: Dil-Luminati Tour', category: 'Concerts & Gigs', totalSeats: 15, availableSeats: 15, pricePerSeat: 2499, venue: 'JLN Stadium, New Delhi', city: 'New Delhi', date: 'Dec 15, 2026', version: 1 },
          { eventId: 'event-zakir-2026', name: 'Zakir Khan: Papa Yaar Special', category: 'Standup Comedy', totalSeats: 20, availableSeats: 20, pricePerSeat: 999, venue: 'NCPA Auditorium, Mumbai', city: 'Mumbai', date: 'Jan 12, 2027', version: 1 },
          { eventId: 'event-ipl-2026', name: 'IPL 2026 Final: MI vs CSK', category: 'Cricket & Sports', totalSeats: 8, availableSeats: 8, pricePerSeat: 1500, venue: 'Wankhede Stadium, Mumbai', city: 'Mumbai', date: 'May 24, 2026', version: 1 },
          { eventId: 'event-sunburn-2026', name: 'Sunburn Goa 2026 Festival', category: 'Music Festivals', totalSeats: 25, availableSeats: 25, pricePerSeat: 3999, venue: 'Vagator Beach, Goa', city: 'Goa', date: 'Dec 28, 2026', version: 1 },
          { eventId: 'event-mughal-2026', name: 'Mughal-e-Azam: The Musical', category: 'Theatre & Drama', totalSeats: 12, availableSeats: 12, pricePerSeat: 1200, venue: 'Jamshed Bhabha Theatre, Mumbai', city: 'Mumbai', date: 'Nov 30, 2026', version: 1 },
        ];

        for (const def of defaults) {
          await dynamoService.saveEvent(def);
          await redisService.setInventory(def.eventId, def.totalSeats);
        }
        items = defaults;
      }

      // Sync live available seats from Redis cache and DynamoDB
      const enriched = await Promise.all(
        items.map(async (item: any) => {
          let avail = await redisService.getInventory(item.eventId);
          if (avail === undefined || avail === null) {
            avail = item.availableSeats;
          }
          return {
            ...item,
            availableSeats: avail !== undefined ? avail : item.availableSeats,
          };
        })
      );

      return successResponse(enriched);
    } catch (err: any) {
      console.error('Scan events error:', err);
      return errorResponse(err.message, 500);
    }
  }

  // 1. Fetch single event metadata from DynamoDB (Source of Truth)
  const event = await dynamoService.getEvent(eventId);

  if (!event) {
    return errorResponse(`Event with ID ${eventId} not found`, 404);
  }

  // 2. Read real-time inventory from Redis cache
  let availableSeats = await redisService.getInventory(eventId);

  // Cache-Aside sync: If cache is cold/empty, sync from DynamoDB
  if (availableSeats === undefined && event.availableSeats !== undefined) {
    await redisService.setInventory(eventId, event.availableSeats);
    availableSeats = event.availableSeats;
  }

  return successResponse({
    eventId: event.eventId,
    name: event.name,
    totalSeats: event.totalSeats,
    availableSeats, // Real-time value
    pricePerSeat: event.pricePerSeat,
  });
}

// AWS Lambda Handler entrypoint
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const eventId = event.pathParameters?.eventId || (event.queryStringParameters?.eventId as string);
    return await processGetEvent(eventId);
  } catch (err: any) {
    console.error('Error fetching event:', err);
    return errorResponse('Internal Server Error', 500, err.message);
  }
};

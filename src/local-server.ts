import express, { Request, Response } from 'express';
import path from 'path';
import { CONFIG } from './config/env';
import { processGetEvent } from './handlers/getEvent';
import { processPaymentWebhook } from './handlers/payment';
import { processReservation } from './handlers/reserve';
import { getAllBookings, createNewEvent, updateEventCapacity } from './handlers/admin';
import { processQueueMessage } from './handlers/worker';
import { dynamoService } from './services/dynamoService';
import { redisService } from './services/redisService';
import { sqsService } from './services/sqsService';
import { EventInventory } from './types';

const app = express();
app.use(express.json());

// Serve static frontend files from 'public' directory
app.use(express.static(path.join(__dirname, '../../public')));
app.use(express.static(path.join(process.cwd(), 'public')));

// Register background SQS worker for local emulation
sqsService.registerLocalWorker(async (msg) => {
  await processQueueMessage(msg);
});

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get Event & Real-time Inventory
app.get('/events/:eventId', async (req: Request, res: Response) => {
  const result = await processGetEvent(req.params.eventId);
  res.status(result.statusCode).json(JSON.parse(result.body));
});

// Reserve Ticket (High Concurrency Endpoint)
app.post('/reserve', async (req: Request, res: Response) => {
  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
  const result = await processReservation(req.body, idempotencyKey);
  res.status(result.statusCode).json(JSON.parse(result.body));
});

// Payment Webhook (Confirm or Cancel)
app.post('/payment-webhook', async (req: Request, res: Response) => {
  try {
    const result = await processPaymentWebhook(req.body);
    res.status(result.statusCode).json(JSON.parse(result.body));
  } catch (err: any) {
    console.error('Payment webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin routes
app.get('/admin/bookings', async (req: Request, res: Response) => {
  try {
    const result = await getAllBookings();
    res.status(result.statusCode).json(JSON.parse(result.body));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/create-event', async (req: Request, res: Response) => {
  try {
    const result = await createNewEvent(req.body);
    res.status(result.statusCode).json(JSON.parse(result.body));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/update-event', async (req: Request, res: Response) => {
  try {
    const result = await updateEventCapacity(req.body);
    res.status(result.statusCode).json(JSON.parse(result.body));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Seed an initial event for testing
app.post('/admin/seed', async (req: Request, res: Response) => {
  try {
    const eventId = req.body.eventId || 'event-coldplay-2026';
    const totalSeats = req.body.totalSeats || 10;
    const name = req.body.name || 'Coldplay Music of the Spheres World Tour';
    const pricePerSeat = req.body.pricePerSeat || 150;

    const eventData: EventInventory = {
      eventId,
      name,
      totalSeats,
      availableSeats: totalSeats,
      pricePerSeat,
      version: 1,
    };

    // Seed into DynamoDB and Redis
    await dynamoService.saveEvent(eventData);
    await redisService.setInventory(eventId, totalSeats);

    res.json({
      message: 'Event seeded successfully!',
      event: eventData,
    });
  } catch (err: any) {
    console.error('Seed error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(CONFIG.PORT, async () => {
  console.log(`=======================================================`);
  console.log(`🚀 Distributed Ticket Booking Server running on http://localhost:${CONFIG.PORT}`);
  console.log(`   Health Check: GET  http://localhost:${CONFIG.PORT}/health`);
  console.log(`   Seed Event:   POST http://localhost:${CONFIG.PORT}/admin/seed`);
  console.log(`   Get Event:    GET  http://localhost:${CONFIG.PORT}/events/:eventId`);
  console.log(`   Reserve:      POST http://localhost:${CONFIG.PORT}/reserve`);
  console.log(`   Payment:      POST http://localhost:${CONFIG.PORT}/payment-webhook`);
  console.log(`=======================================================`);
});

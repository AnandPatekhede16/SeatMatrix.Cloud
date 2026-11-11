import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { dynamoService } from '../services/dynamoService';
import { redisService } from '../services/redisService';
import { errorResponse, successResponse, ApiResponse } from '../utils/response';

export interface PaymentWebhookPayload {
  bookingId: string;
  status: 'SUCCESS' | 'FAILED';
  utr?: string;
  paymentMethod?: string;
}

export async function processPaymentWebhook(payload: PaymentWebhookPayload): Promise<ApiResponse> {
  const { bookingId, status, utr, paymentMethod } = payload;

  if (!bookingId || !status) {
    return errorResponse('bookingId and status (SUCCESS or FAILED) are required', 400);
  }

  const booking = await dynamoService.getBooking(bookingId);
  if (!booking) {
    return errorResponse(`Booking with ID ${bookingId} not found`, 404);
  }

  if (booking.status === 'CONFIRMED') {
    return successResponse({ message: 'Booking already confirmed', booking });
  }

  if (status === 'SUCCESS') {
    // 1. Confirm reservation in Redis (remove temporary hold key)
    await redisService.confirmReservation(bookingId);

    // 2. Update status in DynamoDB to CONFIRMED with UTR reference
    const updated = await dynamoService.updateBookingStatus(bookingId, 'CONFIRMED', {
      utr: utr || 'N/A (Direct)',
      paymentMethod: paymentMethod || 'UPI',
    });

    console.log(`[Payment] Booking ${bookingId} confirmed successfully with UTR: ${utr || 'N/A'}`);
    return successResponse({
      message: 'Payment verified and ticket booking CONFIRMED.',
      booking: updated,
    });
  } else {
    // Payment failed or cancelled: Release tickets back to available pool
    await redisService.releaseTickets(booking.eventId, bookingId, booking.ticketCount);
    await dynamoService.incrementEventSeats(booking.eventId, booking.ticketCount);

    // Mark as CANCELLED in DynamoDB
    const updated = await dynamoService.updateBookingStatus(bookingId, 'CANCELLED');

    console.log(`[Payment] Payment failed for booking ${bookingId}. Released ${booking.ticketCount} tickets back to pool.`);
    return successResponse({
      message: 'Payment failed. Reservation cancelled and tickets released back to available pool.',
      booking: updated,
    });
  }
}

// AWS Lambda Handler entrypoint
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const payload: PaymentWebhookPayload = event.body ? JSON.parse(event.body) : {};
    return await processPaymentWebhook(payload);
  } catch (err: any) {
    console.error('Payment webhook error:', err);
    return errorResponse('Internal Server Error', 500, err.message);
  }
};

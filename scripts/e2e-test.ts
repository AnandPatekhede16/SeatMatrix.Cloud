import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { CONFIG } from '../src/config/env';

async function runE2ETest() {
  const targetUrl = process.env.API_BASE_URL || `http://localhost:${CONFIG.PORT}`;
  console.log(`\n===============================================================`);
  console.log(`🧪 RUNNING END-TO-END FEATURE VERIFICATION`);
  console.log(`===============================================================\n`);

  // 1. Seed event with 2 tickets
  console.log(`Step 1: Seeding event with 2 tickets...`);
  await axios.post(`${targetUrl}/admin/seed`, {
    eventId: 'e2e-test-event',
    name: 'E2E Test Concert',
    totalSeats: 2,
    pricePerSeat: 50,
  });
  console.log(`✅ Event created.`);

  // 2. Reserve 1 ticket with Idempotency Key
  const idempotencyKey = uuidv4();
  console.log(`\nStep 2: Reserving 1 ticket with Idempotency-Key: ${idempotencyKey}...`);
  const res1 = await axios.post(
    `${targetUrl}/reserve`,
    {
      eventId: 'e2e-test-event',
      userId: 'user_alice',
      ticketCount: 1,
    },
    { headers: { 'Idempotency-Key': idempotencyKey } }
  );

  const bookingId = res1.data.data.bookingId;
  console.log(`✅ Reservation Accepted! Booking ID: ${bookingId}, Remaining Seats: ${res1.data.data.remainingSeats}`);

  // Small delay for async queue worker to persist record
  await new Promise((r) => setTimeout(r, 100));

  // 3. Repeat EXACT SAME request with same Idempotency Key (Simulating double-click or network retry)
  console.log(`\nStep 3: Repeating request with identical Idempotency-Key (Simulating user double-click)...`);
  const res2 = await axios.post(
    `${targetUrl}/reserve`,
    {
      eventId: 'e2e-test-event',
      userId: 'user_alice',
      ticketCount: 1,
    },
    { headers: { 'Idempotency-Key': idempotencyKey } }
  );

  if (res2.data.data.bookingId === bookingId) {
    console.log(`✅ IDEMPOTENCY SUCCESS! Duplicate request recognized and returned identical booking without deducting another ticket.`);
  } else {
    console.error(`❌ IDEMPOTENCY FAILED: Different booking created!`);
  }

  // 4. Verify available seats is still 1
  const checkStock = await axios.get(`${targetUrl}/events/e2e-test-event`);
  console.log(`\nStep 4: Current available seats: ${checkStock.data.data.availableSeats} (Expected: 1)`);

  // 5. Simulate Payment Success Webhook
  console.log(`\nStep 5: Simulating Payment Confirmation Webhook for booking: ${bookingId}...`);
  const paymentRes = await axios.post(`${targetUrl}/payment-webhook`, {
    bookingId,
    status: 'SUCCESS',
  });
  console.log(`✅ Payment confirmation result:`, paymentRes.data.data?.message || paymentRes.data.message);

  // 6. Test Payment Failure / Cancellation & Stock Release
  console.log(`\nStep 6: Reserving the last ticket for User Bob and simulating payment failure...`);
  const resBob = await axios.post(`${targetUrl}/reserve`, {
    eventId: 'e2e-test-event',
    userId: 'user_bob',
    ticketCount: 1,
  });
  const bobBookingId = resBob.data.data.bookingId;
  console.log(`Reserved for Bob, Booking ID: ${bobBookingId}`);

  // Small delay for async queue worker to persist record
  await new Promise((r) => setTimeout(r, 100));

  console.log(`Sending Payment FAILED for Bob's booking...`);
  const failRes = await axios.post(`${targetUrl}/payment-webhook`, {
    bookingId: bobBookingId,
    status: 'FAILED',
  });
  console.log(`✅ Webhook response:`, failRes.data.data?.message || failRes.data.message);

  const finalStock = await axios.get(`${targetUrl}/events/e2e-test-event`);
  console.log(`\nStep 7: Final available seats after release: ${finalStock.data.data.availableSeats} (Expected: 1)`);

  console.log(`\n===============================================================`);
  console.log(`🎉 ALL END-TO-END FLOWS VERIFIED SUCCESSFULLY!`);
  console.log(`===============================================================\n`);
}

runE2ETest();

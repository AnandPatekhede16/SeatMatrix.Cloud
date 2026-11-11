import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { CONFIG } from '../src/config/env';

async function runConcurrencyTest() {
  const targetUrl = process.env.API_BASE_URL || `http://localhost:${CONFIG.PORT}`;
  const eventId = 'event-coldplay-2026';
  const totalConcurrentUsers = 100; // 100 users competing for 10 tickets
  const ticketCountPerUser = 1;

  console.log(`\n===============================================================`);
  console.log(`🔥 STARTING HIGH-CONCURRENCY RACE CONDITION TEST`);
  console.log(`Target URL:               ${targetUrl}/reserve`);
  console.log(`Event ID:                 ${eventId}`);
  console.log(`Concurrent Requests:      ${totalConcurrentUsers}`);
  console.log(`===============================================================\n`);

  // First, check starting inventory
  try {
    const eventRes = await axios.get(`${targetUrl}/events/${eventId}`);
    console.log(`Initial Inventory:`, eventRes.data);
  } catch (err: any) {
    console.error(`❌ Could not fetch initial event info. Did you seed the event first? (npm run seed)`);
    process.exit(1);
  }

  console.log(`\n🚀 Firing ${totalConcurrentUsers} simultaneous booking requests...`);

  const startTime = Date.now();

  const requests = Array.from({ length: totalConcurrentUsers }, (_, index) => {
    const userId = `user_${index + 1}`;
    const idempotencyKey = uuidv4();

    return axios
      .post(
        `${targetUrl}/reserve`,
        {
          eventId,
          userId,
          ticketCount: ticketCountPerUser,
        },
        {
          headers: {
            'Idempotency-Key': idempotencyKey,
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        }
      )
      .then((res) => ({
        success: true,
        statusCode: res.status,
        data: res.data,
      }))
      .catch((err) => ({
        success: false,
        statusCode: err.response?.status || 500,
        error: err.response?.data?.error || err.message,
      }));
  });

  const results = await Promise.all(requests);
  const totalDurationMs = Date.now() - startTime;

  let successfulReservations = 0;
  let rejectedSoldOut = 0;
  let otherErrors = 0;

  results.forEach((res) => {
    if (res.statusCode === 202) {
      successfulReservations++;
    } else if (res.statusCode === 409) {
      rejectedSoldOut++;
    } else {
      otherErrors++;
    }
  });

  // Verify final inventory
  const finalEventRes = await axios.get(`${targetUrl}/events/${eventId}`);
  const finalAvailable = finalEventRes.data.data.availableSeats;

  console.log(`\n================== TEST RESULTS & VERIFICATION ==================`);
  console.log(`⏱️  Total Duration:          ${totalDurationMs} ms`);
  console.log(`⚡ Throughput:              ${((totalConcurrentUsers / totalDurationMs) * 1000).toFixed(2)} req/sec`);
  console.log(`✅ Successful Reservations: ${successfulReservations}`);
  console.log(`❌ Rejected (Sold Out):     ${rejectedSoldOut}`);
  console.log(`⚠️  Other Errors:            ${otherErrors}`);
  console.log(`🎫 Final Seats Left:        ${finalAvailable}`);

  if (successfulReservations === 10 && finalAvailable === 0 && otherErrors === 0) {
    console.log(`\n🎉 TEST PASSED! ZERO OVERSELLING DETECTED!`);
    console.log(`Exactly 10 tickets were booked out of 10 available seats.`);
    console.log(`409 Conflict properly handled for all remaining requests.`);
  } else if (successfulReservations > 10) {
    console.error(`\n❌ RACE CONDITION BUG: Oversold! ${successfulReservations} tickets booked for 10 seats.`);
  } else {
    console.log(`\nNotice: Check seat counts above.`);
  }
  console.log(`=================================================================\n`);
}

runConcurrencyTest();

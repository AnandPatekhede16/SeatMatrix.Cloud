import axios from 'axios';
import { CONFIG } from '../src/config/env';

async function seed() {
  const targetUrl = process.env.API_BASE_URL || `http://localhost:${CONFIG.PORT}`;
  console.log(`🌱 Seeding initial event data to: ${targetUrl}...`);

  try {
    const res = await axios.post(`${targetUrl}/admin/seed`, {
      eventId: 'event-coldplay-2026',
      name: 'Coldplay Music of the Spheres Tour',
      totalSeats: 10,
      pricePerSeat: 120,
    });

    console.log('✅ Event seeded successfully:');
    console.log(JSON.stringify(res.data, null, 2));
  } catch (err: any) {
    console.error('❌ Failed to seed event:', err.response?.data || err.message);
  }
}

seed();

import Redis from 'ioredis';
import { CONFIG } from '../config/env';

// Lua script to atomically check and decrement inventory, and set a temporary hold with TTL
const RESERVE_TICKET_LUA = `
local inventoryKey = KEYS[1]
local holdKey = KEYS[2]
local requested = tonumber(ARGV[1])
local bookingId = ARGV[2]
local ttlSeconds = tonumber(ARGV[3])

local available = tonumber(redis.call('GET', inventoryKey) or '0')

if available >= requested then
    redis.call('DECRBY', inventoryKey, requested)
    redis.call('SET', holdKey, bookingId, 'EX', ttlSeconds)
    return {1, available - requested}
else
    return {0, available}
end
`;

// Lua script to rollback inventory (e.g., if payment fails or user cancels)
const RELEASE_TICKET_LUA = `
local inventoryKey = KEYS[1]
local holdKey = KEYS[2]
local releaseCount = tonumber(ARGV[1])

if redis.call('EXISTS', holdKey) == 1 then
    redis.call('DEL', holdKey)
    local newCount = redis.call('INCRBY', inventoryKey, releaseCount)
    return {1, newCount}
else
    return {0, -1}
end
`;

// Lua script to confirm reservation on payment success (clear temporary hold without incrementing stock)
const CONFIRM_TICKET_LUA = `
local holdKey = KEYS[1]
if redis.call('EXISTS', holdKey) == 1 then
    redis.call('DEL', holdKey)
    return 1
else
    return 0
end
`;

class RedisService {
  private client: Redis | null = null;
  private isConnected = false;
  // Local fallback memory store if Redis is unreachable during initial local setup
  private mockStore: Map<string, any> = new Map();

  constructor() {
    this.init();
  }

  private init() {
    try {
      this.client = new Redis(CONFIG.REDIS_URL, {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        retryStrategy: (times) => {
          if (times > 2) {
            return null; // Stop retrying and fallback to mock if no redis server found
          }
          return Math.min(times * 100, 1000);
        },
      });

      this.client.on('connect', () => {
        this.isConnected = true;
        console.log('✅ Connected to Redis successfully');
      });

      this.client.on('error', (err) => {
        if (!this.isConnected) {
          console.warn('⚠️ Redis not reachable at ' + CONFIG.REDIS_URL + '. Running with In-Memory Mock Store for local testing.');
        }
      });
    } catch (err) {
      console.warn('⚠️ Could not initialize Redis client, using in-memory mock.');
    }
  }

  public getClient(): Redis | null {
    return this.client;
  }

  /**
   * Set initial inventory for an event in Redis
   */
  async setInventory(eventId: string, count: number): Promise<void> {
    const key = `event:${eventId}:inventory`;
    if (this.isConnected && this.client) {
      await this.client.set(key, count);
    } else {
      this.mockStore.set(key, count);
    }
  }

  /**
   * Get current available inventory
   */
  async getInventory(eventId: string): Promise<number | undefined> {
    const key = `event:${eventId}:inventory`;
    if (this.isConnected && this.client) {
      const val = await this.client.get(key);
      return val !== null && val !== undefined ? parseInt(val, 10) : undefined;
    } else {
      return this.mockStore.has(key) ? this.mockStore.get(key) : undefined;
    }
  }

  /**
   * Atomically reserve tickets using Lua Scripting
   * Returns: { success: boolean, remainingSeats: number }
   */
  async reserveTickets(
    eventId: string,
    bookingId: string,
    ticketCount: number,
    ttlSeconds: number = CONFIG.RESERVATION_TTL_SECONDS
  ): Promise<{ success: boolean; remainingSeats: number }> {
    const inventoryKey = `event:${eventId}:inventory`;
    const holdKey = `booking:${bookingId}:hold`;

    if (this.isConnected && this.client) {
      // Execute Lua script on Redis
      const result = (await this.client.eval(
        RESERVE_TICKET_LUA,
        2,
        inventoryKey,
        holdKey,
        ticketCount,
        bookingId,
        ttlSeconds
      )) as [number, number];

      const success = result[0] === 1;
      const remainingSeats = result[1];
      return { success, remainingSeats };
    } else {
      // Atomic operation in-memory fallback
      const current = this.mockStore.get(inventoryKey) || 0;
      if (current >= ticketCount) {
        const remaining = current - ticketCount;
        this.mockStore.set(inventoryKey, remaining);
        this.mockStore.set(holdKey, { bookingId, expiresAt: Date.now() + ttlSeconds * 1000 });
        return { success: true, remainingSeats: remaining };
      } else {
        return { success: false, remainingSeats: current };
      }
    }
  }

  /**
   * Rollback inventory if payment failed or timed out
   */
  async releaseTickets(eventId: string, bookingId: string, ticketCount: number): Promise<boolean> {
    const inventoryKey = `event:${eventId}:inventory`;
    const holdKey = `booking:${bookingId}:hold`;

    if (this.isConnected && this.client) {
      const result = (await this.client.eval(
        RELEASE_TICKET_LUA,
        2,
        inventoryKey,
        holdKey,
        ticketCount
      )) as [number, number];
      return result[0] === 1;
    } else {
      if (this.mockStore.has(holdKey)) {
        this.mockStore.delete(holdKey);
        const current = this.mockStore.get(inventoryKey) || 0;
        this.mockStore.set(inventoryKey, current + ticketCount);
        return true;
      }
      return false;
    }
  }

  /**
   * Confirm reservation on successful payment
   */
  async confirmReservation(bookingId: string): Promise<boolean> {
    const holdKey = `booking:${bookingId}:hold`;

    if (this.isConnected && this.client) {
      const result = (await this.client.eval(CONFIRM_TICKET_LUA, 1, holdKey)) as number;
      return result === 1;
    } else {
      if (this.mockStore.has(holdKey)) {
        this.mockStore.delete(holdKey);
        return true;
      }
      return false;
    }
  }
}

export const redisService = new RedisService();

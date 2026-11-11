import { redisService } from './redisService';
import { ApiResponse } from '../utils/response';

class IdempotencyService {
  private localCache: Map<string, { response: ApiResponse; expiresAt: number }> = new Map();

  /**
   * Check if a request has already been processed with this idempotency key
   */
  async getCachedResponse(key: string): Promise<ApiResponse | null> {
    const redisClient = redisService.getClient();
    const cacheKey = `idempotency:${key}`;

    if (redisClient) {
      try {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
          return JSON.parse(cached) as ApiResponse;
        }
      } catch (err) {
        // Fallback to local
      }
    }

    const local = this.localCache.get(cacheKey);
    if (local) {
      if (Date.now() < local.expiresAt) {
        return local.response;
      } else {
        this.localCache.delete(cacheKey);
      }
    }

    return null;
  }

  /**
   * Save response for this idempotency key with TTL (e.g., 24 hours / 86400s)
   */
  async saveResponse(key: string, response: ApiResponse, ttlSeconds = 86400): Promise<void> {
    const redisClient = redisService.getClient();
    const cacheKey = `idempotency:${key}`;

    if (redisClient) {
      try {
        await redisClient.set(cacheKey, JSON.stringify(response), 'EX', ttlSeconds);
        return;
      } catch (err) {
        // Fallback to local
      }
    }

    this.localCache.set(cacheKey, {
      response,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }
}

export const idempotencyService = new IdempotencyService();

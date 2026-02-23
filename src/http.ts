import { request } from 'undici';
import type { Logger } from 'pino';
import type { HttpResponse, LogLine } from './types.js';
import { ExponentialBackoff } from './util.js';
import { z } from 'zod';

const LogLineSchema = z.object({
  msg: z.string(),
  createdAt: z.string()
});

const LogResponseSchema = z.array(LogLineSchema);

export class HttpClient {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ component: 'http' });
  }

  async getLogs(
    gameId: string,
    handNumber: number,
    retries = 2
  ): Promise<HttpResponse> {
    const url = `https://www.pokernow.com/api/games/${gameId}/log_v3?hand_number=${handNumber}&after_at=0`;
    const backoff = new ExponentialBackoff();

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await request(url, {
          method: 'GET',
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
            'DNT': '1'
          },
          headersTimeout: 10000,
          bodyTimeout: 10000
        });

        const { statusCode } = response;

        if (statusCode === 200) {
          const body = await response.body.json();
          const parseResult = LogResponseSchema.safeParse(body);

          if (!parseResult.success) {
            this.logger.warn({
              gameId,
              handNumber,
              error: parseResult.error
            }, 'Invalid log response schema');
            return {
              status: statusCode,
              data: null,
              error: 'Invalid response schema'
            };
          }

          const data = parseResult.data as LogLine[];

          this.logger.debug({
            gameId,
            handNumber,
            lineCount: data.length
          }, 'Retrieved logs successfully');

          return { status: statusCode, data };
        }

        if (statusCode === 401 || statusCode === 403) {
          this.logger.warn({ gameId, handNumber, statusCode }, 'Authentication error');
          return { status: statusCode, data: null, error: 'Authentication required' };
        }

        if (statusCode === 404 || statusCode === 410) {
          this.logger.debug({ gameId, handNumber, statusCode }, 'Hand not found');
          return { status: statusCode, data: null, error: 'Hand not found' };
        }

        if (statusCode === 429) {
          this.logger.warn({ gameId, handNumber }, 'Rate limited');
          return { status: statusCode, data: null, error: 'Rate limited' };
        }

        this.logger.warn({ gameId, handNumber, statusCode }, 'Unexpected status code');
        return { status: statusCode, data: null, error: `Unexpected status: ${statusCode}` };

      } catch (error) {
        const isLastAttempt = attempt === retries;

        this.logger.warn({
          gameId,
          handNumber,
          attempt: attempt + 1,
          error,
          isLastAttempt
        }, 'Network error fetching logs');

        if (isLastAttempt) {
          return {
            status: 0,
            data: null,
            error: error instanceof Error ? error.message : 'Network error'
          };
        }

        await backoff.wait();
      }
    }

    return { status: 0, data: null, error: 'Max retries exceeded' };
  }
}

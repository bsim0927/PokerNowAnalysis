#!/usr/bin/env node

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { handleApiRequest } from './api.js';

const PORT = parseInt(process.env.PORT || '3456', 10);
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || '3457', 10);
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const logger = pino({
  level: LOG_LEVEL,
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname'
    }
  }
});

function jsonResponse(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function getPath(req: IncomingMessage): string {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  return url.pathname;
}

// ---------------------------------------------------------------------------
// API server (port 3456) — Supabase queries + PokerNow game lookup
// ---------------------------------------------------------------------------

const apiServer = createServer(async (req, res) => {
  const path = getPath(req);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    });
    res.end();
    return;
  }

  if (path === '/health') {
    jsonResponse(res, 200, { status: 'ok' });
    return;
  }

  if (path.startsWith('/api/')) {
    const handled = await handleApiRequest(req, res, logger);
    if (handled) return;
  }

  jsonResponse(res, 404, { error: 'Not found' });
});

// ---------------------------------------------------------------------------
// Dashboard static server (port 3457) — serves poker_dashboard.html + config.js
// ---------------------------------------------------------------------------

const dashboardServer = createServer(async (req, res) => {
  let urlPath = req.url?.split('?')[0] || '/';
  if (urlPath === '/') urlPath = '/poker_dashboard.html';

  const fileName = urlPath.slice(1); // strip leading /

  // Only serve top-level files, no path traversal
  if (!fileName || fileName.includes('/') || fileName.includes('..')) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const filePath = join(REPO_ROOT, fileName);

  try {
    const content = await readFile(filePath);
    const contentType = fileName.endsWith('.html') ? 'text/html'
      : fileName.endsWith('.js') ? 'text/javascript'
      : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

// Prevent process from crashing on unhandled errors
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception - server staying alive');
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled rejection - server staying alive');
});

apiServer.listen(PORT, () => {
  logger.info({ port: PORT }, 'API server started');
});

dashboardServer.listen(DASHBOARD_PORT, () => {
  logger.info({ port: DASHBOARD_PORT }, `Dashboard server started — open http://localhost:${DASHBOARD_PORT}`);
});

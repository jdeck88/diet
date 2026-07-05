import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSessionFromHeaders, handleApiRequest } from './api.mjs';
import { localEnvValue } from './env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');
const host = localEnvValue('HOST', '127.0.0.1');
const port = Number(localEnvValue('PORT', '5174'));

const staticContentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webp': 'image/webp',
};

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length === 0 ? '' : Buffer.concat(chunks).toString('utf8');
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, message) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(message);
}

function publicPathFromUrl(pathname) {
  if (pathname === '/') return path.join(publicDir, 'index.html');
  const decoded = decodeURIComponent(pathname);
  const resolved = path.resolve(publicDir, decoded.replace(/^\/+/, ''));
  if (!resolved.startsWith(publicDir)) return null;
  return resolved;
}

async function serveStatic(request, response, pathname) {
  const filePath = publicPathFromUrl(pathname);
  if (!filePath) {
    sendText(response, 403, 'Forbidden.');
    return;
  }

  try {
    const body = await fs.readFile(filePath);
    const contentType = staticContentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    response.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': contentType.includes('html') ? 'no-store' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(body);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      sendText(response, 404, 'Not found.');
      return;
    }
    console.error('Static file error:', error);
    sendText(response, 500, 'Failed to load file.');
  }
}

async function serveLogin(response) {
  const loginPath = path.join(publicDir, 'login.html');
  const body = await fs.readFile(loginPath);
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || `${host}:${port}`}`);
  const pathname = url.pathname;
  const session = getSessionFromHeaders(request.headers);

  try {
    if (pathname.startsWith('/api/')) {
      const result = await handleApiRequest({
        method: request.method,
        path: pathname,
        query: Object.fromEntries(url.searchParams),
        headers: request.headers,
        body: await readRequestBody(request),
      });
      response.writeHead(result.statusCode, result.headers);
      response.end(result.body);
      return;
    }

    if (!session) {
      await serveLogin(response);
      return;
    }

    await serveStatic(request, response, pathname);
  } catch (error) {
    const status = Number(error?.status) || 500;
    const message = error instanceof Error ? error.message : 'Unexpected server error.';
    if (status >= 500) console.error('Request error:', error);
    sendJson(response, status, { error: message });
  }
});

server.listen(port, host, () => {
  console.log(`Diet log app listening at http://${host}:${port}`);
});

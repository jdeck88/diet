import { handleApiRequest } from '../../server/api.mjs';

function normalizeApiPath(eventPath) {
  const path = String(eventPath || '');
  if (path.startsWith('/api/')) return path;
  if (path === '/api') return path;

  const functionPrefix = '/.netlify/functions/api';
  if (path.startsWith(functionPrefix)) {
    const suffix = path.slice(functionPrefix.length);
    return `/api${suffix || ''}`;
  }

  return path;
}

export const handler = async (event) => {
  const body = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : event.body || '';

  return handleApiRequest({
    method: event.httpMethod,
    path: normalizeApiPath(event.path),
    query: event.queryStringParameters || {},
    headers: event.headers || {},
    body,
    secureCookies: true,
  });
};

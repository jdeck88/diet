import crypto from 'node:crypto';
import { envCandidatesForDebug, localEnvValue } from './env.mjs';
import { generateDailyDietBlockUpdate, generateDietLogRows, getDietAgentSettings } from './dietAgent.mjs';
import { appendSheetValues, getServiceAccountEmail, hasGoogleServiceAccountConfig } from './googleSheets.mjs';
import { ensureSheetHeaders, getSheetConfig, getSheetProfile, writeDailyDietBlockUpdate } from './sheetProfile.mjs';

const appPin = localEnvValue('APP_PIN');
const sessionSecret = localEnvValue('SESSION_SECRET', 'replace-this-session-secret');
const sessionCookieName = 'diet_session';
const sessionDurationMs = 1000 * 60 * 60 * 24 * 14;

function headerValue(headers, name) {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === target) return Array.isArray(value) ? value.join(',') : String(value || '');
  }
  return '';
}

function parseCookiesFromHeader(header) {
  if (!header) return {};

  return Object.fromEntries(
    header.split(';').map((entry) => {
      const [name, ...rest] = entry.trim().split('=');
      return [name, decodeURIComponent(rest.join('='))];
    }),
  );
}

function signToken(payload) {
  return crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
}

function createSessionToken() {
  const payload = Buffer.from(
    JSON.stringify({
      id: crypto.randomUUID(),
      expiresAt: Date.now() + sessionDurationMs,
    }),
    'utf8',
  ).toString('base64url');
  return `${payload}.${signToken(payload)}`;
}

function verifySessionToken(token) {
  if (!token || !token.includes('.')) return null;

  const [payload, signature] = token.split('.');
  const expectedSignature = signToken(payload);
  const given = Buffer.from(signature || '');
  const expected = Buffer.from(expectedSignature);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return null;
  }

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!session?.id || Number(session.expiresAt) < Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

export function getSessionFromHeaders(headers) {
  return verifySessionToken(parseCookiesFromHeader(headerValue(headers, 'cookie'))[sessionCookieName]);
}

function parseJsonBody(body) {
  if (!body) return {};
  return JSON.parse(String(body));
}

function jsonResponse(statusCode, payload, headers = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
    body: JSON.stringify(payload),
  };
}

function setSessionCookieHeader(token, secureCookies) {
  const secure = secureCookies ? '; Secure' : '';
  return `${sessionCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(sessionDurationMs / 1000)}${secure}`;
}

function clearSessionCookieHeader(secureCookies) {
  const secure = secureCookies ? '; Secure' : '';
  return `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function normalizeDate(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function normalizeTranscript(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeWriteMode(value) {
  return value === 'replace' ? 'replace' : 'add';
}

export async function handleApiRequest({ method, path, headers = {}, body = '', secureCookies = false }) {
  try {
    const session = getSessionFromHeaders(headers);

    if (path === '/api/login' && method === 'POST') {
      if (!appPin) {
        return jsonResponse(503, { error: 'APP_PIN is not configured.' });
      }

      const parsedBody = parseJsonBody(body);
      if (String(parsedBody?.pin || '') !== appPin) {
        return jsonResponse(401, { error: 'Incorrect PIN.' });
      }

      return jsonResponse(200, { ok: true }, { 'Set-Cookie': setSessionCookieHeader(createSessionToken(), secureCookies) });
    }

    if (!session) {
      return jsonResponse(401, { error: 'PIN required.' });
    }

    if (path === '/api/logout' && method === 'POST') {
      return jsonResponse(200, { ok: true }, { 'Set-Cookie': clearSessionCookieHeader(secureCookies) });
    }

    if (path === '/api/config' && method === 'GET') {
      const sheetConfig = getSheetConfig();
      return jsonResponse(200, {
        ...sheetConfig,
        pinProtected: true,
        agent: getDietAgentSettings(),
        google: {
          configured: hasGoogleServiceAccountConfig(),
          serviceAccountEmail: getServiceAccountEmail(),
        },
        envFiles: envCandidatesForDebug(),
      });
    }

    if (path === '/api/sheet-profile' && method === 'GET') {
      const profile = await getSheetProfile();
      return jsonResponse(200, profile);
    }

    if (path === '/api/diet-log' && method === 'POST') {
      const parsedBody = parseJsonBody(body);
      const selectedDate = normalizeDate(parsedBody?.date);
      const transcript = normalizeTranscript(parsedBody?.transcript);
      const writeMode = normalizeWriteMode(parsedBody?.writeMode);

      if (!selectedDate) {
        return jsonResponse(400, { error: 'Choose a valid date.' });
      }

      if (transcript.length < 3) {
        return jsonResponse(400, { error: 'Enter a food note before sending.' });
      }

      if (transcript.length > 8000) {
        return jsonResponse(400, { error: 'Food note is too long. Keep it under 8000 characters.' });
      }

      const profile = await getSheetProfile();
      let generated;
      let wroteHeaders = false;
      let writeResult;

      if (profile.layout === 'daily-block') {
        generated = await generateDailyDietBlockUpdate({
          selectedDate,
          transcript,
          sessionId: session.id,
        });
        writeResult = await writeDailyDietBlockUpdate({ selectedDate, generated, writeMode });
        generated.rows = writeResult.rows;
      } else {
        generated = await generateDietLogRows({
          selectedDate,
          transcript,
          headers: profile.headers,
          sessionId: session.id,
        });
      }

      if (!generated.rows.length) {
        return jsonResponse(422, {
          error: 'The agent did not find any food rows to write.',
          generated,
          profile,
        });
      }

      let appendResult = null;
      if (profile.layout !== 'daily-block') {
        wroteHeaders = await ensureSheetHeaders(profile);
        appendResult = await appendSheetValues(profile.spreadsheetId, profile.sheetTabName, profile.headers, generated.rows);
      }

      return jsonResponse(200, {
        ok: true,
        wroteHeaders,
        profile: writeResult ? { ...profile, ...writeResult } : profile,
        generated,
        append: appendResult?.updates || null,
      });
    }

    return jsonResponse(404, { error: 'Not found.' });
  } catch (error) {
    const status = Number(error?.status) || 500;
    const message = error instanceof Error ? error.message : 'Unexpected server error.';
    if (status >= 500) console.error('API request error:', error);
    return jsonResponse(status, { error: message });
  }
}

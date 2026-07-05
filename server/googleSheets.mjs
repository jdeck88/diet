import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { envValue } from './env.mjs';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const GOOGLE_SHEETS_API_BASE = 'https://sheets.googleapis.com/v4';

let cachedCredentials = null;
let cachedToken = null;

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function parseServiceAccountJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.');
    error.status = 500;
    error.type = 'GoogleServiceAccountInvalid';
    throw error;
  }
}

function loadCredentialsFromFile(maybePath) {
  const resolved = path.resolve(maybePath);
  if (!fs.existsSync(resolved)) return null;

  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch {
    const error = new Error(`Google service account file at ${resolved} is not valid JSON.`);
    error.status = 500;
    error.type = 'GoogleServiceAccountInvalid';
    throw error;
  }
}

function loadServiceAccountCredentials() {
  if (cachedCredentials) return cachedCredentials;

  const filePath = envValue('GOOGLE_SERVICE_ACCOUNT_JSON_PATH');
  const inlineJson = envValue('GOOGLE_SERVICE_ACCOUNT_JSON');

  let credentials = null;
  if (filePath) {
    credentials = loadCredentialsFromFile(filePath);
    if (!credentials) {
      const error = new Error(`Google service account file not found at ${path.resolve(filePath)}.`);
      error.status = 500;
      error.type = 'GoogleServiceAccountMissing';
      throw error;
    }
  } else if (inlineJson) {
    credentials = inlineJson.startsWith('{') ? parseServiceAccountJson(inlineJson) : loadCredentialsFromFile(inlineJson);
  }

  if (!credentials?.client_email || !credentials.private_key) {
    const error = new Error('Google Sheets integration is not configured. Set GOOGLE_SERVICE_ACCOUNT_JSON_PATH or GOOGLE_SERVICE_ACCOUNT_JSON.');
    error.status = 500;
    error.type = 'GoogleServiceAccountMissing';
    throw error;
  }

  cachedCredentials = credentials;
  return cachedCredentials;
}

export function getServiceAccountEmail() {
  try {
    return loadServiceAccountCredentials().client_email || null;
  } catch {
    return null;
  }
}

export function hasGoogleServiceAccountConfig() {
  try {
    const credentials = loadServiceAccountCredentials();
    return Boolean(credentials.client_email && credentials.private_key);
  } catch {
    return false;
  }
}

async function getGoogleAccessToken() {
  if (cachedToken?.accessToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }

  const credentials = loadServiceAccountCredentials();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: credentials.client_email,
    scope: GOOGLE_SHEETS_SCOPE,
    aud: credentials.token_uri || GOOGLE_TOKEN_URL,
    exp: nowSeconds + 3600,
    iat: nowSeconds,
  };

  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${base64url(signer.sign(credentials.private_key))}`;

  const params = new URLSearchParams();
  params.set('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  params.set('assertion', assertion);

  const response = await fetch(credentials.token_uri || GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const payloadJson = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payloadJson?.error_description || payloadJson?.error || 'Google token request failed.');
    error.status = response.status || 502;
    error.type = 'GoogleSheetsError';
    error.details = payloadJson;
    throw error;
  }

  cachedToken = {
    accessToken: String(payloadJson.access_token || ''),
    expiresAt: Date.now() + Number(payloadJson.expires_in || 3600) * 1000,
  };
  return cachedToken.accessToken;
}

async function sheetsRequest(method, resourcePath, { params, data } = {}) {
  const accessToken = await getGoogleAccessToken();
  const url = new URL(`${GOOGLE_SHEETS_API_BASE}${resourcePath}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.error?.message || payload?.error_description || 'Google Sheets request failed.';
    const error = new Error(message);
    error.status = response.status || 502;
    error.type = 'GoogleSheetsError';
    error.details = payload;
    throw error;
  }
  return payload;
}

export function quoteSheetTitleForRange(sheetTitle) {
  return `'${String(sheetTitle || '').replace(/'/g, "''")}'`;
}

export function columnName(columnIndex) {
  let value = columnIndex + 1;
  let label = '';

  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }

  return label;
}

export async function getSpreadsheet(spreadsheetId) {
  return sheetsRequest('GET', `/spreadsheets/${encodeURIComponent(spreadsheetId)}`, {
    params: { includeGridData: false },
  });
}

export async function ensureSheetTab(spreadsheetId, sheetTitle) {
  const spreadsheet = await getSpreadsheet(spreadsheetId);
  const existing = (Array.isArray(spreadsheet?.sheets) ? spreadsheet.sheets : []).find(
    (sheet) => String(sheet?.properties?.title || '').trim() === sheetTitle.trim(),
  );

  if (existing) {
    return {
      spreadsheetTitle: spreadsheet?.properties?.title || '',
      tabTitle: existing.properties.title,
      sheetId: existing.properties.sheetId,
      created: false,
    };
  }

  const created = await sheetsRequest('POST', `/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
    data: { requests: [{ addSheet: { properties: { title: sheetTitle } } }] },
  });
  const addedSheet = created?.replies?.[0]?.addSheet?.properties;

  return {
    spreadsheetTitle: spreadsheet?.properties?.title || '',
    tabTitle: sheetTitle,
    sheetId: addedSheet?.sheetId ?? null,
    created: true,
  };
}

export async function readSheetRangeValues(spreadsheetId, sheetTitle, rangeA1) {
  await ensureSheetTab(spreadsheetId, sheetTitle);
  const range = `${quoteSheetTitleForRange(sheetTitle)}!${rangeA1}`;
  const payload = await sheetsRequest('GET', `/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`);
  return Array.isArray(payload?.values) ? payload.values : [];
}

export async function writeSheetRangeValues(spreadsheetId, sheetTitle, rangeA1, values) {
  const tabInfo = await ensureSheetTab(spreadsheetId, sheetTitle);
  const range = `${quoteSheetTitleForRange(sheetTitle)}!${rangeA1}`;

  await sheetsRequest('PUT', `/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`, {
    params: { valueInputOption: 'USER_ENTERED' },
    data: {
      majorDimension: 'ROWS',
      values,
    },
  });

  return tabInfo;
}

export async function appendSheetValues(spreadsheetId, sheetTitle, headers, values) {
  const tabInfo = await ensureSheetTab(spreadsheetId, sheetTitle);
  const lastColumn = columnName(Math.max(headers.length - 1, 0));
  const range = `${quoteSheetTitleForRange(sheetTitle)}!A:${lastColumn}`;

  const payload = await sheetsRequest(
    'POST',
    `/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append`,
    {
      params: {
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
      },
      data: {
        majorDimension: 'ROWS',
        values,
      },
    },
  );

  return { tabInfo, updates: payload?.updates || null };
}

export async function batchUpdateSpreadsheet(spreadsheetId, requests) {
  if (!requests.length) return null;
  return sheetsRequest('POST', `/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
    data: { requests },
  });
}

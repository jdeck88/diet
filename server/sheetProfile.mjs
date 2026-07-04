import { envValue } from './env.mjs';
import { columnName, readSheetRangeValues, writeSheetRangeValues } from './googleSheets.mjs';

export const DEFAULT_SPREADSHEET_ID = '14DM8zSoCnO-Q2CTSZTGbpBoS-stbFqtx0W9bbDFEyog';
export const DEFAULT_SHEET_TAB_NAME = 'test';

const DEFAULT_HEADERS = [
  'Date',
  'Meal',
  'Food',
  'Quantity',
  'Calories',
  'Protein (g)',
  'Carbs (g)',
  'Fat (g)',
  'Fiber (g)',
  'Food Quality',
  'Quality Score',
  'Quality Notes',
  'Confidence',
  'Notes',
  'Raw Input',
];

export const DAILY_BLOCK_HEADERS = [
  'Time',
  'Food',
  'Cals',
  'Protien',
  'Carbs',
  'H2O',
  'hungry/noise?',
  'How do you feel?',
  'Wha chu want?',
  'Lean into SUCCESS',
];

const TIME_SLOTS = ['6AM', '7AM', '8AM', '9AM', '10AM', '11AM', '12PM', '1PM', '2PM', '3PM', '4PM', '5PM', '6PM', '7PM', '8PM', '9PM'];
const DAY_BLOCK_HEIGHT = 19;
const DAY_BLOCK_WIDTH = 13;

function extractSpreadsheetId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const match = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match?.[1] || raw;
}

export function getSheetConfig() {
  const spreadsheetId =
    extractSpreadsheetId(envValue('DIET_SPREADSHEET_ID')) ||
    extractSpreadsheetId(envValue('DIET_SPREADSHEET_URL')) ||
    DEFAULT_SPREADSHEET_ID;
  const sheetTabName = envValue('DIET_SHEET_TAB_NAME', DEFAULT_SHEET_TAB_NAME);

  return {
    spreadsheetId,
    sheetTabName,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
  };
}

function dateParts(dateString) {
  const [year, month, day] = String(dateString || '').split('-').map((part) => Number(part));
  if (!year || !month || !day) return null;
  return { year, month, day };
}

export function formatSheetDate(dateString) {
  const parts = dateParts(dateString);
  if (!parts) return '';
  return `${parts.month}/${parts.day}`;
}

function weekdayName(dateString) {
  const parts = dateParts(dateString);
  if (!parts) return '';
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12));
  return ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'][date.getUTCDay()];
}

function normalizeSheetDate(value) {
  const match = String(value || '').trim().match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!match) return '';
  return `${Number(match[1])}/${Number(match[2])}`;
}

function isDayHeaderRow(row) {
  const dateCell = normalizeSheetDate(row?.[2]);
  const calsCell = String(row?.[4] || '').trim().toLowerCase();
  return Boolean(dateCell && (calsCell === 'cals' || calsCell === 'calories'));
}

function isDailyBlockSheet(values) {
  return values.some((row) => isDayHeaderRow(row));
}

function findDayBlockStart(values, selectedDate) {
  const target = formatSheetDate(selectedDate);
  return values.findIndex((row) => isDayHeaderRow(row) && normalizeSheetDate(row?.[2]) === target);
}

function findNextDayBlockStart(values, blockStart) {
  const nextStart = values.findIndex((row, index) => index > blockStart && isDayHeaderRow(row));
  return nextStart >= 0 ? nextStart : -1;
}

function blockEndIndex(values, blockStart) {
  const nextStart = findNextDayBlockStart(values, blockStart);
  if (nextStart >= 0) return nextStart;
  return Math.min(values.length, blockStart + DAY_BLOCK_HEIGHT);
}

function createEmptyRow(width = DAY_BLOCK_WIDTH) {
  return Array.from({ length: width }, () => '');
}

function createDayBlockRows(selectedDate, blockStartIndex) {
  const displayDate = formatSheetDate(selectedDate);
  const displayDay = weekdayName(selectedDate);
  const firstTimeRow = blockStartIndex + 4;
  const lastTimeRow = blockStartIndex + DAY_BLOCK_HEIGHT;
  const rows = [];

  rows.push(['', '', displayDate, displayDay, 'Cals', 'Protien', 'Carbs', 'H2O', 'hungry/noise?', '', 'How do you feel?', 'Wha chu want?', 'Lean into SUCCESS']);
  rows.push([
    '',
    '',
    '',
    '',
    `=SUM(E${firstTimeRow}:E${lastTimeRow})`,
    `=SUM(F${firstTimeRow}:F${lastTimeRow})`,
    `=SUM(G${firstTimeRow}:G${lastTimeRow})`,
    `=SUM(H${firstTimeRow}:H${lastTimeRow})`,
    '',
    '',
    '',
    '',
    'Success',
  ]);
  rows.push(['', '', 'TOTAL', '', '', '', '', '', '', '', '', '', '']);

  for (const timeSlot of TIME_SLOTS) {
    const row = createEmptyRow();
    row[2] = timeSlot;
    rows.push(row);
  }

  return rows;
}

function normalizedHeaderText(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ');
}

function rowHeaderScore(row) {
  const text = row.map(normalizedHeaderText).join(' ');
  const nonEmptyCount = row.filter((cell) => String(cell || '').trim()).length;
  const recognizedTerms = [
    'date',
    'day',
    'meal',
    'food',
    'item',
    'quantity',
    'serving',
    'calorie',
    'calories',
    'protein',
    'carb',
    'fat',
    'fiber',
    'sugar',
    'quality',
    'score',
    'notes',
    'confidence',
  ];
  const recognizedCount = recognizedTerms.filter((term) => text.includes(term)).length;

  return recognizedCount * 10 + nonEmptyCount;
}

function detectHeaderRow(values) {
  let best = { index: -1, score: 0 };

  values.forEach((row, index) => {
    const cells = Array.isArray(row) ? row : [];
    const nonEmptyCount = cells.filter((cell) => String(cell || '').trim()).length;
    if (nonEmptyCount < 2) return;

    const score = rowHeaderScore(cells);
    if (score > best.score) {
      best = { index, score };
    }
  });

  if (best.score >= 12) return best.index;
  return values.findIndex((row) => Array.isArray(row) && row.filter((cell) => String(cell || '').trim()).length >= 2);
}

export async function getSheetProfile() {
  const { spreadsheetId, sheetTabName, spreadsheetUrl } = getSheetConfig();
  const values = await readSheetRangeValues(spreadsheetId, sheetTabName, 'A1:AZ200');
  if (isDailyBlockSheet(values)) {
    const blocks = values
      .map((row, index) => (isDayHeaderRow(row) ? { rowIndex: index, date: normalizeSheetDate(row[2]), day: String(row[3] || '') } : null))
      .filter(Boolean);

    return {
      spreadsheetId,
      sheetTabName,
      spreadsheetUrl,
      layout: 'daily-block',
      headers: DAILY_BLOCK_HEADERS,
      dayBlocks: blocks,
      rowCountInPreview: values.length,
      usesDefaultHeaders: false,
    };
  }

  const headerRowIndex = detectHeaderRow(values);
  const existingHeaders =
    headerRowIndex >= 0
      ? values[headerRowIndex].map((cell) => String(cell || '').trim()).filter(Boolean)
      : [];

  return {
    spreadsheetId,
    sheetTabName,
    spreadsheetUrl,
    layout: 'append-table',
    headers: existingHeaders.length ? existingHeaders : DEFAULT_HEADERS,
    headerRowIndex,
    rowCountInPreview: values.length,
    usesDefaultHeaders: existingHeaders.length === 0,
  };
}

export async function ensureSheetHeaders(profile) {
  if (!profile.usesDefaultHeaders) {
    return false;
  }

  await writeSheetRangeValues(profile.spreadsheetId, profile.sheetTabName, 'A1', [profile.headers]);
  return true;
}

function normalizeTimeSlot(value) {
  const raw = String(value || '').trim().toUpperCase().replace(/\s+/g, '');
  const match = raw.match(/^(\d{1,2})(?::\d{2})?(AM|PM)$/);
  if (!match) return '';
  const normalized = `${Number(match[1])}${match[2]}`;
  return TIME_SLOTS.includes(normalized) ? normalized : '';
}

function preferredFallbackTime(entry) {
  const text = `${entry?.meal || ''} ${entry?.food || ''}`.toLowerCase();
  if (/breakfast|egg|toast|oatmeal|coffee|matcha/.test(text)) return '8AM';
  if (/lunch|salad|sandwich|soup/.test(text)) return '12PM';
  if (/dinner|supper|steak|pasta|rice|potato/.test(text)) return '6PM';
  if (/snack|chips|apple|jerk|jerky|nuts|bar/.test(text)) return '3PM';
  return '';
}

function numberCell(value) {
  if (value === null || value === undefined || value === '') return '';
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return String(Math.round(number));
}

function entryFoodCell(entry) {
  const food = String(entry?.food || '').trim();
  const quality = String(entry?.qualityNotes || '').trim();
  if (!food) return '';
  if (!quality) return food;
  return `${food} - ${quality}`;
}

async function readDayGrid(spreadsheetId, sheetTabName) {
  return readSheetRangeValues(spreadsheetId, sheetTabName, 'A1:M500');
}

async function ensureDayBlock(spreadsheetId, sheetTabName, selectedDate) {
  let values = await readDayGrid(spreadsheetId, sheetTabName);
  let blockStart = findDayBlockStart(values, selectedDate);
  let created = false;

  if (blockStart < 0) {
    blockStart = values.length;
    const blockRows = createDayBlockRows(selectedDate, blockStart);
    const firstRow = blockStart + 1;
    const lastRow = blockStart + DAY_BLOCK_HEIGHT;
    await writeSheetRangeValues(spreadsheetId, sheetTabName, `A${firstRow}:M${lastRow}`, blockRows);
    values = await readDayGrid(spreadsheetId, sheetTabName);
    created = true;
  }

  return {
    values,
    blockStart,
    blockEnd: blockEndIndex(values, blockStart),
    created,
  };
}

function collectTimeRows(values, blockStart, blockEnd) {
  const rows = [];
  for (let rowIndex = blockStart + 3; rowIndex < blockEnd; rowIndex += 1) {
    const row = values[rowIndex] || [];
    const timeSlot = normalizeTimeSlot(row[2]);
    if (timeSlot) {
      rows.push({
        rowIndex,
        timeSlot,
        occupied: Boolean(String(row[3] || '').trim()),
      });
    }
  }
  return rows;
}

function chooseTargetRow(entry, timeRows, usedRows) {
  const requestedTime = normalizeTimeSlot(entry?.timeSlot) || preferredFallbackTime(entry);
  const requestedIndex = requestedTime ? timeRows.findIndex((row) => row.timeSlot === requestedTime) : -1;
  const orderedRows = requestedIndex >= 0 ? [...timeRows.slice(requestedIndex), ...timeRows.slice(0, requestedIndex)] : timeRows;
  return orderedRows.find((row) => !row.occupied && !usedRows.has(row.rowIndex)) || null;
}

export async function writeDailyDietBlockUpdate({ selectedDate, generated }) {
  const { spreadsheetId, sheetTabName, spreadsheetUrl } = getSheetConfig();
  const dayBlock = await ensureDayBlock(spreadsheetId, sheetTabName, selectedDate);
  const timeRows = collectTimeRows(dayBlock.values, dayBlock.blockStart, dayBlock.blockEnd);
  const usedRows = new Set();
  const writtenRows = [];
  const writeOperations = [];

  for (const entry of generated.entries || []) {
    if (!String(entry?.food || '').trim()) continue;
    const target = chooseTargetRow(entry, timeRows, usedRows);
    if (!target) break;

    usedRows.add(target.rowIndex);
    const rowValues = [
      target.timeSlot,
      entryFoodCell(entry),
      numberCell(entry.calories),
      numberCell(entry.proteinGrams),
      numberCell(entry.carbsGrams),
      String(entry.water || '').trim(),
      String(entry.hungerNoise || '').trim(),
    ];
    const rowNumber = target.rowIndex + 1;
    writeOperations.push(writeSheetRangeValues(spreadsheetId, sheetTabName, `C${rowNumber}:I${rowNumber}`, [rowValues]));
    writtenRows.push([...rowValues, '', '', '']);
  }

  const summary = generated.summary || {};
  const totalRowIndex = dayBlock.blockStart + 2;
  const currentTotalRow = dayBlock.values[totalRowIndex] || [];
  const reflectionValues = [
    String(summary.howDoYouFeel || currentTotalRow[10] || '').trim(),
    String(summary.whatDoYouWant || currentTotalRow[11] || '').trim(),
    String(summary.leanIntoSuccess || currentTotalRow[12] || '').trim(),
  ];

  if (reflectionValues.some(Boolean)) {
    const totalRowNumber = totalRowIndex + 1;
    writeOperations.push(writeSheetRangeValues(spreadsheetId, sheetTabName, `K${totalRowNumber}:M${totalRowNumber}`, [reflectionValues]));
  }

  await Promise.all(writeOperations);

  return {
    spreadsheetId,
    sheetTabName,
    spreadsheetUrl,
    layout: 'daily-block',
    createdDayBlock: dayBlock.created,
    blockStartRow: dayBlock.blockStart + 1,
    headers: DAILY_BLOCK_HEADERS,
    rows: writtenRows,
    skippedEntries: Math.max(0, (generated.entries || []).length - writtenRows.length),
    lastColumn: columnName(DAY_BLOCK_WIDTH - 1),
  };
}

import { envValue } from './env.mjs';
import {
  batchUpdateSpreadsheet,
  columnName,
  ensureSheetTab,
  readSheetRangeValues,
  writeSheetRangeValues,
} from './googleSheets.mjs';

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

function dateSortValue(dateString, fallbackYear) {
  const match = String(dateString || '').trim().match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!match) return Number.NEGATIVE_INFINITY;
  return Date.UTC(fallbackYear, Number(match[1]) - 1, Number(match[2]));
}

function findDayBlockInsertIndex(values, selectedDate) {
  const parts = dateParts(selectedDate);
  if (!parts) return values.length;

  const targetValue = Date.UTC(parts.year, parts.month - 1, parts.day);
  const blocks = values
    .map((row, index) => (isDayHeaderRow(row) ? { index, date: normalizeSheetDate(row?.[2]) } : null))
    .filter(Boolean);

  for (const block of blocks) {
    if (dateSortValue(block.date, parts.year) < targetValue) {
      return block.index;
    }
  }

  return values.length;
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

async function insertSheetRows(spreadsheetId, sheetId, startIndex, rowCount) {
  await batchUpdateSpreadsheet(spreadsheetId, [
    {
      insertDimension: {
        range: {
          sheetId,
          dimension: 'ROWS',
          startIndex,
          endIndex: startIndex + rowCount,
        },
        inheritFromBefore: startIndex > 0,
      },
    },
  ]);
}

async function copyDayBlockFormat(spreadsheetId, sheetId, sourceStartIndex, targetStartIndex) {
  if (sourceStartIndex < 0 || targetStartIndex < 0 || sourceStartIndex === targetStartIndex) {
    return;
  }

  await batchUpdateSpreadsheet(spreadsheetId, [
    {
      copyPaste: {
        source: {
          sheetId,
          startRowIndex: sourceStartIndex,
          endRowIndex: sourceStartIndex + DAY_BLOCK_HEIGHT,
          startColumnIndex: 0,
          endColumnIndex: DAY_BLOCK_WIDTH,
        },
        destination: {
          sheetId,
          startRowIndex: targetStartIndex,
          endRowIndex: targetStartIndex + DAY_BLOCK_HEIGHT,
          startColumnIndex: 0,
          endColumnIndex: DAY_BLOCK_WIDTH,
        },
        pasteType: 'PASTE_FORMAT',
        pasteOrientation: 'NORMAL',
      },
    },
  ]);
}

async function ensureDayBlock(spreadsheetId, sheetTabName, selectedDate) {
  const tabInfo = await ensureSheetTab(spreadsheetId, sheetTabName);
  let values = await readDayGrid(spreadsheetId, sheetTabName);
  let blockStart = findDayBlockStart(values, selectedDate);
  let created = false;

  if (blockStart < 0) {
    const insertIndex = findDayBlockInsertIndex(values, selectedDate);
    const templateStart = values.findIndex((row) => isDayHeaderRow(row));
    blockStart = insertIndex;

    if (insertIndex < values.length && tabInfo.sheetId !== null && tabInfo.sheetId !== undefined) {
      await insertSheetRows(spreadsheetId, tabInfo.sheetId, insertIndex, DAY_BLOCK_HEIGHT);
    }

    if (tabInfo.sheetId !== null && tabInfo.sheetId !== undefined && templateStart >= 0) {
      const shiftedTemplateStart = templateStart >= insertIndex ? templateStart + DAY_BLOCK_HEIGHT : templateStart;
      await copyDayBlockFormat(spreadsheetId, tabInfo.sheetId, shiftedTemplateStart, blockStart);
    }

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

function dailyRowsFromTimeRows(values, timeRows) {
  return timeRows.map((rowInfo) => {
    const row = values[rowInfo.rowIndex] || [];
    return [
      rowInfo.timeSlot,
      String(row[3] || ''),
      String(row[4] || ''),
      String(row[5] || ''),
      String(row[6] || ''),
      String(row[7] || ''),
      String(row[8] || ''),
      '',
      '',
      '',
    ];
  });
}

function dailyReflectionFromBlock(values, blockStart) {
  const totalRow = values[blockStart + 2] || [];
  return {
    howDoYouFeel: String(totalRow[10] || ''),
    whatDoYouWant: String(totalRow[11] || ''),
    leanIntoSuccess: String(totalRow[12] || ''),
  };
}

function dailyTotalsFromBlock(values, blockStart) {
  const totalsRow = values[blockStart + 1] || [];
  return {
    calories: String(totalsRow[4] || ''),
    protein: String(totalsRow[5] || ''),
    carbs: String(totalsRow[6] || ''),
    water: String(totalsRow[7] || ''),
  };
}

export async function getDailyDietDay({ selectedDate, ensure = true }) {
  const { spreadsheetId, sheetTabName, spreadsheetUrl } = getSheetConfig();
  let values = await readDayGrid(spreadsheetId, sheetTabName);
  let blockStart = findDayBlockStart(values, selectedDate);
  let createdDayBlock = false;

  if (blockStart < 0 && ensure) {
    const ensured = await ensureDayBlock(spreadsheetId, sheetTabName, selectedDate);
    values = ensured.values;
    blockStart = ensured.blockStart;
    createdDayBlock = ensured.created;
  }

  if (blockStart < 0) {
    const emptyRows = TIME_SLOTS.map((timeSlot) => [timeSlot, '', '', '', '', '', '', '', '', '']);
    return {
      spreadsheetId,
      sheetTabName,
      spreadsheetUrl,
      layout: 'daily-block',
      exists: false,
      createdDayBlock: false,
      headers: DAILY_BLOCK_HEADERS,
      rows: emptyRows,
      reflection: { howDoYouFeel: '', whatDoYouWant: '', leanIntoSuccess: '' },
      totals: { calories: '', protein: '', carbs: '', water: '' },
    };
  }

  const blockEnd = blockEndIndex(values, blockStart);
  const timeRows = collectTimeRows(values, blockStart, blockEnd);

  return {
    spreadsheetId,
    sheetTabName,
    spreadsheetUrl,
    layout: 'daily-block',
    exists: true,
    createdDayBlock,
    blockStartRow: blockStart + 1,
    headers: DAILY_BLOCK_HEADERS,
    rows: dailyRowsFromTimeRows(values, timeRows),
    reflection: dailyReflectionFromBlock(values, blockStart),
    totals: dailyTotalsFromBlock(values, blockStart),
  };
}

function chooseTargetRow(entry, timeRows, usedRows) {
  const requestedTime = normalizeTimeSlot(entry?.timeSlot) || preferredFallbackTime(entry);
  const requestedIndex = requestedTime ? timeRows.findIndex((row) => row.timeSlot === requestedTime) : -1;
  const orderedRows = requestedIndex >= 0 ? [...timeRows.slice(requestedIndex), ...timeRows.slice(0, requestedIndex)] : timeRows;
  return orderedRows.find((row) => !row.occupied && !usedRows.has(row.rowIndex)) || null;
}

function plannedEntryRowValues(entry, target) {
  return [
    target.timeSlot,
    entryFoodCell(entry),
    numberCell(entry.calories),
    numberCell(entry.proteinGrams),
    numberCell(entry.carbsGrams),
    String(entry.water || '').trim(),
    String(entry.hungerNoise || '').trim(),
  ];
}

function planDailyDietBlockUpdate({ values, dayBlock, generated, writeMode = 'add' }) {
  const isReplaceMode = writeMode === 'replace';
  const timeRows = collectTimeRows(values, dayBlock.blockStart, dayBlock.blockEnd).map((row) => ({
    ...row,
    occupied: isReplaceMode ? false : row.occupied,
  }));
  const afterRows = isReplaceMode
    ? timeRows.map((row) => [row.timeSlot, '', '', '', '', '', '', '', '', ''])
    : dailyRowsFromTimeRows(values, timeRows);
  const usedRows = new Set();
  const writtenRows = [];
  const writes = [];

  for (const entry of generated.entries || []) {
    if (!String(entry?.food || '').trim()) continue;
    const target = chooseTargetRow(entry, timeRows, usedRows);
    if (!target) break;

    usedRows.add(target.rowIndex);
    const rowValues = plannedEntryRowValues(entry, target);
    const previewIndex = timeRows.findIndex((row) => row.rowIndex === target.rowIndex);
    if (previewIndex >= 0) {
      afterRows[previewIndex] = [...rowValues, '', '', ''];
    }
    writtenRows.push([...rowValues, '', '', '']);
    writes.push({ rowIndex: target.rowIndex, values: rowValues });
  }

  const summary = generated.summary || {};
  const currentReflection = isReplaceMode ? { howDoYouFeel: '', whatDoYouWant: '', leanIntoSuccess: '' } : dailyReflectionFromBlock(values, dayBlock.blockStart);
  const reflection = {
    howDoYouFeel: String(summary.howDoYouFeel || currentReflection.howDoYouFeel || '').trim(),
    whatDoYouWant: String(summary.whatDoYouWant || currentReflection.whatDoYouWant || '').trim(),
    leanIntoSuccess: String(summary.leanIntoSuccess || currentReflection.leanIntoSuccess || '').trim(),
  };

  return {
    timeRows,
    rows: writtenRows,
    writes,
    afterRows,
    reflection,
    skippedEntries: Math.max(0, (generated.entries || []).length - writtenRows.length),
  };
}

async function clearDailyBlockContents(spreadsheetId, sheetTabName, dayBlock, timeRows) {
  const rowWrites = timeRows.map((row) => {
    const rowNumber = row.rowIndex + 1;
    return writeSheetRangeValues(spreadsheetId, sheetTabName, `C${rowNumber}:I${rowNumber}`, [
      [row.timeSlot, '', '', '', '', '', ''],
    ]);
  });
  const totalRowNumber = dayBlock.blockStart + 3;
  rowWrites.push(writeSheetRangeValues(spreadsheetId, sheetTabName, `K${totalRowNumber}:M${totalRowNumber}`, [['', '', '']]));
  await Promise.all(rowWrites);
}

export async function writeDailyDietBlockUpdate({ selectedDate, generated, writeMode = 'add' }) {
  const { spreadsheetId, sheetTabName, spreadsheetUrl } = getSheetConfig();
  const dayBlock = await ensureDayBlock(spreadsheetId, sheetTabName, selectedDate);
  const isReplaceMode = writeMode === 'replace';
  const plan = planDailyDietBlockUpdate({ values: dayBlock.values, dayBlock, generated, writeMode });
  const writeOperations = [];

  if (isReplaceMode) {
    await clearDailyBlockContents(spreadsheetId, sheetTabName, dayBlock, plan.timeRows);
  }

  for (const write of plan.writes) {
    const rowNumber = write.rowIndex + 1;
    writeOperations.push(writeSheetRangeValues(spreadsheetId, sheetTabName, `C${rowNumber}:I${rowNumber}`, [write.values]));
  }

  const reflectionValues = [plan.reflection.howDoYouFeel, plan.reflection.whatDoYouWant, plan.reflection.leanIntoSuccess];

  if (reflectionValues.some(Boolean)) {
    const totalRowIndex = dayBlock.blockStart + 2;
    const totalRowNumber = totalRowIndex + 1;
    writeOperations.push(writeSheetRangeValues(spreadsheetId, sheetTabName, `K${totalRowNumber}:M${totalRowNumber}`, [reflectionValues]));
  }

  await Promise.all(writeOperations);

  return {
    spreadsheetId,
    sheetTabName,
    spreadsheetUrl,
    layout: 'daily-block',
    writeMode: isReplaceMode ? 'replace' : 'add',
    createdDayBlock: dayBlock.created,
    replacedDayBlock: isReplaceMode,
    blockStartRow: dayBlock.blockStart + 1,
    headers: DAILY_BLOCK_HEADERS,
    rows: plan.rows,
    afterRows: plan.afterRows,
    reflection: plan.reflection,
    skippedEntries: plan.skippedEntries,
    lastColumn: columnName(DAY_BLOCK_WIDTH - 1),
  };
}

export async function previewDailyDietBlockUpdate({ selectedDate, generated, writeMode = 'add' }) {
  const { spreadsheetId, sheetTabName, spreadsheetUrl } = getSheetConfig();
  const dayBlock = await ensureDayBlock(spreadsheetId, sheetTabName, selectedDate);
  const plan = planDailyDietBlockUpdate({ values: dayBlock.values, dayBlock, generated, writeMode });

  return {
    spreadsheetId,
    sheetTabName,
    spreadsheetUrl,
    layout: 'daily-block',
    writeMode: writeMode === 'replace' ? 'replace' : 'add',
    createdDayBlock: dayBlock.created,
    blockStartRow: dayBlock.blockStart + 1,
    headers: DAILY_BLOCK_HEADERS,
    rows: plan.rows,
    afterRows: plan.afterRows,
    reflection: plan.reflection,
    skippedEntries: plan.skippedEntries,
    lastColumn: columnName(DAY_BLOCK_WIDTH - 1),
  };
}

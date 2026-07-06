import crypto from 'node:crypto';
import { envValue } from './env.mjs';

const DEFAULT_MODEL = 'gpt-5.5';
const DEFAULT_REASONING_EFFORT = 'xhigh';
const DEFAULT_SERVICE_TIER = 'priority';
const DIET_LOG_MAX_OUTPUT_TOKENS = 6000;
const DAILY_BLOCK_MAX_OUTPUT_TOKENS = 6000;
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const OPENAI_REQUEST_TIMEOUT_MS = 8000;
const TIME_SLOTS = ['6AM', '7AM', '8AM', '9AM', '10AM', '11AM', '12PM', '1PM', '2PM', '3PM', '4PM', '5PM', '6PM', '7PM', '8PM', '9PM'];

function extractResponseOutputText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text;
  }

  if (!Array.isArray(payload?.output)) {
    return '';
  }

  const textParts = [];

  for (const item of payload.output) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) {
      continue;
    }

    for (const contentItem of item.content) {
      if (contentItem?.type === 'output_text' && typeof contentItem.text === 'string') {
        textParts.push(contentItem.text);
      }
    }
  }

  return textParts.join('\n').trim();
}

function responseStatusDetails(payload) {
  const details = [];
  if (payload?.status) details.push(`status: ${payload.status}`);
  if (payload?.incomplete_details?.reason) details.push(`reason: ${payload.incomplete_details.reason}`);
  if (payload?.finish_reason) details.push(`finish reason: ${payload.finish_reason}`);
  return details.length ? ` (${details.join(', ')})` : '';
}

function parseStructuredOutput(payload, label) {
  const outputText = extractResponseOutputText(payload);
  if (!outputText) {
    throw new Error(`OpenAI returned an empty ${label} result${responseStatusDetails(payload)}.`);
  }

  try {
    return JSON.parse(outputText);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid JSON';
    throw new Error(`OpenAI returned an incomplete ${label} result${responseStatusDetails(payload)}: ${message}.`);
  }
}

function isPendingResponse(payload) {
  return ['queued', 'in_progress'].includes(String(payload?.status || ''));
}

function isCompletedResponse(payload) {
  return String(payload?.status || '') === 'completed';
}

function openAiErrorMessage(payload, fallback) {
  return (
    payload?.error?.message ??
    payload?.error?.error?.message ??
    payload?.message ??
    fallback
  );
}

async function fetchOpenAiJson(url, { method = 'GET', apiKey, body = null } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(openAiErrorMessage(payload, 'OpenAI diet parsing failed.'));
    }

    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('OpenAI took too long to respond. Try again in a moment.');
      timeoutError.status = 504;
      throw timeoutError;
    }

    throw new Error(`Failed to reach OpenAI: ${error instanceof Error ? error.message : 'unknown error'}`);
  } finally {
    clearTimeout(timeout);
  }
}

function createSafetyIdentifier(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex');
}

function modelName() {
  return envValue('OPENAI_DIET_MODEL') || envValue('OPENAI_WORKFLOW_MODEL') || DEFAULT_MODEL;
}

function reasoningEffort() {
  const effort = envValue('OPENAI_DIET_REASONING_EFFORT') || envValue('OPENAI_WORKFLOW_REASONING_EFFORT') || DEFAULT_REASONING_EFFORT;
  return ['low', 'medium', 'high', 'xhigh'].includes(effort) ? effort : DEFAULT_REASONING_EFFORT;
}

function serviceTier() {
  const tier = envValue('OPENAI_DIET_SERVICE_TIER') || envValue('OPENAI_WORKFLOW_SERVICE_TIER') || DEFAULT_SERVICE_TIER;
  if (tier === 'fast') return 'priority';
  return ['auto', 'default', 'flex', 'priority'].includes(tier) ? tier : DEFAULT_SERVICE_TIER;
}

function createDietLogSchema(columnCount) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['date', 'summary', 'entries', 'rows', 'warnings'],
    properties: {
      date: {
        type: 'string',
        description: 'The selected log date in YYYY-MM-DD format.',
      },
      summary: {
        type: 'object',
        additionalProperties: false,
        required: ['totalCalories', 'overallFoodQuality', 'qualityScore', 'notes'],
        properties: {
          totalCalories: { type: 'number' },
          overallFoodQuality: { type: 'string' },
          qualityScore: { type: 'number' },
          notes: { type: 'string' },
        },
      },
      entries: {
        type: 'array',
        maxItems: 20,
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'meal',
            'food',
            'quantity',
            'estimatedCalories',
            'proteinGrams',
            'carbsGrams',
            'fatGrams',
            'fiberGrams',
            'foodQuality',
            'qualityNotes',
            'confidence',
          ],
          properties: {
            meal: { type: 'string' },
            food: { type: 'string' },
            quantity: { type: 'string' },
            estimatedCalories: { type: 'number' },
            proteinGrams: { type: 'number' },
            carbsGrams: { type: 'number' },
            fatGrams: { type: 'number' },
            fiberGrams: { type: 'number' },
            foodQuality: { type: 'string' },
            qualityNotes: { type: 'string' },
            confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
          },
        },
      },
      rows: {
        type: 'array',
        maxItems: 20,
        items: {
          type: 'array',
          minItems: columnCount,
          maxItems: columnCount,
          items: { type: 'string' },
        },
      },
      warnings: {
        type: 'array',
        maxItems: 5,
        items: { type: 'string' },
      },
    },
  };
}

export function getDietAgentSettings() {
  return {
    hasOpenAiConfig: Boolean(envValue('OPENAI_API_KEY')),
    model: modelName(),
    reasoningEffort: reasoningEffort(),
    serviceTier: serviceTier(),
  };
}

export async function generateDietLogRows({ selectedDate, transcript, headers, sessionId }) {
  const openAiApiKey = envValue('OPENAI_API_KEY');
  if (!openAiApiKey) {
    throw new Error('OPENAI_API_KEY is not configured on the server.');
  }

  const model = modelName();
  const schema = createDietLogSchema(headers.length);
  const payload = await fetchOpenAiJson(OPENAI_RESPONSES_URL, {
    method: 'POST',
    apiKey: openAiApiKey,
    body: {
      model,
      reasoning: { effort: reasoningEffort() },
      service_tier: serviceTier(),
      max_output_tokens: DIET_LOG_MAX_OUTPUT_TOKENS,
      safety_identifier: createSafetyIdentifier(sessionId),
      instructions: [
        'Interpret food notes into spreadsheet-ready diet log rows.',
        'Estimate calories and macro qualities conservatively from common nutrition knowledge.',
        'Use only foods supported by the source text. If an amount is vague, make a reasonable serving estimate and mark confidence low or medium.',
        'Food quality should reflect whole foods, processing level, balance, added sugar, protein/fiber density, and overall meal quality.',
        'Rows must exactly match the provided spreadsheet headers and column order. Leave a cell blank when a header does not apply.',
      ].join(' '),
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: [
                `Selected date: ${selectedDate}.`,
                'Spreadsheet headers in exact order:',
                headers.map((header, index) => `${index + 1}. ${header}`).join('\n'),
                'Return rows as arrays. Each row must have exactly the same number of cells as headers.',
                'Prefer one row per distinct food item or meal component. Use one combined meal row only when the note does not provide separable items.',
                'Use numeric-looking strings for numeric spreadsheet cells, such as "450" or "28".',
                'Source text:',
                transcript,
              ].join('\n\n'),
            },
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'diet_spreadsheet_rows',
          strict: true,
          schema,
        },
      },
    },
  });

  const parsed = parseStructuredOutput(payload, 'diet log');
  const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];

  return {
    date: String(parsed?.date || selectedDate),
    summary: parsed?.summary || null,
    entries: Array.isArray(parsed?.entries) ? parsed.entries : [],
    rows: rows.map((row) => {
      const normalized = Array.isArray(row) ? row.map((cell) => String(cell ?? '')) : [];
      while (normalized.length < headers.length) normalized.push('');
      return normalized.slice(0, headers.length);
    }),
    warnings: Array.isArray(parsed?.warnings) ? parsed.warnings.map((warning) => String(warning || '')).filter(Boolean) : [],
    model,
  };
}

function createDailyBlockSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['date', 'writeMode', 'summary', 'entries', 'warnings'],
    properties: {
      date: {
        type: 'string',
        description: 'The selected log date in YYYY-MM-DD format.',
      },
      writeMode: {
        type: 'string',
        enum: ['add', 'replace'],
        description: 'How the proposed entries should be saved to the daily sheet block.',
      },
      summary: {
        type: 'object',
        additionalProperties: false,
        required: [
          'totalCalories',
          'overallFoodQuality',
          'qualityScore',
          'howDoYouFeel',
          'whatDoYouWant',
          'leanIntoSuccess',
          'notes',
        ],
        properties: {
          totalCalories: { type: 'number' },
          overallFoodQuality: { type: 'string' },
          qualityScore: { type: 'number' },
          howDoYouFeel: {
            type: 'string',
            description: 'Daily reflection for how the user feels physically or emotionally, such as slow, drowsy, energized, hungry, or stressed.',
          },
          whatDoYouWant: {
            type: 'string',
            description: 'Daily reflection for what the user wants, craves, intends, or is aiming for.',
          },
          leanIntoSuccess: {
            type: 'string',
            description: 'Daily reflection for the behavior, choice, or next step the user wants to lean into for success.',
          },
          notes: { type: 'string' },
        },
      },
      entries: {
        type: 'array',
        maxItems: 16,
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'timeSlot',
            'meal',
            'food',
            'calories',
            'proteinGrams',
            'carbsGrams',
            'water',
            'hungerNoise',
            'foodQuality',
            'qualityNotes',
            'confidence',
          ],
          properties: {
            timeSlot: { type: 'string', enum: TIME_SLOTS },
            meal: { type: 'string' },
            food: { type: 'string' },
            calories: { type: 'number' },
            proteinGrams: { type: 'number' },
            carbsGrams: { type: 'number' },
            water: { type: 'string' },
            hungerNoise: { type: 'string' },
            foodQuality: { type: 'string' },
            qualityNotes: { type: 'string' },
            confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
          },
        },
      },
      warnings: {
        type: 'array',
        maxItems: 5,
        items: { type: 'string' },
      },
    },
  };
}

function createDailyDietBlockRequestBody({
  selectedDate,
  transcript,
  sessionId,
  trainingNotes = '',
  previousDraft = null,
  currentDay = null,
  model,
  schema,
  background = false,
}) {
  const body = {
    model,
    reasoning: { effort: reasoningEffort() },
    service_tier: serviceTier(),
    max_output_tokens: DAILY_BLOCK_MAX_OUTPUT_TOKENS,
    safety_identifier: createSafetyIdentifier(sessionId),
    instructions: [
      'Interpret raw food notes into the farm diet tracker day-block format.',
      'The sheet has hourly rows from 6AM through 9PM. Combine foods that belong to the same hour into one row.',
      'Estimate calories, protein grams, and carb grams conservatively from common nutrition knowledge.',
      'Use water only when the note mentions water or another explicit H2O amount; otherwise leave water blank.',
      'Use hungerNoise for brief hunger, craving, emotional eating, processed-food, or food-quality signals when supported by the source text.',
      'Use howDoYouFeel, whatDoYouWant, and leanIntoSuccess only when the source text supports those reflections; otherwise return blank strings.',
      'If the user says how they feel, such as "I feel slow and drowsy", put that value in summary.howDoYouFeel.',
      'If the user says what they want, crave, intend, or are aiming for, put that value in summary.whatDoYouWant.',
      'If the user says what success behavior to lean into, put that value in summary.leanIntoSuccess.',
      'For reflection-only messages, return entries as an empty array and still fill the supported summary reflection fields.',
      'Ignore unrelated dictated conversation about typing, app operation, deployment, service accounts, copying, pasting, whether the request worked, or other people unless it clearly describes food, drink, hunger, mood, or daily reflections.',
      'If no exact time is said, choose a reasonable slot: breakfast 8AM, lunch 12PM, snack 3PM, dinner 6PM.',
      'Treat user correction and feedback messages as authoritative, especially exact brand nutrition details.',
      'Infer writeMode from the conversation. Use add when the user is adding another food, drink, water entry, or note to the selected day.',
      'Use replace when the user says only, replace, change, correct, update, remove, start over, or otherwise describes the final desired day rather than an additional item.',
      'If previousDraft is provided, revise that draft and return the full current proposed entries that should remain, not only the newest correction.',
      'When previousDraft is provided and the user is correcting the unsaved draft, preserve previousDraft.writeMode unless the user clearly changes whether the sheet save should add rows or replace the day.',
      'If writeMode is add and there is no previousDraft, return only the new items to add.',
      'If writeMode is replace and there is no previousDraft, return the full desired day after the change. Include unchanged current sheet rows only when they should remain after the requested change.',
      'If the user mentions one food or drink item, return one entry unless they clearly list multiple items.',
    ].join(' '),
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              `Selected date: ${selectedDate}.`,
              `Valid time slots: ${TIME_SLOTS.join(', ')}.`,
              trainingNotes ? `Known user food corrections and preferences:\n${trainingNotes}` : '',
              currentDay ? `Current sheet rows for context:\n${JSON.stringify(currentDay)}` : '',
              previousDraft ? `Previous draft to revise:\n${JSON.stringify(previousDraft)}` : '',
              'Conversation and feedback:',
              transcript,
            ].filter(Boolean).join('\n\n'),
          },
        ],
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'daily_diet_block_update',
        strict: true,
        schema,
      },
    },
  };

  if (background) body.background = true;

  return body;
}

function dailyDietBlockUpdateFromPayload(payload, selectedDate, model) {
  const parsed = parseStructuredOutput(payload, 'diet log');

  return {
    date: String(parsed?.date || selectedDate),
    writeMode: parsed?.writeMode === 'replace' ? 'replace' : 'add',
    summary: parsed?.summary || null,
    entries: Array.isArray(parsed?.entries) ? parsed.entries : [],
    warnings: Array.isArray(parsed?.warnings) ? parsed.warnings.map((warning) => String(warning || '')).filter(Boolean) : [],
    model,
  };
}

async function createDailyDietBlockResponse(args, { background = false } = {}) {
  const openAiApiKey = envValue('OPENAI_API_KEY');
  if (!openAiApiKey) {
    throw new Error('OPENAI_API_KEY is not configured on the server.');
  }

  const model = modelName();
  const schema = createDailyBlockSchema();
  const payload = await fetchOpenAiJson(OPENAI_RESPONSES_URL, {
    method: 'POST',
    apiKey: openAiApiKey,
    body: createDailyDietBlockRequestBody({
      ...args,
      model,
      schema,
      background,
    }),
  });

  return { payload, model };
}

export async function startDailyDietBlockUpdate(args) {
  const { payload, model } = await createDailyDietBlockResponse(args, { background: true });

  if (isCompletedResponse(payload)) {
    return {
      pending: false,
      generated: dailyDietBlockUpdateFromPayload(payload, args.selectedDate, model),
    };
  }

  if (isPendingResponse(payload) && payload?.id) {
    return {
      pending: true,
      responseId: payload.id,
      status: payload.status,
      model,
    };
  }

  throw new Error(`OpenAI diet parsing did not complete${responseStatusDetails(payload)}.`);
}

export async function retrieveDailyDietBlockUpdate({ selectedDate, responseId }) {
  const openAiApiKey = envValue('OPENAI_API_KEY');
  if (!openAiApiKey) {
    throw new Error('OPENAI_API_KEY is not configured on the server.');
  }

  const payload = await fetchOpenAiJson(`${OPENAI_RESPONSES_URL}/${encodeURIComponent(responseId)}`, {
    apiKey: openAiApiKey,
  });
  const model = payload?.model || modelName();

  if (isCompletedResponse(payload)) {
    return {
      pending: false,
      generated: dailyDietBlockUpdateFromPayload(payload, selectedDate, model),
    };
  }

  if (isPendingResponse(payload)) {
    return {
      pending: true,
      responseId: payload.id || responseId,
      status: payload.status,
      model,
    };
  }

  throw new Error(`OpenAI diet parsing did not complete${responseStatusDetails(payload)}.`);
}

export async function generateDailyDietBlockUpdate({
  selectedDate,
  transcript,
  sessionId,
  trainingNotes = '',
  previousDraft = null,
  currentDay = null,
}) {
  const { payload, model } = await createDailyDietBlockResponse({
    selectedDate,
    transcript,
    sessionId,
    trainingNotes,
    previousDraft,
    currentDay,
  });

  return dailyDietBlockUpdateFromPayload(payload, selectedDate, model);
}

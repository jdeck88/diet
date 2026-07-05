import crypto from 'node:crypto';
import { envValue } from './env.mjs';

const DEFAULT_MODEL = 'gpt-5.5';
const DEFAULT_REASONING_EFFORT = 'high';
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
  };
}

export async function generateDietLogRows({ selectedDate, transcript, headers, sessionId }) {
  const openAiApiKey = envValue('OPENAI_API_KEY');
  if (!openAiApiKey) {
    throw new Error('OPENAI_API_KEY is not configured on the server.');
  }

  const model = modelName();
  const schema = createDietLogSchema(headers.length);
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${openAiApiKey}`,
    },
    body: JSON.stringify({
      model,
      reasoning: { effort: reasoningEffort() },
      max_output_tokens: 2800,
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
    }),
  }).catch((error) => {
    throw new Error(`Failed to reach OpenAI: ${error instanceof Error ? error.message : 'unknown error'}`);
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload?.error?.message ??
      payload?.error?.error?.message ??
      payload?.message ??
      'OpenAI diet parsing failed.';
    throw new Error(message);
  }

  const outputText = extractResponseOutputText(payload);
  if (!outputText) {
    throw new Error('OpenAI returned an empty diet log result.');
  }

  const parsed = JSON.parse(outputText);
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
          howDoYouFeel: { type: 'string' },
          whatDoYouWant: { type: 'string' },
          leanIntoSuccess: { type: 'string' },
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

export async function generateDailyDietBlockUpdate({
  selectedDate,
  transcript,
  sessionId,
  trainingNotes = '',
  previousDraft = null,
  currentDay = null,
}) {
  const openAiApiKey = envValue('OPENAI_API_KEY');
  if (!openAiApiKey) {
    throw new Error('OPENAI_API_KEY is not configured on the server.');
  }

  const model = modelName();
  const schema = createDailyBlockSchema();
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${openAiApiKey}`,
    },
    body: JSON.stringify({
      model,
      reasoning: { effort: reasoningEffort() },
      max_output_tokens: 2200,
      safety_identifier: createSafetyIdentifier(sessionId),
      instructions: [
        'Interpret raw food notes into the farm diet tracker day-block format.',
        'The sheet has hourly rows from 6AM through 9PM. Combine foods that belong to the same hour into one row.',
        'Estimate calories, protein grams, and carb grams conservatively from common nutrition knowledge.',
        'Use water only when the note mentions water or another explicit H2O amount; otherwise leave water blank.',
        'Use hungerNoise for brief hunger, craving, emotional eating, processed-food, or food-quality signals when supported by the source text.',
        'Use howDoYouFeel, whatDoYouWant, and leanIntoSuccess only when the source text supports those reflections; otherwise return blank strings.',
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
    }),
  }).catch((error) => {
    throw new Error(`Failed to reach OpenAI: ${error instanceof Error ? error.message : 'unknown error'}`);
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload?.error?.message ??
      payload?.error?.error?.message ??
      payload?.message ??
      'OpenAI diet parsing failed.';
    throw new Error(message);
  }

  const outputText = extractResponseOutputText(payload);
  if (!outputText) {
    throw new Error('OpenAI returned an empty diet log result.');
  }

  const parsed = JSON.parse(outputText);

  return {
    date: String(parsed?.date || selectedDate),
    writeMode: parsed?.writeMode === 'replace' ? 'replace' : 'add',
    summary: parsed?.summary || null,
    entries: Array.isArray(parsed?.entries) ? parsed.entries : [],
    warnings: Array.isArray(parsed?.warnings) ? parsed.warnings.map((warning) => String(warning || '')).filter(Boolean) : [],
    model,
  };
}

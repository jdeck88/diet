const dateInput = document.querySelector('#date-input');
const selectedDateLabel = document.querySelector('#selected-date-label');
const chatInput = document.querySelector('#chat-input');
const chatLog = document.querySelector('#chat-log');
const micButton = document.querySelector('#mic-button');
const micLabel = document.querySelector('#mic-label');
const sendButton = document.querySelector('#send-button');
const approveButton = document.querySelector('#approve-button');
const logoutButton = document.querySelector('#logout-button');
const sheetLink = document.querySelector('#sheet-link');
const message = document.querySelector('#message');
const agentStatus = document.querySelector('#agent-status');
const sheetStatus = document.querySelector('#sheet-status');
const draftSummary = document.querySelector('#draft-summary');
const proposedRowCount = document.querySelector('#proposed-row-count');
const proposedTable = document.querySelector('#proposed-table');

const trainingNotesKey = 'dietAgentTrainingNotes';

let chatMessages = [];
let chatEvents = [];
let currentDay = null;
let currentDraft = null;
let currentPreviews = { add: null, replace: null };
let currentWriteMode = 'add';
let recognition = null;
let isListening = false;
let finalTranscriptBeforeListen = '';

function localDateValue(date = new Date()) {
  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return offsetDate.toISOString().slice(0, 10);
}

function ordinalDay(day) {
  if (day % 100 >= 11 && day % 100 <= 13) return `${day}th`;
  if (day % 10 === 1) return `${day}st`;
  if (day % 10 === 2) return `${day}nd`;
  if (day % 10 === 3) return `${day}rd`;
  return `${day}th`;
}

function selectedDateParts() {
  const [year, month, day] = String(dateInput.value || '').split('-').map((part) => Number(part));
  if (!year || !month || !day) return null;
  return { year, month, day };
}

function formattedSelectedDate() {
  const parts = selectedDateParts();
  if (!parts) return '';
  const date = new Date(parts.year, parts.month - 1, parts.day, 12);
  const weekday = date.toLocaleDateString('en-US', { weekday: 'long' });
  const month = date.toLocaleDateString('en-US', { month: 'long' });
  return `${weekday}, ${month} ${ordinalDay(parts.day)}, ${parts.year}`;
}

function updateSelectedDateLabel() {
  selectedDateLabel.textContent = formattedSelectedDate();
}

function conversationKey() {
  return `dietChat:${dateInput.value}`;
}

function getTrainingNotes() {
  return localStorage.getItem(trainingNotesKey) || '';
}

function addTrainingNote(text) {
  const nextLine = `- ${text.trim()}`;
  const existing = getTrainingNotes()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!existing.includes(nextLine)) existing.push(nextLine);
  localStorage.setItem(trainingNotesKey, existing.slice(-40).join('\n'));
}

function saveConversation() {
  sessionStorage.setItem(conversationKey(), JSON.stringify(chatMessages));
}

function loadConversation() {
  try {
    chatMessages = JSON.parse(sessionStorage.getItem(conversationKey()) || '[]');
    if (!Array.isArray(chatMessages)) chatMessages = [];
  } catch {
    chatMessages = [];
  }
  chatEvents = [];
}

function nonEmptyDayRows(day) {
  return (day?.rows || []).filter((row) => row.slice(1).some((cell) => String(cell || '').trim()));
}

function countReflectionFields(day) {
  const reflection = day?.reflection || {};
  return [reflection.howDoYouFeel, reflection.whatDoYouWant, reflection.leanIntoSuccess].filter((value) =>
    String(value || '').trim(),
  ).length;
}

function currentDayGuidanceText(day) {
  const dateLabel = formattedSelectedDate();
  const rows = nonEmptyDayRows(day);
  const reflectionCount = countReflectionFields(day);
  const dataDescription = rows.length
    ? `${rows.length} existing food ${rows.length === 1 ? 'row' : 'rows'}`
    : 'no food rows yet';
  const lines = [];

  if (day?.createdDayBlock) {
    lines.push(`I created a blank day for ${dateLabel || 'the selected day'}.`);
  } else {
    lines.push(`I loaded ${dateLabel || 'the selected day'} with ${dataDescription}.`);
  }

  if (reflectionCount) lines.push(`There ${reflectionCount === 1 ? 'is' : 'are'} also ${reflectionCount} daily note ${reflectionCount === 1 ? 'field' : 'fields'} filled in.`);

  lines.push(
    'See the Proposed Submission table for the current sheet contents.',
    '',
    'Tell me what to add or change for this day.',
    'I will update the Proposed Submission table for review.',
  );

  return lines.join('\n');
}

function normalizeProposedText(value) {
  return String(value ?? '').trim();
}

function proposedRowHasData(row) {
  return (row || []).slice(1, 7).some((cell) => normalizeProposedText(cell));
}

function proposedRowSignature(row) {
  return (row || []).slice(1, 7).map((cell) => normalizeProposedText(cell).toLowerCase()).join('|');
}

function proposedRowSummary(row, { includeTime = true } = {}) {
  const time = normalizeProposedText(row?.[0]);
  const food = normalizeProposedText(row?.[1]) || 'blank';
  const parts = [];

  if (normalizeProposedText(row?.[2])) parts.push(`${normalizeProposedText(row[2])} cals`);
  if (normalizeProposedText(row?.[3])) parts.push(`${normalizeProposedText(row[3])}g protein`);
  if (normalizeProposedText(row?.[4])) parts.push(`${normalizeProposedText(row[4])}g carbs`);
  if (normalizeProposedText(row?.[5])) parts.push(`H2O ${normalizeProposedText(row[5])}`);
  if (normalizeProposedText(row?.[6])) parts.push(normalizeProposedText(row[6]));

  return `${includeTime && time ? `${time}: ` : ''}${food}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

function proposedTableChangeLines(previousRows = [], nextRows = []) {
  const previousByTime = new Map();
  const nextByTime = new Map();
  const timeOrder = [];

  const rememberTime = (time) => {
    if (time && !timeOrder.includes(time)) timeOrder.push(time);
  };

  previousRows.forEach((row) => {
    const time = normalizeProposedText(row?.[0]);
    rememberTime(time);
    previousByTime.set(time, row);
  });

  nextRows.forEach((row) => {
    const time = normalizeProposedText(row?.[0]);
    rememberTime(time);
    nextByTime.set(time, row);
  });

  return timeOrder.flatMap((time) => {
    const previousRow = previousByTime.get(time) || [];
    const nextRow = nextByTime.get(time) || [];
    const hadData = proposedRowHasData(previousRow);
    const hasData = proposedRowHasData(nextRow);

    if (!hadData && !hasData) return [];
    if (hadData && hasData && proposedRowSignature(previousRow) === proposedRowSignature(nextRow)) return [];
    if (hadData && hasData) {
      return [`Changed ${time} from ${proposedRowSummary(previousRow, { includeTime: false })} to ${proposedRowSummary(nextRow, { includeTime: false })}.`];
    }
    if (hasData) return [`Added ${proposedRowSummary(nextRow)}.`];
    return [`Cleared ${proposedRowSummary(previousRow)}.`];
  });
}

function saveBehaviorLabel(writeMode) {
  return writeMode === 'replace' ? 'replace the day in the sheet' : 'add rows to open time slots';
}

function draftGuidanceText(draft, changeLines = null) {
  const entryCount = draft?.entries?.length || 0;
  const inferredBehavior = saveBehaviorLabel(draft?.writeMode);
  if (Array.isArray(changeLines)) {
    const visibleChanges = changeLines.slice(0, 5);
    const hiddenChangeCount = Math.max(0, changeLines.length - visibleChanges.length);
    const lines = [
      `Updated the Proposed Submission table with ${entryCount} ${entryCount === 1 ? 'entry' : 'entries'}.`,
      `I inferred this should ${inferredBehavior}.`,
    ];

    if (visibleChanges.length) {
      lines.push(...visibleChanges);
      if (hiddenChangeCount) lines.push(`Plus ${hiddenChangeCount} more ${hiddenChangeCount === 1 ? 'change' : 'changes'}.`);
    } else {
      lines.push('No table changes were detected.');
    }

    lines.push('Please double-check the Proposed Submission table before saving to Google Sheet.');
    return lines.join('\n');
  }

  const lines = [
    `Draft ready with ${entryCount} ${entryCount === 1 ? 'entry' : 'entries'}.`,
    `I inferred this should ${inferredBehavior}.`,
    'See the Proposed Submission table for the proposed day.',
    'Please double-check the table before saving to Google Sheet.',
  ];

  return lines.join('\n');
}

function savedGuidanceText(rowCount) {
  return [
    `Saved ${rowCount} ${rowCount === 1 ? 'row' : 'rows'} to the sheet.`,
    'See the Proposed Submission table for the updated sheet contents.',
    'You can keep adding details, correct something you just saved, or switch to another date.',
  ].join('\n');
}

function setCurrentDayChatEvent() {
  if (!currentDay) {
    chatEvents = [];
    return;
  }
  chatEvents = [{ role: 'assistant', text: currentDayGuidanceText(currentDay) }];
}

function setMessage(text, tone = '') {
  message.textContent = text;
  message.dataset.tone = tone;
}

function setBusy(isBusy) {
  sendButton.disabled = isBusy;
  approveButton.disabled = isBusy || !currentDraft;
  sendButton.classList.toggle('is-loading', isBusy);
  approveButton.classList.toggle('is-loading', isBusy);
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(payload.error || 'Request failed.');
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

function renderTable(table, headers, rows, countElement) {
  const tableHead = table.querySelector('thead');
  const tableBody = table.querySelector('tbody');
  tableHead.innerHTML = '';
  tableBody.innerHTML = '';

  const headerRow = document.createElement('tr');
  headers.forEach((header) => {
    const th = document.createElement('th');
    th.textContent = header;
    headerRow.appendChild(th);
  });
  tableHead.appendChild(headerRow);

  rows.forEach((row) => {
    const tr = document.createElement('tr');
    headers.forEach((_, index) => {
      const td = document.createElement('td');
      td.textContent = row[index] || '';
      tr.appendChild(td);
    });
    tableBody.appendChild(tr);
  });

  countElement.textContent = `${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`;
}

function renderSummary(container, items) {
  container.innerHTML = '';
  items.forEach(([label, value]) => {
    const item = document.createElement('div');
    item.className = 'summary-item';
    const labelEl = document.createElement('span');
    labelEl.textContent = label;
    const valueEl = document.createElement('strong');
    valueEl.textContent = String(value || 'Blank');
    item.append(labelEl, valueEl);
    container.appendChild(item);
  });
}

function renderChat() {
  chatLog.innerHTML = '';

  if (!chatMessages.length && !chatEvents.length) {
    const empty = document.createElement('div');
    empty.className = 'chat-empty';
    empty.textContent = 'No messages yet.';
    chatLog.appendChild(empty);
    return;
  }

  [...chatMessages, ...chatEvents].forEach((entry) => {
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble chat-bubble-${entry.role === 'assistant' ? 'assistant' : 'user'}`;
    const label = document.createElement('span');
    label.textContent = entry.role === 'feedback' ? 'Feedback' : entry.role === 'assistant' ? 'Agent' : 'You';
    const text = document.createElement('p');
    text.textContent = entry.text;
    bubble.append(label, text);
    chatLog.appendChild(bubble);
  });

  chatLog.scrollTop = chatLog.scrollHeight;
}

function activePreview() {
  return currentPreviews[currentWriteMode] || null;
}

function proposedRowsForCurrentState() {
  const preview = activePreview();
  return preview?.afterRows || preview?.rows || currentDay?.rows || [];
}

function renderDraft() {
  const preview = activePreview();
  const headers = preview?.headers || currentDay?.headers || [];
  const rows = proposedRowsForCurrentState();
  renderTable(proposedTable, headers, rows, proposedRowCount);
  if (currentDraft) {
    renderSummary(draftSummary, [
      ['Calories', currentDraft.summary?.totalCalories ?? ''],
      ['Sheet Change', saveBehaviorLabel(currentDraft.writeMode)],
      ['Quality', currentDraft.summary?.overallFoodQuality ?? ''],
      ['Score', currentDraft.summary?.qualityScore ?? ''],
    ]);
  } else {
    renderSummary(draftSummary, [
      ['Calories', currentDay?.totals?.calories ?? ''],
      ['Protein', currentDay?.totals?.protein ?? ''],
      ['Carbs', currentDay?.totals?.carbs ?? ''],
      ['Water', currentDay?.totals?.water ?? ''],
    ]);
  }
}

function renderSaveButton() {
  const writeMode = currentDraft?.writeMode || currentWriteMode;
  approveButton.textContent = 'Save to Google Sheet';
  approveButton.classList.toggle('danger-button', writeMode === 'replace');
  approveButton.classList.toggle('primary-button', writeMode !== 'replace');
}

function renderAll() {
  renderChat();
  renderDraft();
  renderSaveButton();
  setBusy(false);
}

function setupSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    micButton.disabled = true;
    micButton.title = 'Speech recognition is not available in this browser.';
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.addEventListener('start', () => {
    isListening = true;
    finalTranscriptBeforeListen = chatInput.value.trim();
    micButton.classList.add('is-active');
    micLabel.textContent = 'Stop';
    setMessage('Listening.', '');
  });

  recognition.addEventListener('end', () => {
    isListening = false;
    micButton.classList.remove('is-active');
    micLabel.textContent = 'Dictate';
  });

  recognition.addEventListener('error', (event) => {
    setMessage(event.error ? `Speech error: ${event.error}` : 'Speech recognition stopped.', 'error');
  });

  recognition.addEventListener('result', (event) => {
    let interim = '';
    let finalized = '';

    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const text = result[0]?.transcript || '';
      if (result.isFinal) {
        finalized += `${text} `;
      } else {
        interim += text;
      }
    }

    const base = [finalTranscriptBeforeListen, finalized.trim()].filter(Boolean).join(' ');
    chatInput.value = [base, interim.trim()].filter(Boolean).join(' ');
    if (finalized.trim()) {
      finalTranscriptBeforeListen = chatInput.value.trim();
    }
  });
}

async function loadConfig() {
  const config = await apiRequest('/api/config');
  sheetLink.href = config.spreadsheetUrl;
  agentStatus.textContent = config.agent?.hasOpenAiConfig ? `Agent: ${config.agent.model}` : 'Agent: missing key';
  agentStatus.dataset.state = config.agent?.hasOpenAiConfig ? 'ok' : 'warn';
  sheetStatus.textContent = config.google?.configured ? `Sheet: ${config.sheetTabName}` : 'Sheet: missing credentials';
  sheetStatus.dataset.state = config.google?.configured ? 'ok' : 'warn';
}

async function loadDay() {
  updateSelectedDateLabel();
  currentDraft = null;
  currentPreviews = { add: null, replace: null };
  currentWriteMode = 'add';
  loadConversation();
  setBusy(true);
  try {
    currentDay = await apiRequest(`/api/day?date=${encodeURIComponent(dateInput.value)}&ensure=1`);
    setCurrentDayChatEvent();
    if (currentDay.createdDayBlock) {
      setMessage('Created the day block.', 'success');
    } else {
      setMessage('', '');
    }
  } catch (error) {
    chatEvents = [];
    setMessage(error.message || 'Could not load the selected day.', 'error');
  } finally {
    renderAll();
  }
}

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text) return;

  const role = currentDraft ? 'feedback' : 'user';
  const previousDraft = currentDraft;
  const previousRows = proposedRowsForCurrentState().map((row) => [...row]);
  chatMessages.push({ role, text });
  if (role === 'feedback') addTrainingNote(text);
  saveConversation();
  chatInput.value = '';
  chatEvents = [];
  renderChat();
  setMessage('', '');
  setBusy(true);

  try {
    const payload = await apiRequest('/api/diet-draft', {
      method: 'POST',
      body: JSON.stringify({
        date: dateInput.value,
        messages: chatMessages,
        trainingNotes: getTrainingNotes(),
        previousDraft,
      }),
    });

    currentDay = payload.currentDay;
    currentDraft = payload.generated;
    currentPreviews = payload.previews || { add: null, replace: null };
    currentWriteMode = currentDraft.writeMode === 'replace' ? 'replace' : 'add';
    chatEvents = [
      {
        role: 'assistant',
        text: draftGuidanceText(currentDraft, proposedTableChangeLines(previousRows, proposedRowsForCurrentState())),
      },
    ];
    renderAll();
    setMessage('Review the draft before approving.', 'success');
  } catch (error) {
    setMessage(error.message || 'Could not generate a draft.', 'error');
    renderAll();
  }
}

async function approveDraft() {
  if (!currentDraft) return;

  const writeMode = currentDraft.writeMode === 'replace' ? 'replace' : 'add';
  if (writeMode === 'replace') {
    const ok = window.confirm(`The agent inferred this should replace the selected day's food rows and daily notes. Save this draft?`);
    if (!ok) return;
  }

  setBusy(true);
  setMessage('', '');
  try {
    const payload = await apiRequest('/api/diet-commit', {
      method: 'POST',
      body: JSON.stringify({
        date: dateInput.value,
        generated: currentDraft,
      }),
    });

    currentDay = payload.currentDay;
    currentDraft = null;
    currentPreviews = { add: null, replace: null };
    currentWriteMode = 'add';
    chatEvents = [{ role: 'assistant', text: savedGuidanceText(payload.generated.rows.length) }];
    renderAll();
    setMessage('Saved to the sheet.', 'success');
  } catch (error) {
    setMessage(error.message || 'Could not save the draft.', 'error');
    renderAll();
  }
}

dateInput.value = localDateValue();
updateSelectedDateLabel();
setupSpeechRecognition();

dateInput.addEventListener('change', () => {
  void loadDay();
});

micButton.addEventListener('click', () => {
  if (!recognition) return;
  if (isListening) {
    recognition.stop();
  } else {
    recognition.start();
  }
});

sendButton.addEventListener('click', () => {
  void sendMessage();
});

approveButton.addEventListener('click', () => {
  void approveDraft();
});

logoutButton.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/';
});

loadConfig()
  .then(() => loadDay())
  .catch((error) => {
    if (error.status === 401) {
      window.location.href = '/login.html';
      return;
    }
    setMessage(error.message || 'Could not load app configuration.', 'error');
  });

const dateInput = document.querySelector('#date-input');
const selectedDateLabel = document.querySelector('#selected-date-label');
const chatInput = document.querySelector('#chat-input');
const chatLog = document.querySelector('#chat-log');
const micButton = document.querySelector('#mic-button');
const micLabel = document.querySelector('#mic-label');
const clearButton = document.querySelector('#clear-button');
const sendButton = document.querySelector('#send-button');
const writeModeInputs = Array.from(document.querySelectorAll('input[name="write-mode"]'));
const infoButtons = Array.from(document.querySelectorAll('.info-icon'));
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
let selectedPreviewMode = 'add';
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
    'Would you like to alter or replace any data for this day? You can ask me to add food, correct an item, replace part of the day, estimate calories and macros, or add water.',
    'Try things like: "Add a 20 gram protein bar at 3 PM", "That protein bar was 190 calories and 20g protein", "Replace lunch with two eggs and toast", or "Add 24 oz water at noon".',
    'When the table looks right, choose Add proposed rows into open time slots or Replace this day with proposed rows, then save it to the sheet.',
  );

  return lines.join('\n');
}

function draftGuidanceText(draft) {
  const entryCount = draft?.entries?.length || 0;
  const lines = [
    `Draft ready with ${entryCount} ${entryCount === 1 ? 'entry' : 'entries'}.`,
    'See the Proposed Submission table for the proposed day using the selected save option.',
    '',
    'If something is off, type feedback before saving. For example: "That protein bar was 190 calories and 20g protein", "Move the snack to 4 PM", or "Replace dinner with chicken soup".',
    'Use Add proposed rows into open time slots to keep existing sheet data. Use Replace this day with proposed rows when the proposed table should become the whole day.',
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
  writeModeInputs.forEach((input) => {
    input.disabled = isBusy || !currentDraft;
  });
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
  return currentPreviews[selectedPreviewMode] || null;
}

function renderDraft() {
  const preview = activePreview();
  const headers = preview?.headers || currentDay?.headers || [];
  const rows = preview?.afterRows || preview?.rows || currentDay?.rows || [];
  renderTable(proposedTable, headers, rows, proposedRowCount);
  if (currentDraft) {
    renderSummary(draftSummary, [
      ['Calories', currentDraft.summary?.totalCalories ?? ''],
      ['Quality', currentDraft.summary?.overallFoodQuality ?? ''],
      ['Score', currentDraft.summary?.qualityScore ?? ''],
      ['Model', currentDraft.model ?? ''],
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

function renderPreviewToggle() {
  writeModeInputs.forEach((input) => {
    input.checked = input.value === selectedPreviewMode;
  });
  approveButton.textContent = 'Save proposed submission to sheet';
  approveButton.classList.toggle('danger-button', selectedPreviewMode === 'replace');
  approveButton.classList.toggle('primary-button', selectedPreviewMode !== 'replace');
}

function renderAll() {
  renderChat();
  renderDraft();
  renderPreviewToggle();
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
  selectedPreviewMode = 'add';
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
        previousDraft: currentDraft,
      }),
    });

    currentDay = payload.currentDay;
    currentDraft = payload.generated;
    currentPreviews = payload.previews || { add: null, replace: null };
    selectedPreviewMode = 'add';
    chatEvents = [{ role: 'assistant', text: draftGuidanceText(currentDraft) }];
    renderAll();
    setMessage('Review the draft before approving.', 'success');
  } catch (error) {
    setMessage(error.message || 'Could not generate a draft.', 'error');
    renderAll();
  }
}

async function approveDraft(writeMode) {
  if (!currentDraft) return;

  if (writeMode === 'replace') {
    const ok = window.confirm(`Replace all food rows and daily notes for ${dateInput.value} with this draft?`);
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
        writeMode,
      }),
    });

    currentDay = payload.currentDay;
    currentDraft = null;
    currentPreviews = { add: null, replace: null };
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

clearButton.addEventListener('click', () => {
  chatMessages = [];
  currentDraft = null;
  currentPreviews = { add: null, replace: null };
  sessionStorage.removeItem(conversationKey());
  chatInput.value = '';
  chatInput.focus();
  setMessage('', '');
  setCurrentDayChatEvent();
  renderAll();
});

sendButton.addEventListener('click', () => {
  void sendMessage();
});

writeModeInputs.forEach((input) => {
  input.addEventListener('change', () => {
    if (!input.checked) return;
    selectedPreviewMode = input.value === 'replace' ? 'replace' : 'add';
    renderDraft();
    renderPreviewToggle();
  });
});

infoButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const help = document.getElementById(button.getAttribute('aria-controls'));
    if (!help) return;
    const isOpen = !help.hidden;
    help.hidden = isOpen;
    button.setAttribute('aria-expanded', String(!isOpen));
  });
});

approveButton.addEventListener('click', () => {
  void approveDraft(selectedPreviewMode);
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

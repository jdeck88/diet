const dateInput = document.querySelector('#date-input');
const chatInput = document.querySelector('#chat-input');
const chatLog = document.querySelector('#chat-log');
const micButton = document.querySelector('#mic-button');
const micLabel = document.querySelector('#mic-label');
const clearButton = document.querySelector('#clear-button');
const sendButton = document.querySelector('#send-button');
const previewAddButton = document.querySelector('#preview-add-button');
const previewReplaceButton = document.querySelector('#preview-replace-button');
const approveAddButton = document.querySelector('#approve-add-button');
const approveReplaceButton = document.querySelector('#approve-replace-button');
const logoutButton = document.querySelector('#logout-button');
const sheetLink = document.querySelector('#sheet-link');
const message = document.querySelector('#message');
const agentStatus = document.querySelector('#agent-status');
const sheetStatus = document.querySelector('#sheet-status');
const currentSummary = document.querySelector('#current-summary');
const draftSummary = document.querySelector('#draft-summary');
const previewSummary = document.querySelector('#preview-summary');
const currentRowCount = document.querySelector('#current-row-count');
const proposedRowCount = document.querySelector('#proposed-row-count');
const previewRowCount = document.querySelector('#preview-row-count');
const currentTable = document.querySelector('#current-table');
const proposedTable = document.querySelector('#proposed-table');
const previewTable = document.querySelector('#preview-table');

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

function setMessage(text, tone = '') {
  message.textContent = text;
  message.dataset.tone = tone;
}

function setBusy(isBusy) {
  sendButton.disabled = isBusy;
  approveAddButton.disabled = isBusy || !currentDraft;
  approveReplaceButton.disabled = isBusy || !currentDraft;
  previewAddButton.disabled = isBusy || !currentDraft;
  previewReplaceButton.disabled = isBusy || !currentDraft;
  sendButton.classList.toggle('is-loading', isBusy);
  approveAddButton.classList.toggle('is-loading', isBusy);
  approveReplaceButton.classList.toggle('is-loading', isBusy);
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

function renderCurrentDay() {
  const headers = currentDay?.headers || [];
  const rows = currentDay?.rows || [];
  renderTable(currentTable, headers, rows, currentRowCount);
  renderSummary(currentSummary, [
    ['Calories', currentDay?.totals?.calories || ''],
    ['Protein', currentDay?.totals?.protein || ''],
    ['Carbs', currentDay?.totals?.carbs || ''],
    ['H2O', currentDay?.totals?.water || ''],
  ]);
}

function activePreview() {
  return currentPreviews[selectedPreviewMode] || null;
}

function renderDraft() {
  const preview = activePreview();
  const headers = preview?.headers || currentDay?.headers || [];
  const rows = preview?.rows || [];
  renderTable(proposedTable, headers, rows, proposedRowCount);
  renderSummary(draftSummary, [
    ['Calories', currentDraft?.summary?.totalCalories ?? ''],
    ['Quality', currentDraft?.summary?.overallFoodQuality ?? ''],
    ['Score', currentDraft?.summary?.qualityScore ?? ''],
    ['Model', currentDraft?.model ?? ''],
  ]);
}

function renderPreview() {
  const preview = activePreview();
  const headers = preview?.headers || currentDay?.headers || [];
  const rows = preview?.afterRows || currentDay?.rows || [];
  renderTable(previewTable, headers, rows, previewRowCount);
  renderSummary(previewSummary, [
    ['Mode', selectedPreviewMode === 'replace' ? 'Replace' : 'Add'],
    ['Rows', preview?.rows?.length ?? 0],
    ['Feel', preview?.reflection?.howDoYouFeel || currentDay?.reflection?.howDoYouFeel || ''],
    ['Want', preview?.reflection?.whatDoYouWant || currentDay?.reflection?.whatDoYouWant || ''],
  ]);

  previewAddButton.classList.toggle('is-selected', selectedPreviewMode === 'add');
  previewReplaceButton.classList.toggle('is-selected', selectedPreviewMode === 'replace');
}

function renderAll() {
  renderChat();
  renderCurrentDay();
  renderDraft();
  renderPreview();
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
  currentDraft = null;
  currentPreviews = { add: null, replace: null };
  selectedPreviewMode = 'add';
  loadConversation();
  setBusy(true);
  try {
    currentDay = await apiRequest(`/api/day?date=${encodeURIComponent(dateInput.value)}&ensure=1`);
    if (currentDay.createdDayBlock) {
      setMessage('Created the day block.', 'success');
    } else {
      setMessage('', '');
    }
  } catch (error) {
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
    chatEvents = [
      {
        role: 'assistant',
        text: `Draft ready with ${currentDraft.entries.length} ${currentDraft.entries.length === 1 ? 'entry' : 'entries'}.`,
      },
    ];
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
    chatEvents = [{ role: 'assistant', text: `Saved ${payload.generated.rows.length} ${payload.generated.rows.length === 1 ? 'row' : 'rows'}.` }];
    renderAll();
    setMessage('Saved to the sheet.', 'success');
  } catch (error) {
    setMessage(error.message || 'Could not save the draft.', 'error');
    renderAll();
  }
}

dateInput.value = localDateValue();
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
  chatEvents = [];
  currentDraft = null;
  currentPreviews = { add: null, replace: null };
  sessionStorage.removeItem(conversationKey());
  chatInput.value = '';
  chatInput.focus();
  setMessage('', '');
  renderAll();
});

sendButton.addEventListener('click', () => {
  void sendMessage();
});

previewAddButton.addEventListener('click', () => {
  selectedPreviewMode = 'add';
  renderDraft();
  renderPreview();
});

previewReplaceButton.addEventListener('click', () => {
  selectedPreviewMode = 'replace';
  renderDraft();
  renderPreview();
});

approveAddButton.addEventListener('click', () => {
  void approveDraft('add');
});

approveReplaceButton.addEventListener('click', () => {
  void approveDraft('replace');
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

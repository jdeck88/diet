const dateInput = document.querySelector('#date-input');
const transcriptInput = document.querySelector('#transcript');
const micButton = document.querySelector('#mic-button');
const micLabel = document.querySelector('#mic-label');
const clearButton = document.querySelector('#clear-button');
const submitButton = document.querySelector('#submit-button');
const logoutButton = document.querySelector('#logout-button');
const sheetLink = document.querySelector('#sheet-link');
const message = document.querySelector('#message');
const agentStatus = document.querySelector('#agent-status');
const sheetStatus = document.querySelector('#sheet-status');
const summary = document.querySelector('#summary');
const rowCount = document.querySelector('#row-count');
const tableHead = document.querySelector('#preview-table thead');
const tableBody = document.querySelector('#preview-table tbody');

let sheetProfile = null;
let recognition = null;
let isListening = false;
let finalTranscriptBeforeListen = '';

function localDateValue(date = new Date()) {
  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return offsetDate.toISOString().slice(0, 10);
}

function setMessage(text, tone = '') {
  message.textContent = text;
  message.dataset.tone = tone;
}

function setBusy(isBusy) {
  submitButton.disabled = isBusy;
  submitButton.classList.toggle('is-loading', isBusy);
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

function renderTable(headers, rows) {
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

  rowCount.textContent = `${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`;
}

function renderSummary(result) {
  const items = [
    ['Calories', result?.summary?.totalCalories ?? ''],
    ['Quality', result?.summary?.overallFoodQuality ?? ''],
    ['Score', result?.summary?.qualityScore ?? ''],
    ['Model', result?.model ?? ''],
  ];

  summary.innerHTML = '';
  items.forEach(([label, value]) => {
    const item = document.createElement('div');
    item.className = 'summary-item';
    const labelEl = document.createElement('span');
    labelEl.textContent = label;
    const valueEl = document.createElement('strong');
    valueEl.textContent = String(value || 'Blank');
    item.append(labelEl, valueEl);
    summary.appendChild(item);
  });
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
    finalTranscriptBeforeListen = transcriptInput.value.trim();
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
    transcriptInput.value = [base, interim.trim()].filter(Boolean).join(' ');
    if (finalized.trim()) {
      finalTranscriptBeforeListen = transcriptInput.value.trim();
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

  sheetProfile = await apiRequest('/api/sheet-profile');
  renderTable(sheetProfile.headers, []);
}

async function submitDietLog() {
  setMessage('', '');
  setBusy(true);

  try {
    const payload = await apiRequest('/api/diet-log', {
      method: 'POST',
      body: JSON.stringify({
        date: dateInput.value,
        transcript: transcriptInput.value,
      }),
    });

    sheetProfile = payload.profile;
    renderSummary(payload.generated);
    renderTable(payload.profile.headers, payload.generated.rows);
    setMessage(`Wrote ${payload.generated.rows.length} ${payload.generated.rows.length === 1 ? 'row' : 'rows'} to ${payload.profile.sheetTabName}.`, 'success');
  } catch (error) {
    setMessage(error.message || 'Could not write diet log.', 'error');
    if (error.payload?.generated && error.payload?.profile) {
      renderSummary(error.payload.generated);
      renderTable(error.payload.profile.headers, error.payload.generated.rows || []);
    }
  } finally {
    setBusy(false);
  }
}

dateInput.value = localDateValue();
setupSpeechRecognition();

micButton.addEventListener('click', () => {
  if (!recognition) return;
  if (isListening) {
    recognition.stop();
  } else {
    recognition.start();
  }
});

clearButton.addEventListener('click', () => {
  transcriptInput.value = '';
  transcriptInput.focus();
  setMessage('', '');
});

submitButton.addEventListener('click', () => {
  void submitDietLog();
});

logoutButton.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/';
});

loadConfig().catch((error) => {
  if (error.status === 401) {
    window.location.href = '/login.html';
    return;
  }
  setMessage(error.message || 'Could not load app configuration.', 'error');
});

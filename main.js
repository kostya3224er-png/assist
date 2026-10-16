const { app, BrowserWindow, ipcMain, session, clipboard, Menu, dialog, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const runFile = promisify(execFile);
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

let win, startupData, systemAudioCapture, cursorHidden = true, hotkeyCapture = false, mouseHook, mouseHookRunning = false, inputBindings = new Map(), pressedKeys = new Map(), activeHotkeys, uiohookKeys, keyNames, plaintextSecretWarningIssued = false;
let googleSpeechClient, googleSpeechCredentialsPath;
const lockedSecrets = {};
const dataPath = () => path.join(app.getPath('userData'), 'assist-data.json');
const defaults = { settings: { apiKey: '', model: '', endpoint: '', checkApiOnStartup: false, sttProvider: 'auto', sttApiKey: '', googleSpeechCredentialsPath: '', voiceLanguage: 'ru-RU', audioMode: 'both', inputDevice: '', outputDevice: '', sensitivity: 70, lang: 'auto', verbosity: 'Суть (коротко)', hotkey: 'Ctrl+Shift+A', cursorHotkey: 'F1', delay: 'Быстрая (~1с)', opacity: 90, streamProof: false, playerRole: '', gameProject: '', customPrompt: '', theme: 'purple', windowWidth: 960, windowHeight: 760 }, topics: [], history: [], corrections: [] };
activeHotkeys = [defaults.settings.hotkey, defaults.settings.cursorHotkey];
const secretFields = ['apiKey', 'sttApiKey'], encryptedPrefix = 'safeStorage:v1:';
let dataWriteQueue = Promise.resolve();
function readData() {
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(dataPath(), 'utf8'));
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Файл данных не содержит JSON-объект.');
  }
  catch (error) {
    if (error.code !== 'ENOENT' && fs.existsSync(dataPath())) {
      const backup = `${dataPath()}.corrupt-${Date.now()}.bak`;
      try { fs.copyFileSync(dataPath(), backup, fs.constants.COPYFILE_EXCL); console.error(`Settings JSON is invalid; original data preserved at ${backup}`, error); }
      catch (backupError) { console.error('Settings JSON is invalid and could not be backed up:', backupError); }
    }
    return structuredClone(defaults);
  }
  const data = { ...structuredClone(defaults), ...saved, settings: { ...defaults.settings, ...saved.settings } };
  const oldCorrections = Array.isArray(saved.corrections) ? saved.corrections : [];
  const feedbackFromHistory = (Array.isArray(saved.history) ? saved.history : []).filter(entry => entry?.feedback?.expected).map(entry => ({ ...entry.feedback, q: entry.q }));
  const correctionKeys = new Set(oldCorrections.filter(item => item?.expected && item?.q).map(item => `${item.project || ''}\0${item.questionKey || ''}\0${item.expected}`));
  data.corrections = [...oldCorrections.filter(item => item?.expected && item?.q), ...feedbackFromHistory.filter(item => !correctionKeys.has(`${item.project || ''}\0${item.questionKey || ''}\0${item.expected}`))];
  let migrateSecrets = false, migrateTopics = false, migrateCorrections = !Array.isArray(saved.corrections) || data.corrections.length !== oldCorrections.length;
  if (!Array.isArray(saved.topics)) {
    const oldSources = Array.isArray(saved.sources) ? saved.sources : [];
    const name = String(data.settings.gameProject || '').trim() || 'Основной проект';
    data.topics = oldSources.length ? [{ id: randomUUID(), name, enabled: true, sources: oldSources }] : [];
    migrateTopics = true;
  } else {
    data.topics = saved.topics.filter(topic => topic && typeof topic === 'object').map(topic => ({
      id: typeof topic.id === 'string' && topic.id ? topic.id : randomUUID(),
      name: (typeof topic.name === 'string' && topic.name.trim() ? topic.name.trim() : 'Новая тема').slice(0, 120),
      enabled: topic.enabled !== false,
      sources: Array.isArray(topic.sources) ? topic.sources : []
    }));
    migrateTopics = data.topics.length !== saved.topics.length || data.topics.some((topic, i) => topic.id !== saved.topics[i]?.id || topic.name !== saved.topics[i]?.name || topic.enabled !== saved.topics[i]?.enabled || typeof saved.topics[i]?.searchDictionary === 'string' || !Array.isArray(saved.topics[i]?.sources));
  }
  if ('sources' in data) { delete data.sources; migrateTopics = true; }
  for (const key of secretFields) {
    const value = data.settings[key];
    if (value && typeof value === 'object' && value.encrypted === 1 && typeof value.data === 'string') {
      try {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage недоступен');
        data.settings[key] = safeStorage.decryptString(Buffer.from(value.data, 'base64'));
      } catch {
        lockedSecrets[key] = value;
        data.settings[key] = '';
        console.warn(`Не удалось расшифровать ${key}; зашифрованное значение сохранено. Введите API-ключ заново для его использования.`);
      }
    } else if (typeof value === 'string' && value.startsWith(encryptedPrefix)) {
      try {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage недоступен');
        data.settings[key] = safeStorage.decryptString(Buffer.from(value.slice(encryptedPrefix.length), 'base64'));
        migrateSecrets = true;
      } catch {
        lockedSecrets[key] = value;
        data.settings[key] = '';
        console.warn(`Не удалось расшифровать ${key}; зашифрованное значение сохранено. Введите API-ключ заново для его использования.`);
      }
    } else if (typeof value === 'string' && value && safeStorage.isEncryptionAvailable()) migrateSecrets = true;
  }
  if (migrateSecrets || migrateTopics || migrateCorrections) try { writeData(data); } catch (error) { console.error('Could not migrate Assist data; continuing with the original file:', error); }
  return data;
}
function prepareDataJson(data) {
  if (!data || typeof data !== 'object' || !data.settings || typeof data.settings !== 'object') throw new Error('Некорректные данные приложения');
  const saved = structuredClone(data);
  for (const key of secretFields) {
    const value = saved.settings[key];
    if (typeof value === 'string' && value && safeStorage.isEncryptionAvailable()) {
      saved.settings[key] = { encrypted: 1, data: safeStorage.encryptString(value).toString('base64') };
      delete lockedSecrets[key];
    } else if (typeof value === 'string' && value && !safeStorage.isEncryptionAvailable()) {
      if (!plaintextSecretWarningIssued) console.warn('safeStorage недоступен: API-ключи будут сохранены без шифрования.');
      plaintextSecretWarningIssued = true;
    } else if (!value && lockedSecrets[key]) saved.settings[key] = lockedSecrets[key];
  }
  const json = JSON.stringify(saved);
  if (json.length > 50_000_000) throw new Error('Данные приложения превышают допустимый размер (50 МБ)');
  return json;
}
function writeData(data) {
  const json = prepareDataJson(data), file = dataPath(), temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.writeFileSync(temporary, json, { encoding: 'utf8', flag: 'wx' }); fs.renameSync(temporary, file); }
  catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
}
function writeDataAsync(data) {
  const json = prepareDataJson(data), file = dataPath(), temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const write = dataWriteQueue.catch(() => {}).then(async () => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    try { await fs.promises.writeFile(temporary, json, { encoding: 'utf8', flag: 'wx' }); await fs.promises.rename(temporary, file); }
    catch (error) { await fs.promises.rm(temporary, { force: true }).catch(() => {}); throw error; }
  });
  dataWriteQueue = write;
  return write;
}
function setOverlayInputPassthrough(enabled) {
  cursorHidden = !!enabled;
  if (!win || win.isDestroyed()) return;
  win.setIgnoreMouseEvents(cursorHidden, { forward: true });
  win.webContents.send('app:cursor-visibility', cursorHidden);
}
function reapplyOverlayWindowState() {
  if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return;
  win.setAlwaysOnTop(true, 'screen-saver'); win.setSkipTaskbar(true);
  win.setIgnoreMouseEvents(cursorHidden, { forward: true });
}
function scheduleOverlayWindowState() { setTimeout(reapplyOverlayWindowState, 0); setTimeout(reapplyOverlayWindowState, 120); setTimeout(reapplyOverlayWindowState, 300); }
function toggleCursor() { if (!hotkeyCapture && win && !win.isDestroyed() && win.isVisible()) setOverlayInputPassthrough(!cursorHidden); }
function toggle() {
  if (hotkeyCapture || !win || win.isDestroyed()) return;
  if (win.isVisible() && !win.isMinimized()) { win.setFocusable(false); win.minimize(); return; }
  setOverlayInputPassthrough(false);
  if (win.isMinimized()) { win.restore(); scheduleOverlayWindowState(); return; }
  win.setFocusable(false);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.showInactive(); win.moveTop();
  scheduleOverlayWindowState();
}
app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible() || win.isMinimized()) toggle(); else { win.setFocusable(false); win.showInactive(); win.moveTop(); setOverlayInputPassthrough(false); scheduleOverlayWindowState(); }
});
function validWindowSize(width, height) { return Number.isInteger(width) && Number.isInteger(height) && width >= 600 && width <= 3840 && height >= 500 && height <= 2160; }
function parseHotkey(value) {
  if (typeof value !== 'string' || value.length > 80) throw new Error('Некорректная горячая клавиша');
  if (!uiohookKeys) uiohookKeys = require('uiohook-napi').UiohookKey;
  const parts = value.split('+').map(part => part.trim()).filter(Boolean);
  const key = parts.pop();
  const modifiers = parts.map(part => ({ Ctrl: 'Control', Cmd: 'Command', Win: 'Command', Meta: 'Command' }[part] || part));
  if (!key || new Set(modifiers).size !== modifiers.length || modifiers.some(part => !['Control', 'Command', 'Alt', 'Shift'].includes(part))) throw new Error('Некорректное сочетание клавиш');
  const mouseNames = { MouseLeft: 1, MouseRight: 2, MouseMiddle: 3, Mouse4: 4, Mouse5: 5 };
  if (key in mouseNames) return { mouse: mouseNames[key], modifiers, value: [...modifiers, key].join('+') };
  if (key.startsWith('Mouse')) throw new Error('Неизвестная кнопка мыши');
  const aliases = { Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', Esc: 'Escape', Return: 'Enter', Cmd: 'Meta' };
  const keycode = uiohookKeys?.[aliases[key] || key];
  if (!keycode) throw new Error('Эта клавиша не поддерживается');
  return { keycode, modifiers, value: [...modifiers, key].join('+') };
}
function setHotkeys(overlayValue, cursorValue, restoring = false) {
  let overlay, cursor;
  try { overlay = parseHotkey(overlayValue); cursor = parseHotkey(cursorValue); }
  catch { return false; }
  if (overlay.value.toLowerCase() === cursor.value.toLowerCase()) return false;
  try {
    const { uIOhook, UiohookKey } = require('uiohook-napi');
    uiohookKeys = UiohookKey;
    if (!mouseHook) {
      mouseHook = uIOhook;
      keyNames = Object.fromEntries(Object.entries(UiohookKey).filter(([name, value]) => typeof value === 'number' && !['CtrlRight','AltRight','ShiftRight','MetaRight'].includes(name)).map(([name, value]) => [value, name]));
      mouseHook.on('keydown', event => {
        const now = Date.now(), lastDown = pressedKeys.get(event.keycode);
        if (lastDown && now - lastDown < 1000) { pressedKeys.set(event.keycode, now); return; }
        pressedKeys.set(event.keycode, now);
        const key = keyNames[event.keycode];
        if (!key || ['Ctrl','Alt','Shift','Meta'].includes(key)) return;
        const mods = [event.ctrlKey && 'Control', event.shiftKey && 'Shift', event.altKey && 'Alt', event.metaKey && 'Command'].filter(Boolean).sort().join('+');
        if (hotkeyCapture) return win?.webContents.send('app:hotkey-captured', [...mods.split('+').filter(Boolean).map(m => ({Control:'Ctrl',Command:'Cmd'}[m] || m)), key].join('+'));
        inputBindings.get(`key:${event.keycode}:${mods}`)?.();
      });
      mouseHook.on('keyup', event => pressedKeys.delete(event.keycode));
      mouseHook.on('mousedown', event => {
        if (!win || win.isDestroyed()) return;
        const mods = [event.ctrlKey && 'Control', event.shiftKey && 'Shift', event.altKey && 'Alt', event.metaKey && 'Command'].filter(Boolean).sort().join('+');
        const mouseName = ({1:'MouseLeft',2:'MouseRight',3:'MouseMiddle',4:'Mouse4',5:'Mouse5'})[event.button];
        if (hotkeyCapture) return mouseName && win.webContents.send('app:hotkey-captured', [...mods.split('+').filter(Boolean).map(m => ({Control:'Ctrl',Command:'Cmd'}[m] || m)), mouseName].join('+'));
        const b = win.getBounds();
        if (!cursorHidden && win.isVisible() && event.x >= b.x && event.x <= b.x + b.width && event.y >= b.y && event.y <= b.y + b.height) return;
        inputBindings.get(`mouse:${event.button}:${mods}`)?.();
      });
    }
    const bindings = new Map();
    for (const [binding, action] of [[overlay, toggle], [cursor, toggleCursor]]) {
      const mods = binding.modifiers.slice().sort().join('+');
      bindings.set(binding.mouse ? `mouse:${binding.mouse}:${mods}` : `key:${binding.keycode}:${mods}`, action);
    }
    inputBindings = bindings;
    if (!mouseHookRunning) { mouseHook.start(); mouseHookRunning = true; }
    activeHotkeys = [overlayValue, cursorValue];
    return true;
  } catch (error) {
    console.error('Failed to register overlay hotkeys:', error);
    if (!restoring && activeHotkeys) setHotkeys(...activeHotkeys, true);
    return false;
  }
}
function audioScriptPath() { return path.join(app.isPackaged ? process.resourcesPath : __dirname, 'audio-devices.ps1'); }
async function runAudioScript(...args) {
  try {
    return await runFile('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-NonInteractive', '-File', audioScriptPath(), ...args], { windowsHide: true, timeout: args[0] === 'transcribe' ? 20000 : 15000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
  } catch (error) { const detail = typeof error?.message === 'string' ? error.message : String(error || 'Неизвестная ошибка'); throw new Error(`Не удалось выполнить PowerShell-скрипт аудиоустройств. Пересоберите приложение или проверьте PowerShell: ${detail.split('\n')[0]}`); }
}
function stripHtml(html) {
  if (typeof html !== 'string') return '';
  return html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#(?:x([\da-f]+)|(\d+));/gi, (match, hex, decimal) => { const code = Number.parseInt(hex || decimal, hex ? 16 : 10); return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ' '; }).replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}
function trustedSender(event) { return !!win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url === win.webContents.getURL(); }
function handle(channel, listener) { ipcMain.handle(channel, (event, ...args) => { if (!trustedSender(event)) throw new Error('Отклонён недоверенный IPC-отправитель'); return listener(event, ...args); }); }
handle('data:load', () => startupData ? structuredClone(startupData) : (startupData = readData()));
handle('data:save', async (_e, data) => { await writeDataAsync(data); startupData = structuredClone(data); return true; });
handle('app:secret-storage-status', () => ({ available: safeStorage.isEncryptionAvailable(), locked: Object.keys(lockedSecrets).length > 0 }));
handle('data:reset', async () => { for (const key of secretFields) delete lockedSecrets[key]; const reset = structuredClone(defaults); await writeDataAsync(reset); startupData = reset; setHotkeys(defaults.settings.hotkey, defaults.settings.cursorHotkey); win?.setContentSize(defaults.settings.windowWidth, defaults.settings.windowHeight); win?.setOpacity(defaults.settings.opacity / 100); win?.setContentProtection(false); return true; });
handle('app:toggle', toggle);
handle('app:close', () => app.quit());
handle('app:minimize', () => win?.minimize());
handle('app:size', (_event, { width, height } = {}) => {
  if (!validWindowSize(width, height)) throw new Error('Размер окна должен быть от 600×500 до 3840×2160.');
  if (!win || win.isDestroyed()) throw new Error('Окно приложения уже закрыто. Перезапустите приложение.');
  win.setContentSize(width, height);
  const [actualWidth, actualHeight] = win.getContentSize();
  return { width: actualWidth, height: actualHeight };
});
handle('app:opacity', (_e, value) => { const numeric = Number(value); if (!Number.isFinite(numeric)) throw new Error('Прозрачность должна быть числом.'); const opacity = Math.max(0.4, Math.min(1, numeric / 100)); win?.setOpacity(opacity); return opacity; });
handle('app:stream-proof', (_e, enabled) => { win?.setContentProtection(!!enabled); return !!enabled; });
handle('app:copy', (_e, text) => { if (typeof text !== 'string' || text.length > 100000) throw new Error('Некорректный текст'); clipboard.writeText(text); return true; });
handle('app:hotkeys', (_e, keys = {}) => setHotkeys(keys.overlay, keys.cursor));
handle('app:hotkey-capture', (_e, enabled) => {
  hotkeyCapture = !!enabled;
  if (!hotkeyCapture && activeHotkeys) setHotkeys(...activeHotkeys);
  return true;
});
handle('app:text-focus', (_e, active) => {
  if (!win || win.isDestroyed()) return false;
  win.setFocusable(!!active);
  if (active) win.focus(); else { win.blur(); if (win.isVisible() && !win.isMinimized()) win.showInactive(); }
  win.setSkipTaskbar(true);
  return true;
});
ipcMain.on('app:activate-text-input', event => {
  if (!trustedSender(event) || !win || win.isDestroyed()) { event.returnValue = false; return; }
  win.setFocusable(true); win.focus(); win.setSkipTaskbar(true); event.returnValue = true;
});
handle('google-speech:choose-credentials', async () => {
  const result = await dialog.showOpenDialog(win, { title: 'Выберите ключ сервисного аккаунта Google Cloud', properties: ['openFile'], filters: [{ name: 'Service account JSON', extensions: ['json'] }] });
  return result.canceled ? '' : result.filePaths[0];
});
handle('audio:outputs', async () => {
  if (process.platform !== 'win32') return [];
  const { stdout } = await runAudioScript('list');
  const devices = JSON.parse(stdout || '[]');
  return Array.isArray(devices) ? devices : [devices];
});
function stopSystemAudioCapture() {
  const capture = systemAudioCapture;
  systemAudioCapture = null;
  try { capture?.stop(); } catch (error) { console.warn('Could not stop WASAPI loopback capture:', error); }
}
handle('audio:system-start', () => {
  if (process.platform !== 'win32') throw new Error('Захват системного звука WASAPI доступен в Windows.');
  stopSystemAudioCapture();
  const { LoopbackCapture } = require('loopback-capture');
  const capture = new LoopbackCapture();
  systemAudioCapture = capture;
  try {
    capture.startSystemAudio(chunk => {
      if (systemAudioCapture !== capture || !win || win.isDestroyed() || win.webContents.isDestroyed()) return;
      const audio = Uint8Array.from(chunk);
      win.webContents.send('audio:system-data', audio.buffer);
    });
    return true;
  } catch (error) {
    stopSystemAudioCapture();
    throw new Error(`Не удалось захватить системный звук WASAPI: ${error.message || error}. Проверьте устройство вывода Windows.`);
  }
});
handle('audio:system-stop', () => { stopSystemAudioCapture(); return true; });
handle('audio:set-output', async (_e, id) => {
  if (process.platform !== 'win32' || typeof id !== 'string' || !id) throw new Error('Не удалось выбрать устройство вывода Windows');
  const encodedId = Buffer.from(id, 'utf8').toString('base64');
  await runAudioScript('set', encodedId);
  return true;
});
function apiRequest(settings) {
  if (!settings.endpoint?.trim()) throw new Error('Не указан адрес API. Укажите базовый URL в настройках.');
  if (!settings.model?.trim()) throw new Error('Не указана модель API. Укажите её в настройках.');
  const endpoint = new URL(settings.endpoint);
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('Адрес API должен начинаться с http:// или https://');
  const host = endpoint.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const ipv4 = host.split('.').map(Number);
  const localHost = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1' || host === '0.0.0.0'
    || ipv4.length === 4 && ipv4.every(part => Number.isInteger(part) && part >= 0 && part <= 255) && (ipv4[0] === 10 || ipv4[0] === 127 || ipv4[0] === 192 && ipv4[1] === 168 || ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31 || ipv4[0] === 169 && ipv4[1] === 254);
  if (endpoint.protocol === 'http:' && !localHost) throw new Error('Для удалённого API используйте HTTPS: ключ иначе может передаваться открытым текстом. HTTP разрешён только для локальных адресов.');
  const base = endpoint.href.replace(/\/+$/, '');
  const isYandex = endpoint.hostname.toLowerCase() === 'ai.api.cloud.yandex.net';
  if (isYandex && (!/^gpt:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+$/i.test(settings.model.trim()) || /[<>]/.test(settings.model))) throw new Error('Для Yandex AI Studio модель задаётся как gpt://<folder_ID>/<model_ID>/latest. Замените folder_ID реальным ID каталога, например gpt://b1g.../yandexgpt/latest.');
  const key = settings.apiKey?.replace(/^(?:Bearer|Api-Key)\s+/i, '');
  if (isYandex) {
    const basePath = endpoint.pathname.replace(/\/+$/, '');
    const pathname = basePath.replace(/\/responses$/i, '/chat/completions');
    const url = /\/chat\/completions$/i.test(pathname) ? endpoint.href.replace(endpoint.pathname, pathname) : `${endpoint.origin}${pathname.replace(/\/+$/, '')}/chat/completions`;
    const folderId = settings.model.trim().match(/^gpt:\/\/([^/]+)\//i)?.[1];
    return { provider: 'yandex', url, headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Api-Key ${key}` } : {}), ...(folderId ? { 'OpenAI-Project': folderId } : {}) } };
  }
  const isGemini = /generativelanguage\.googleapis\.com$/i.test(endpoint.hostname);
  if (isGemini) {
    const model = encodeURIComponent(settings.model.replace(/^models\//, ''));
    const pathName = /\/models\/[^/]+:generateContent$/i.test(endpoint.pathname) ? endpoint.pathname.replace(/\/models\/[^/]+:generateContent$/i, `/models/${model}:generateContent`) : `${endpoint.pathname.replace(/\/+$/, '')}/models/${model}:generateContent`;
    endpoint.pathname = pathName;
    return { provider: 'gemini', url: endpoint.href, headers: { 'Content-Type': 'application/json', ...(settings.apiKey ? { 'x-goog-api-key': settings.apiKey } : {}) } };
  }
  const responses = /\/responses$/i.test(base);
  const url = /\/(chat\/completions|responses)$/i.test(base) ? base : `${base}/chat/completions`;
  return { provider: responses ? 'responses' : 'openai', url, headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `${isYandex ? 'Api-Key' : 'Bearer'} ${key}` } : {}) } };
}
async function callApi(settings, body, signal, onDelta) {
  if (!settings.model?.trim()) throw new Error('Не указана модель API. Укажите её в настройках.');
  if (!settings.endpoint?.trim()) throw new Error('Не указан адрес API. Укажите базовый URL в настройках.');
  const api = apiRequest(settings);
  const url = new URL(api.url);
  let res, raw, payload, connectionRetried = false, transientRetried = false, compatibilityRetries = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      // Model latency depends on the selected provider/model and prompt size. Do not
      // abort a valid generation on a fixed timer; the user can still press Stop.
      res = await fetch(url, { method: 'POST', signal, headers: api.headers, body: JSON.stringify(body) });
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      if (error.name === 'AbortError') throw error;
      const cause = error.cause || error;
      const code = cause.code || cause.errors?.[0]?.code;
      if (!connectionRetried && ['EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
        connectionRetried = true;
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }
      const detail = [code, cause.message || error.message].filter(Boolean).join(': ');
      throw new Error(`Не удалось подключиться к ${url.hostname}${detail ? ` (${detail})` : ''}. Проверьте адрес API, интернет-соединение, DNS, прокси и TLS.`);
    }
    if (res.ok && res.headers.get('content-type')?.includes('text/event-stream')) {
      const reader = res.body.getReader(), decoder = new TextDecoder(); let buffer = '', streamedText = '', pendingText = '', visibleStarted = false, truncated = false;
      const emit = chunk => {
        if (!chunk || chunk === '[DONE]') return;
        let event; try { event = JSON.parse(chunk); } catch { return; }
        if (event.choices?.some(choice => ['length', 'max_tokens'].includes(choice.finish_reason)) || event.type === 'response.incomplete' || event.response?.status === 'incomplete' || event.response?.incomplete_details?.reason === 'max_output_tokens') truncated = true;
        const content = event.choices?.[0]?.delta?.content;
        const delta = api.provider === 'responses' ? (event.type === 'response.output_text.delta' ? event.delta : '') : (typeof content === 'string' ? content : Array.isArray(content) ? content.map(item => item?.text || '').join('') : '');
        if (delta) {
          streamedText += delta;
          if (!visibleStarted) {
            pendingText += delta;
            const prefix = pendingText.trimStart(), marker = '[DATA_INSUFFICIENT]';
            if (marker.startsWith(prefix) || prefix.startsWith(marker)) return;
            visibleStarted = true; onDelta?.(pendingText); pendingText = '';
          } else onDelta?.(delta);
        }
      };
      while (true) {
        const { value, done } = await reader.read(); buffer += decoder.decode(value || new Uint8Array(), { stream: !done }).replace(/\r/g, '');
        const events = buffer.split('\n\n'); buffer = events.pop() || '';
        for (const event of events) for (const line of event.split('\n')) if (line.startsWith('data:')) emit(line.slice(5).trim());
        if (done) break;
      }
      for (const line of buffer.split('\n')) if (line.startsWith('data:')) emit(line.slice(5).trim());
      return { provider: api.provider, payload: {}, streamedText, truncated };
    }
    raw = await res.text();
    try { payload = JSON.parse(raw); } catch { payload = {}; }
    if (res.ok) break;
    const message = payload.error?.message || payload.message || raw;
    if (compatibilityRetries < 3 && ['openai', 'responses'].includes(api.provider) && res.status === 400) {
      const compatibleBody = { ...body };
      if ('max_tokens' in compatibleBody && /max_tokens/i.test(String(message))) { compatibleBody.max_completion_tokens = compatibleBody.max_tokens; delete compatibleBody.max_tokens; }
      if ('temperature' in compatibleBody && /temperature/i.test(String(message))) delete compatibleBody.temperature;
      if ('reasoning_effort' in compatibleBody && /reasoning[_ ]effort|reasoning effort/i.test(String(message))) delete compatibleBody.reasoning_effort;
      if ('reasoning' in compatibleBody && /reasoning/i.test(String(message))) delete compatibleBody.reasoning;
      if ('stream' in compatibleBody && /stream/i.test(String(message))) delete compatibleBody.stream;
      if (JSON.stringify(compatibleBody) !== JSON.stringify(body)) { body = compatibleBody; compatibilityRetries++; continue; }
    }
    const failureReason = String(payload.error?.message || payload.message || raw.slice(0, 400));
    const quotaFailure = /(?:insufficient[_ ]quota|quota.{0,30}(?:exceed|limit)|(?:exceed|limit).{0,30}quota|billing|balance|credit|payment required)/i.test(failureReason);
    if (!transientRetried && [429, 500, 502, 503, 504].includes(res.status) && !(res.status === 429 && quotaFailure)) {
      transientRetried = true;
      await new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason || new Error('Остановлено'));
        const onAbort = () => { clearTimeout(timer); reject(signal.reason || new Error('Остановлено')); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, 1500);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      continue;
    }
    break;
  }
  if (!res.ok) {
    const reason = String(payload.error?.message || payload.message || raw.slice(0, 400).replace(/\s+/g, ' ') || `HTTP ${res.status}`);
    const wait = reason.match(/retry\s+in\s+([\d.]+)\s*s/i)?.[1];
    const host = new URL(settings.endpoint).hostname.toLowerCase();
    const yandex = host === 'ai.api.cloud.yandex.net', gemini = host === 'generativelanguage.googleapis.com';
    const advice = res.status === 404 ? (yandex ? ' Проверьте путь API и URI модели Yandex.' : gemini ? ' Проверьте точный model ID, доступность модели для вашего ключа и поддержку generateContent.' : ' Проверьте адрес API, путь метода и идентификатор модели.') : res.status === 401 || res.status === 403 ? (yandex ? ' Нужны роли ai.models.user или ai.languageModels.user и область ключа yc.ai.languageModels.execute.' : ' Проверьте API-ключ и права доступа.') : res.status === 429 ? (/high demand|demand peaks/i.test(reason) ? ' У модели временная высокая нагрузка; повторите попытку позже.' : ` Квота API исчерпана.${wait ? ` Повторите запрос примерно через ${wait} с.` : ''} Проверьте лимиты и оплату у провайдера; приложение не может увеличить квоту.`) : '';
    if (/audio input is not supported|provide the mmproj/i.test(reason)) throw new Error('Эта модель чата не принимает аудио. В настройках → Голос выберите Yandex SpeechKit либо подключите аудиомодель.');
    throw new Error(`HTTP ${res.status}: ${reason}${advice}`);
  }
  const truncated = payload.choices?.some(choice => ['length', 'max_tokens'].includes(choice.finish_reason)) || payload.status === 'incomplete' || payload.incomplete_details?.reason === 'max_output_tokens';
  return { provider: api.provider, payload, truncated: !!truncated };
}
const activeChats = new Map();
ipcMain.on('ai:cancel', (event, id) => { if (trustedSender(event) && typeof id === 'string' && id.length <= 80) activeChats.get(id)?.abort(); });
handle('ai:chat', async (event, { settings, messages, requestId }) => {
  if (!Array.isArray(messages) || !messages.length || messages.length > 20 || messages.some(m => !m || !['system','developer','user','assistant'].includes(m.role) || typeof m.content !== 'string' || m.content.length > 200_000)) throw new Error('Некорректный запрос чата');
  const controller = new AbortController(); if (requestId) activeChats.set(requestId, controller);
  try {
  const api = apiRequest(settings);
  const maxTokens = settings.verbosity === 'Полный ответ' ? 1800 : 700;
  // Keep reasoning lightweight and consistent; this is not a user-facing mode.
  const reasoningEffort = 'low';
  const modelName = String(settings.model).trim();
  const reasoningModel = /^(?:o[1-9](?:[-_.]|$)|gpt-(?:5|6)(?:[-.]|$))/i.test(modelName);
  const temperature = reasoningModel ? {} : { temperature: 0.2 };
  const reasoning = reasoningModel ? { reasoning: { effort: reasoningEffort } } : {};
  const chatReasoning = reasoningModel && api.provider === 'openai' ? { reasoning_effort: reasoningEffort } : {};
  const stream = api.provider === 'openai' || api.provider === 'responses';
  const body = api.provider === 'gemini' ? {
    ...(messages.some(m => m.role === 'system') ? { systemInstruction: { parts: messages.filter(m => m.role === 'system').map(m => ({ text: m.content })) } } : {}),
    contents: messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens }
  } : api.provider === 'responses' ? { model: settings.model, input: messages.map(m => ({ role: m.role === 'system' ? 'developer' : m.role, content: m.content })), max_output_tokens: maxTokens, ...(stream ? { stream: true } : {}), ...reasoning } : { model: settings.model, messages, ...temperature, max_tokens: maxTokens, ...(stream ? { stream: true } : {}), ...chatReasoning };
  const { provider, payload, streamedText, truncated } = await callApi(settings, body, controller.signal, delta => { if (trustedSender(event) && requestId) event.sender.send('ai:delta', { requestId, delta }); });
  const answer = streamedText || (provider === 'gemini' ? (Array.isArray(payload.candidates?.[0]?.content?.parts) ? payload.candidates[0].content.parts : []).map(p => typeof p?.text === 'string' ? p.text : '').join('') : provider === 'responses' ? (typeof payload.output_text === 'string' ? payload.output_text : Array.isArray(payload.output) ? payload.output.flatMap(x => Array.isArray(x?.content) ? x.content : []).map(x => typeof x?.text === 'string' ? x.text : '').join('') : '') : payload.choices?.[0]?.message?.content);
  if (typeof answer !== 'string' || !answer.trim()) throw new Error(payload.promptFeedback?.blockReason ? `Запрос заблокирован: ${payload.promptFeedback.blockReason}` : 'API вернул пустой ответ');
  const cutOff = truncated || (provider === 'gemini' && payload.candidates?.some(candidate => candidate.finishReason === 'MAX_TOKENS'));
  return answer.trim() + (cutOff ? '\n\n⚠ Ответ мог быть обрезан лимитом модели. Проверьте, хватает ли продолжения.' : '');
  } finally { if (requestId && activeChats.get(requestId) === controller) activeChats.delete(requestId); }
});
handle('ai:transcribe', async (_e, { settings, audio, mimeType }) => {
  if (!audio || audio.length > 24_000_000) throw new Error('Аудиозапись пустая или слишком длинная');
  if (settings.sttProvider === 'googleCloud') {
    const wav = Buffer.from(audio, 'base64'), credentialsPath = settings.googleSpeechCredentialsPath;
    if (!credentialsPath) throw new Error('Выберите JSON-ключ сервисного аккаунта в настройках голоса. В Google Cloud должны быть включены Speech-to-Text API и биллинг.');
    if (wav.length <= 44 || wav.length > 2_000_000 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Google Cloud Speech принимает WAV-фрагменты до 2 МБ и длительностью до минуты.');
    if (!googleSpeechClient || googleSpeechCredentialsPath !== credentialsPath) {
      googleSpeechClient?.close().catch(() => {});
      let SpeechClient;
      try { ({ SpeechClient } = require('@google-cloud/speech').v1); }
      catch (error) { throw new Error(`Пакет Google Cloud Speech недоступен в этой сборке: ${error.message || error}. Переустановите зависимости и соберите приложение заново.`); }
      googleSpeechClient = new SpeechClient({ keyFilename: credentialsPath }); googleSpeechCredentialsPath = credentialsPath;
    }
    try {
      const [result] = await googleSpeechClient.recognize({ config: { encoding: 'LINEAR16', sampleRateHertz: 16000, languageCode: settings.voiceLanguage || 'ru-RU', enableAutomaticPunctuation: true }, audio: { content: wav.subarray(44).toString('base64') } }, { timeout: 30000 });
      return (result.results || []).map(item => item.alternatives?.[0]?.transcript || '').join(' ').trim();
    } catch (error) {
      const code = error.code === 7 || error.code === 403 ? ' Проверьте разрешение сервисного аккаунта, включённый Speech-to-Text API и биллинг.' : error.code === 16 || error.code === 401 ? ' Проверьте JSON-ключ сервисного аккаунта.' : '';
      throw new Error(`Google Cloud Speech-to-Text: ${error.message || error}${code}`);
    }
  }
  if (settings.sttProvider === 'windows') {
    if (!(settings.voiceLanguage || 'ru-RU').startsWith('en-')) throw new Error('Встроенное офлайн-распознавание Windows доступно только для английского. Выберите English в языке распознавания либо используйте API.');
    const wav = Buffer.from(audio, 'base64');
    if (wav.length <= 44 || wav.length > 1_000_000 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Для офлайн-распознавания нужен WAV до 1 МБ.');
    const file = path.join(app.getPath('temp'), `assist-stt-${require('node:crypto').randomUUID()}.wav`);
    try {
      fs.writeFileSync(file, wav, { flag: 'wx' });
      const { stdout } = await runAudioScript('transcribe', Buffer.from(file).toString('base64'));
      return JSON.parse(stdout || '{}').text?.trim() || '';
    } finally { fs.rmSync(file, { force: true }); }
  }
  let endpointHost = '';
  try { endpointHost = new URL(settings.endpoint).hostname.toLowerCase(); } catch {}
  const useSpeechKit = settings.sttProvider === 'yandex' || settings.sttProvider !== 'chat' && endpointHost === 'ai.api.cloud.yandex.net';
  const api = useSpeechKit ? null : apiRequest(settings);
  if (useSpeechKit) {
    const wav = Buffer.from(audio, 'base64');
    if (wav.length <= 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Yandex SpeechKit получил пустой или некорректный WAV-фрагмент.');
    if (wav.length > 1_000_000) throw new Error('Yandex SpeechKit принимает синхронные WAV-фрагменты до 1 МБ. Уменьшите длину фрагмента.');
    const rawKey = settings.sttApiKey?.trim();
    if (!rawKey?.trim()) throw new Error('Для Yandex SpeechKit укажите ключ распознавания в настройках голоса.');
    const url = new URL('https://stt.api.cloud.yandex.net/speech/v1/stt:recognize');
    url.search = new URLSearchParams({ topic: 'general', lang: settings.voiceLanguage || 'ru-RU', format: 'lpcm', sampleRateHertz: '16000' }).toString();
    const key = rawKey.replace(/^(?:Bearer|Api-Key)\s+/i, '');
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(30000), headers: { Authorization: `Api-Key ${key}`, 'Content-Type': 'application/octet-stream' }, body: wav.subarray(44) });
      } catch (error) {
        throw new Error(`Не удалось подключиться к Yandex SpeechKit: ${error.cause?.message || error.message}. Проверьте сеть и ключ.`);
      }
      if (![500, 502, 503, 504].includes(response.status) || attempt === 1) break;
      await new Promise(resolve => setTimeout(resolve, 700));
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Yandex SpeechKit HTTP ${response.status}${result.error_message || result.message ? `: ${result.error_message || result.message}` : ''}${[500, 502, 503, 504].includes(response.status) ? ' Сервис вернул временную серверную ошибку; выполнена одна повторная попытка. Попробуйте снова чуть позже.' : ''}${response.status === 401 || response.status === 403 ? ' Проверьте, что используется API-ключ именно этого сервисного аккаунта, а роль ai.speechkit-stt.user назначена ему в его каталоге; ключу нужна область yc.ai.speechkitStt.execute.' : ''}`);
    return result.result?.trim() || '';
  }
  const body = api.provider === 'gemini' ? {
    contents: [{ role: 'user', parts: [
      { text: `Дословно распознай всю разборчивую речь в коротком фрагменте на языке ${settings.voiceLanguage || 'ru-RU'}. Верни только распознанные слова, сохраняя числа, ранги, сроки, суммы, команды и сокращения; не решай, является ли фраза вопросом. Не отвечай, не добавляй нумерацию и пояснения. Если разборчивой речи нет, верни пустую строку.` },
      { inline_data: { mime_type: mimeType || 'audio/wav', data: audio } }
    ] }],
    generationConfig: { temperature: 0, maxOutputTokens: 128 }
  } : api.provider === 'openai' ? { model: settings.model, messages: [{ role: 'user', content: [{ type: 'text', text: 'Дословно распознай всю разборчивую речь. Верни только распознанные слова, сохраняя числа, ранги, сроки, суммы, команды и сокращения. Не решай, является ли фраза вопросом; не отвечай и не добавляй нумерацию или пояснения. Если разборчивой речи нет, верни пустую строку.' }, { type: 'input_audio', input_audio: { data: audio, format: 'wav' } }] }], temperature: 0 } : null;
  if (!body) throw new Error('Эта модель чата не поддерживает голосовой ввод. Выберите Yandex SpeechKit в настройках голоса или подключите аудиомодель.');
  const { provider, payload } = await callApi(settings, body);
  return (provider === 'gemini' ? payload.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') : payload.choices?.[0]?.message?.content)?.trim() || '';
});
handle('web:search', async (_e, { query, requestId }) => {
  if (typeof query !== 'string' || !query.trim() || query.length > 500) throw new Error('Введите поисковый запрос длиной до 500 символов.');
  const url = new URL('https://html.duckduckgo.com/html/'); url.searchParams.set('q', query);
  const controller = new AbortController(); if (requestId) activeChats.set(requestId, controller);
  let res;
  try { res = await fetch(url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]), headers: { 'User-Agent': 'Mozilla/5.0 AssistOverlay/1.0' } }); }
  finally { if (requestId && activeChats.get(requestId) === controller) activeChats.delete(requestId); }
  if (!res.ok) throw new Error(`Веб-поиск вернул HTTP ${res.status}`);
  const html = await res.text();
  const anchors = [...html.matchAll(/<a\b[^>]*class=["'][^"']*\bresult__a\b[^"']*["'][^>]*>[\s\S]*?<\/a>/gi)];
  if (!anchors.length && /captcha|robot check|unusual traffic/i.test(html)) throw new Error('Поиск ограничен страницей проверки DuckDuckGo. Повторите позже или используйте поисковую систему вручную.');
  return anchors.slice(0, 6).map((match, index) => {
    const href = match[0].match(/\bhref=["']([^"']+)["']/i)?.[1];
    const end = anchors[index + 1]?.index ?? html.length;
    const block = html.slice(match.index + match[0].length, end);
    const snippetMatch = block.match(/<(a|div|span)\b[^>]*class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i);
    let link = (href || '').replace(/&amp;/gi, '&');
    try { const u = new URL(link, 'https://duckduckgo.com'); link = u.searchParams.get('uddg') || u.href; } catch { return null; }
    return { title: stripHtml(match[0]), url: link, snippet: stripHtml(snippetMatch?.[2] || '') };
  }).filter(r => r?.title && /^https?:/.test(r.url));
});
app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  app.setName('Assist');
  app.setAppUserModelId('com.assistoverlay.app');
  Menu.setApplicationMenu(null);
  const ownsAudioRequest = (contents, permission) => contents === win?.webContents && permission === 'media';
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details = {}) => callback(ownsAudioRequest(contents, permission) && (!details.mediaTypes?.length || details.mediaTypes.includes('audio'))));
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details = {}) => ownsAudioRequest(contents, permission) && (!details.mediaType || details.mediaType === 'audio'));
  startupData = readData();
  const settings = startupData.settings;
  const width = Math.min(3840, Math.max(600, Math.round(Number(settings.windowWidth) || defaults.settings.windowWidth)));
  const height = Math.min(2160, Math.max(500, Math.round(Number(settings.windowHeight) || defaults.settings.windowHeight)));
  win = new BrowserWindow({ width, height, resizable: false, maximizable: false, show: false, focusable: false, type: process.platform === 'win32' ? 'toolbar' : undefined, frame: false, transparent: true, icon: path.join(__dirname, 'assist-icon.ico'), opacity: Math.max(0.4, Math.min(1, Number(settings.opacity ?? 90) / 100)), alwaysOnTop: true, skipTaskbar: true, backgroundColor: '#00000000', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false, backgroundThrottling: false } });
  win.setSkipTaskbar(true);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.on('show', () => {
    if (!win || win.isDestroyed()) return;
    win.setAlwaysOnTop(true, 'screen-saver'); win.setSkipTaskbar(true);
    win.setIgnoreMouseEvents(cursorHidden, { forward: true });
    scheduleOverlayWindowState();
  });
  win.on('restore', () => {
    if (!win || win.isDestroyed()) return;
    win.setFocusable(false); win.setAlwaysOnTop(true, 'screen-saver'); win.setSkipTaskbar(true);
    win.moveTop(); win.setIgnoreMouseEvents(cursorHidden, { forward: true });
    scheduleOverlayWindowState();
  });
  win.on('minimize', () => win?.setFocusable(false));
  win.on('focus', () => { win?.setAlwaysOnTop(true, 'screen-saver'); win?.moveTop(); win?.setSkipTaskbar(true); });
  win.webContents.on('did-finish-load', () => win?.webContents.send('app:cursor-visibility', cursorHidden));
  win.webContents.on('preload-error', (_event, preloadPath, error) => console.error(`Preload failed (${preloadPath}):`, error));
  win.setContentProtection(!!settings.streamProof);
  win.setTitle('Assist');
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (url !== win.webContents.getURL()) event.preventDefault(); });
  win.webContents.on('context-menu', event => event.preventDefault());
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && ((input.control || input.meta) && ['r','p','s','u','j','i','+','-','0'].includes(input.key.toLowerCase()) || ['F5','F12'].includes(input.key))) event.preventDefault();
  });
  win.loadFile(path.join(__dirname, 'ui-test.html'));
  win.once('ready-to-show', () => { win.setFocusable(false); win.showInactive(); win.moveTop(); setOverlayInputPassthrough(false); });
  win.on('closed', () => { stopSystemAudioCapture(); win = null; });
  const { hotkey, cursorHotkey } = settings;
  if (!setHotkeys(hotkey || defaults.settings.hotkey, cursorHotkey || defaults.settings.cursorHotkey)) setHotkeys(defaults.settings.hotkey, defaults.settings.cursorHotkey);
}).catch(error => { console.error('Assist failed to initialize:', error); app.quit(); });
app.on('will-quit', () => { stopSystemAudioCapture(); if (mouseHookRunning) mouseHook?.stop(); googleSpeechClient?.close().catch(() => {}); });



const $ = id => document.getElementById(id);
const log = $('log'), input = $('input'), sendBtn = $('send');
window.assist?.onCursorVisibility(hidden => {
  document.documentElement.classList.toggle('cursor-hidden', hidden);
  document.documentElement.classList.toggle('mouse-disabled', hidden);
  document.documentElement.classList.toggle('mouse-enabled', !hidden);
  const key = settings?.cursorHotkey || 'F1', mode = $('f1ModeChip');
  if (mode) { mode.textContent = `${key}: ${hidden ? 'Игра' : 'Assist'}`; mode.title = hidden ? `Мышь проходит в окно под оверлеем. ${key} — включить управление Assist.` : `Мышь управляет Assist. ${key} — вернуть управление игре.`; }
});
const isCopyArea = element => [log, $('sourceList'), $('histList')].some(area => area?.contains(element));
const isCopyAllowed = node => isCopyArea(node?.nodeType === 1 ? node : node?.parentElement);
const isTextField = target => target instanceof HTMLElement && target.matches('input:not([type="range"]), textarea');
document.addEventListener('mousedown', event => { if (isTextField(event.target)) window.assist.activateTextInput(); }, true);
document.addEventListener('focusin', event => { if (isTextField(event.target)) void window.assist.setTextInputActive(true); });
document.addEventListener('focusout', event => {
  if (!isTextField(event.target)) return;
  setTimeout(() => { if (!isTextField(document.activeElement)) void window.assist.setTextInputActive(false); }, 0);
});
document.addEventListener('copy', event => { if (!isCopyAllowed(event.target) && !isCopyAllowed(getSelection()?.anchorNode)) event.preventDefault(); });
document.addEventListener('contextmenu', event => event.preventDefault());
let data, settings, topics = [], history, corrections = [], srcMode = 'text', selectedTopicId = '', listening = false, audioSession = null, activeRequest = null, apiState = 'unknown', transcriptionBusy = false, messagesBusy = false, transcriptionCooldownUntil = 0, pendingImport = null, persistedHotkeys = null, captureTimer;
const messageQueue = [], audioQueue = [], conversation = [];
const streamingBubbles = new Map();
window.assist?.onChatDelta?.(({ requestId, delta }) => {
  const state = streamingBubbles.get(requestId); if (!state) return;
  state.text += delta; state.node.replaceChildren(renderAnswer(state.text)); log.scrollTop = log.scrollHeight;
});
const openTopicIds = new Set();
const searchIndexCache = new WeakMap();
let retrievalCorpusCache = null;
function applyTheme(theme = 'purple') { document.documentElement.dataset.theme = theme; }
const isRu = s => /[а-яё]/i.test(s);
let russianStemmer;
try { russianStemmer = window.snowballFactory?.newStemmer('russian'); } catch (error) { console.warn('Russian stemmer unavailable:', error); }
const stemCache = new Map();
const stopWords = new Set(['как','что','где','кто','куда','когда','почему','зачем','сколько','какой','какая','какие','какое','чей','чья','чьё','чьи','ли','это','то','для','или','при','есть','его','она','они','я','мы','ты','вы','мне','моя','мой','тебе','вас','вам','твои','ваши','делать','действие','действия','действовать','поступить','будете','будет','буду','будут','представим','ситуация','случае','если','the','and','for','with','how','what','where','when','who','which','does','is','are','can','should','would','do','did','your','actions','to','in','on','of']);
const normalizeWord = w => {
  const value = String(w).toLocaleLowerCase().replace(/ё/g, 'е');
  if (!/[а-я]/i.test(value)) return value;
  if (stemCache.has(value)) return stemCache.get(value);
  let stem; try { stem = russianStemmer?.stem(value) || value; } catch { stem = value; }
  if (stemCache.size >= 100000) stemCache.clear();
  stemCache.set(value, stem); return stem;
};
const words = s => (s.toLocaleLowerCase().replace(/ё/g, 'е').match(/[a-zа-я0-9]{2,}|\d+/gi) || []).filter(w => !stopWords.has(w)).map(normalizeWord);
const score = (q, text, preparedTerms = null) => {
  const query = [...new Set(words(q))], corpus = preparedTerms || [...new Set(words(text))];
  return query.reduce((n, word) => n + Number(corpus.some(candidate => candidate === word || (Math.min(candidate.length, word.length) >= 5 && (candidate.startsWith(word) || word.startsWith(candidate))))), 0);
};
const smallTalk = q => /^(?:ау|алло|привет|здравствуй|добрый (?:день|вечер|утро)|(?:ai|ии|ассистент)[,! ]*(?:ты )?(?:тут|здесь)|ты тут|ты здесь|как дела|будешь (?:со мной )?дружить|кто ты|какая ты (?:ии|нейросеть)|hi|hello|hey|are you (?:there|listening|online)|can you hear me|who are you)[?!., ]*$/i.test(q.trim());
function appendInline(parent, text) {
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|`[^`]+`|(?<![\p{L}\p{N}_*])\*[^*\n]+\*(?![\p{L}\p{N}_*])|(?<![\p{L}\p{N}_])_[^_\n]+_(?![\p{L}\p{N}_]))/gu;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(last, match.index)));
    const token = match[0], node = document.createElement(token.startsWith('`') ? 'code' : token.startsWith('~~') ? 'del' : token.startsWith('**') || token.startsWith('__') ? 'strong' : 'em');
    const padding = token.startsWith('**') || token.startsWith('__') || token.startsWith('~~') ? 2 : 1;
    node.textContent = token.slice(padding, -padding);
    parent.append(node); last = match.index + token.length;
  }
  parent.append(document.createTextNode(text.slice(last)));
}
function renderAnswer(text) {
  const root = document.createElement('div'); root.className = 'answer-content';
  const lines = text.replace(/\r/g, '').split('\n'); let paragraph = [], list = null, code = null;
  const flushParagraph = () => { if (!paragraph.length) return; const p = document.createElement('p'); paragraph.forEach((line, i) => { if (i) p.append(document.createElement('br')); appendInline(p, line); }); root.append(p); paragraph = []; };
  const closeList = () => { list = null; };
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      flushParagraph(); closeList();
      if (code) { root.append(code); code = null; } else code = document.createElement('pre');
      continue;
    }
    if (code) { code.textContent += `${line}\n`; continue; }
    const heading = line.match(/^\s{0,3}(#{1,4})\s+(.+?)\s*#*\s*$/);
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/), numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (heading) { flushParagraph(); closeList(); const h = document.createElement(`h${Math.min(4, heading[1].length + 1)}`); appendInline(h, heading[2]); root.append(h); }
    else if (bullet || numbered) { flushParagraph(); const tag = numbered ? 'ol' : 'ul'; if (!list || list.tagName.toLowerCase() !== tag) { closeList(); list = document.createElement(tag); root.append(list); } const item = document.createElement('li'); appendInline(item, (bullet || numbered)[1]); list.append(item); }
    else if (/^\s*>\s?/.test(line)) { flushParagraph(); closeList(); const quote = document.createElement('blockquote'); appendInline(quote, line.replace(/^\s*>\s?/, '')); root.append(quote); }
    else if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) { flushParagraph(); closeList(); root.append(document.createElement('hr')); }
    else if (!line.trim()) { flushParagraph(); }
    else { closeList(); paragraph.push(line); }
  }
  flushParagraph(); if (code) root.append(code);
  return root;
}
function fillMsg(d, type, text, source, debug) {
  d.className = `msg ${type}`; d.replaceChildren(type === 'bot' && text !== '…' ? renderAnswer(text) : document.createTextNode(text));
  if (source) { const tag = document.createElement('div'); tag.className = 'src-tag'; tag.textContent = source; d.append(tag); }
  if (type === 'bot' && debug) {
    const details = document.createElement('details'); details.className = 'retrieval-debug';
    const summary = document.createElement('summary'); summary.textContent = `Поиск ${debug.searchMs} мс${debug.retryMs ? ` · повторный поиск ${debug.retryMs} мс` : ''} · модель ${debug.modelMs} мс${debug.retryModelMs ? ` + повтор ${debug.retryModelMs} мс` : ''} · вызовов: ${debug.modelCalls} · фрагментов: ${debug.hits.length}${debug.diagnosis ? ` · причина: ${debug.diagnosis}` : ''}`; details.append(summary);
    for (const [index, hit] of debug.hits.entries()) { const row = document.createElement('div'); row.className = 'retrieval-debug-hit'; row.textContent = `${index + 1}. ${hit.topic} / ${hit.title} · релевантность ${hit.rank} · покрытие ${hit.coverage}\n${hit.preview}`; details.append(row); }
    d.append(details);
  }
  if (type === 'bot' && text !== '…') { const copy = document.createElement('button'); copy.className = 'copy-btn'; copy.textContent = 'Копировать'; copy.onclick = async () => { await window.assist.copy(text); copy.textContent = 'Скопировано'; setTimeout(() => copy.textContent = 'Копировать', 1200); }; d.append(copy); }
  return d;
}
function addMsg(type, text, source) {
  const d = fillMsg(document.createElement('div'), type, text, source);
  log.appendChild(d); log.scrollTop = log.scrollHeight; return d;
}
function persistTopicsError(err) { sourceStatus(`Не удалось сохранить проект: ${err.message || err}`, true); }
const searchSynonyms = [
  ['запрет', 'запрещ', 'нельзя', 'недопустим', 'ограничен'],
  ['разреш', 'можно', 'допуска', 'право'],
  ['правил', 'регламент', 'устав', 'норм', 'положен'],
  ['наказан', 'штраф', 'взыскан', 'санкци'],
  ['руководител', 'начальник', 'лидер', 'глава', 'старш'],
  ['перевест', 'перевод', 'перейти', 'переход'],
  ['процедур', 'порядок', 'порядк'],
];
function searchTerms(query) {
  const terms = new Map(words(query).map(term => [term, 1]));
  for (const group of searchSynonyms) {
    const normalized = group.map(term => normalizeWord(term.toLowerCase()));
    const related = normalized.some(alias => [...terms.keys()].some(term => term === alias || (Math.min(term.length, alias.length) >= 5 && (term.startsWith(alias) || alias.startsWith(term)))));
    if (related)
      for (const alias of normalized) if (!terms.has(alias)) terms.set(alias, 0.65);
  }
  return terms;
}
function makeVector(text, weights = null) {
  const counts = weights ? new Map(weights) : new Map();
  if (!weights) for (const term of words(text)) counts.set(term, (counts.get(term) || 0) + 1);
  const norm = Math.sqrt([...counts.values()].reduce((sum, value) => sum + value * value, 0));
  return { counts, norm };
}
function cosineSimilarity(a, b) {
  if (!a.norm || !b.norm) return 0;
  let dot = 0;
  for (const [term, value] of a.counts) dot += value * (b.counts.get(term) || 0);
  return dot / (a.norm * b.norm);
}
function splitSearchChunks(text) {
  const chunks = [], lines = text.replace(/\r/g, '').split('\n'); let section = 'Основной текст', current = '';
  const flush = () => { if (current.trim()) chunks.push({ section, text: current.trim() }); current = ''; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim(); if (!line) { if (current.length > 700) flush(); else if (current && !current.endsWith('\n')) current += '\n'; continue; }
    const isolatedHeading = i > 0 && i < lines.length - 1 && line.length <= 80 && line.split(/\s+/).length <= 9 && !/[.!?]$/.test(line) && !lines[i - 1].trim() && !lines[i + 1].trim();
    const markdownHeading = line.match(/^#{1,6}\s+(.+)$/), capsHeading = /^[А-ЯЁA-Z][А-ЯЁA-Z\s/-]{2,79}\.?$/.test(line) && /[А-ЯЁA-Z]{3}/.test(line);
    const heading = markdownHeading?.[1] || (/^[А-ЯЁA-Z][^.!?]{2,90}:$/.test(line) || capsHeading || isolatedHeading ? line.replace(/:$/, '') : '');
    if (heading) { flush(); section = heading.slice(0, 120); current = markdownHeading ? markdownHeading[1] : line; continue; }
    if (current && current.length + line.length > 1200) flush();
    if (line.length > 1200) {
      let remaining = line;
      while (remaining.length > 1200) {
        let cut = remaining.lastIndexOf(' ', 1200); if (cut < 1) cut = 1200;
        const part = remaining.slice(0, cut); if (current && current.length + part.length > 1200) flush(); current += `${current ? ' ' : ''}${part}`; flush(); remaining = remaining.slice(cut).trimStart();
      }
      if (remaining) { if (current && current.length + remaining.length > 1200) flush(); current += `${current ? ' ' : ''}${remaining}`; }
    } else current += `${current ? '\n' : ''}${line}`;
  }
  flush();
  return chunks.length ? chunks : text.trim() ? [{ section, text: text.trim().slice(0, 1200) }] : [];
}
function indexedChunks(topic, source) {
  const original = source._source || source, content = sourceText(original), cached = searchIndexCache.get(original);
  if (cached?.content === content && cached.title === original.title && cached.topic === topic.name) return cached.chunks;
  const chunks = splitSearchChunks(content).map((chunk, index) => ({ ...chunk, index, historical: /(?:отмен[её]н\p{L}*|утратил\p{L}*\s+силу|исключ[её]н\p{L}*\s+из\s+(?:правил|регламент\p{L}*)|признан\p{L}*\s+недействующ\p{L}*|не\s+действует)/iu.test(chunk.text), tokenTerms: [...new Set(words(`${source.title || ''} ${topic.name} ${chunk.section} ${chunk.text}`))], vector: makeVector(chunk.text) }));
  searchIndexCache.set(original, { content, title: original.title, topic: topic.name, chunks });
  return chunks;
}
function searchPreview(text, query) {
  const sentences = text.match(/[^.!?…\n]+[.!?…]?/g)?.map(sentence => sentence.trim()).filter(Boolean) || [text];
  const vector = makeVector('', searchTerms(query));
  const best = sentences.reduce((found, sentence, index) => { const relevance = score(query, sentence) * 2 + cosineSimilarity(vector, makeVector(sentence)) * 10; return relevance > found.score ? { index, score: relevance } : found; }, { index: 0, score: -1 }).index;
  return sentences.slice(Math.max(0, best - 1), Math.min(sentences.length, best + 2)).join(' ');
}
function appendSearchHighlight(element, text, terms) {
  terms = [...new Set((Array.isArray(terms) ? terms : [...searchTerms(terms).keys()]).filter(term => term.length > 2))];
  if (!terms.length) { element.textContent = text; return; }
  const pattern = new RegExp(`(${terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'giu');
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    element.append(document.createTextNode(text.slice(last, match.index)));
    const strong = document.createElement('strong'); strong.className = 'search-result-hit'; strong.textContent = match[0]; element.append(strong);
    last = match.index + match[0].length;
  }
  element.append(document.createTextNode(text.slice(last)));
}
function renderSearchResults(query = $('sourceSearch').value) {
  const panel = $('sourceSearchResults'); panel.replaceChildren(); query = query.trim();
  if (!query) { panel.hidden = true; return; }
  const queryVector = makeVector('', searchTerms(query)), hits = [];
  for (const topic of topics.filter(item => item.enabled)) for (const source of topic.sources.filter(item => !item.archived)) {
    for (const chunk of indexedChunks(topic, source)) {
      const keywordScore = score(query, '', chunk.tokenTerms);
      const semanticScore = cosineSimilarity(queryVector, chunk.vector);
      if (!keywordScore && semanticScore < 0.08) continue;
      const titleBoost = score(query, source.title || '') + score(query, topic.name) * 0.5;
      hits.push({ topic: topic.name, source: source.title || 'Источник', sourceObject: source, section: chunk.section, text: chunk.text, index: chunk.index, keywordScore, semanticScore, rank: keywordScore * 2 + semanticScore * 10 + titleBoost });
    }
  }
  hits.sort((a, b) => b.rank - a.rank);
  const unique = [];
  for (const hit of hits) {
    if (unique.some(item => item.sourceObject === hit.sourceObject && Math.abs(item.index - hit.index) <= 1)) continue;
    unique.push(hit); if (unique.length === 20) break;
  }
  const heading = document.createElement('div'); heading.className = 'search-results-head';
  heading.textContent = unique.length ? `Найдено фрагментов: ${unique.length} · поиск по включённым темам без обращения к ИИ` : 'Совпадений во включённых источниках не найдено.';
  panel.append(heading);
  if (unique.length) {
    const list = document.createElement('div'); list.className = 'search-results-list';
    const highlightTerms = [...searchTerms(query).keys()];
    for (const hit of unique) {
      const card = document.createElement('button'); card.type = 'button'; card.className = 'search-result-card';
      const meta = document.createElement('div'); meta.className = 'search-result-meta'; appendSearchHighlight(meta, `${hit.topic}  ›  ${hit.source}  ›  ${hit.section}`, highlightTerms);
      const body = document.createElement('div'); body.className = 'search-result-text'; appendSearchHighlight(body, searchPreview(hit.text, query), highlightTerms);
      card.append(meta, body); card.onclick = () => {
        document.querySelector('.tab-btn[data-tab="chat"]').click();
        const message = addMsg('bot', hit.text, `${hit.topic} / ${hit.source} / ${hit.section}`); message.classList.add('search-result-message');
        $('sourceSearch').value = ''; panel.replaceChildren(); panel.hidden = true; log.scrollTop = log.scrollHeight;
      };
      list.append(card);
    }
    panel.append(list);
  }
  panel.hidden = false;
}
function renderSources() {
  const count = topics.reduce((n, topic) => n + topic.sources.length, 0);
  $('srcCount').textContent = `${count} · ${topics.length} тем`;
  $('topicSummary').textContent = `Включено тем: ${topics.filter(topic => topic.enabled).length} из ${topics.length}. AI использует только их источники.`;
  const topicSelect = $('sourceTopic'), previous = selectedTopicId || topicSelect.value;
  topicSelect.replaceChildren(...topics.map(topic => new Option(`${topic.name} · ${topic.enabled ? 'включена' : 'выключена'}`, topic.id)));
  selectedTopicId = topics.some(topic => topic.id === previous) ? previous : topics.find(topic => topic.enabled)?.id || topics[0]?.id || '';
  topicSelect.value = selectedTopicId; topicSelect.disabled = !topics.length; $('addSource').disabled = !topics.length;
  const list = $('sourceList'); list.replaceChildren();
  if (!topics.length) { list.innerHTML = '<div class="empty">Сначала создайте тему проекта, затем добавьте в неё текст или HTML-файл.</div>'; renderExportTopics(); renderSearchResults(); return; }
  for (const topic of topics) {
    const matches = topic.sources.map(source => ({ source, excerpt: '' }));
    const card = document.createElement('section'); card.className = `topic-card${topic.enabled ? '' : ' inactive'}`;
    const heading = document.createElement('div'); heading.className = 'topic-heading';
    const status = document.createElement('label'); status.className = 'topic-enabled';
    const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = topic.enabled; toggle.setAttribute('aria-label', `Использовать тему ${topic.name} в ответах AI`);
    toggle.onchange = async () => {
      const old = topic.enabled; topic.enabled = toggle.checked; renderSources();
      try { await persist(); } catch (err) { topic.enabled = old; renderSources(); persistTopicsError(err); }
    };
    status.append(toggle, document.createTextNode(topic.enabled ? 'Вкл' : 'Выкл'));
    const name = document.createElement('input'); name.type = 'text'; name.className = 'topic-name'; name.value = topic.name; name.maxLength = 120; name.setAttribute('aria-label', 'Название темы');
    const saveName = document.createElement('button'); saveName.className = 'topic-action'; saveName.textContent = 'Сохранить имя';
    saveName.onclick = async () => {
      const next = name.value.trim();
      if (!next) { name.value = topic.name; return; }
      if (topics.some(other => other !== topic && other.name.toLocaleLowerCase() === next.toLocaleLowerCase())) { sourceStatus('Тема с таким названием уже есть.', true); return; }
      const old = topic.name; topic.name = next;
      try { await persist(); renderSources(); } catch (err) { topic.name = old; renderSources(); persistTopicsError(err); }
    };
    const deleteTopic = document.createElement('button'); deleteTopic.className = 'del'; deleteTopic.textContent = '✕'; deleteTopic.title = 'Удалить тему вместе со всеми источниками';
    deleteTopic.onclick = async () => {
      if (!confirm(`Удалить тему «${topic.name}» и все её источники (${topic.sources.length})?`)) return;
      const index = topics.indexOf(topic); topics.splice(index, 1); renderSources();
      try { await persist(); } catch (err) { topics.splice(index, 0, topic); renderSources(); persistTopicsError(err); }
    };
    heading.append(status, name, saveName, deleteTopic);
    const isOpen = openTopicIds.has(topic.id);
    const fold = document.createElement('button'); fold.className = 'topic-fold'; fold.textContent = `Источники (${topic.sources.length})　${isOpen ? '−' : '+'}`;
    const content = document.createElement('div'); content.className = 'topic-content'; content.hidden = !isOpen;
    fold.onclick = () => { if (openTopicIds.has(topic.id)) { openTopicIds.delete(topic.id); content.hidden = true; fold.textContent = `Источники (${topic.sources.length})　+`; } else { openTopicIds.add(topic.id); renderSources(); } };
    if (isOpen) for (const { source: s } of matches) {
      const row = document.createElement('div'); row.className = 'src-item';
      const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = s.type === 'html' ? 'HTML' : 'Текст';
      const body = document.createElement('div'); body.className = 'body';
      const title = document.createElement('div'); title.className = 'ttl'; title.textContent = s.title || '';
      const usage = document.createElement('div'); usage.className = 'source-usage'; usage.textContent = `Цитирован в ответах: ${Math.max(0, Number(s.answerUsageCount) || 0)}`;
      if (sourceIsArchived(s)) { row.classList.add('archived'); const archivedTag = document.createElement('span'); archivedTag.className = 'badge'; archivedTag.textContent = 'Архив'; body.append(archivedTag); }
      if (s.importWarnings?.length) { const warning = document.createElement('div'); warning.className = 'source-warning'; warning.textContent = `Проверьте полноту источника: ${s.importWarnings.join('; ')}`; body.append(warning); }
      const preview = document.createElement('div'); preview.className = 'prev';
      preview.textContent = s.content.length > 500 ? `${s.content.slice(0, 500)}…` : s.content;
      const editor = document.createElement('details'); editor.className = 'source-details';
      const summary = document.createElement('summary'); summary.textContent = 'Посмотреть / изменить';
      const titleInput = document.createElement('input'); titleInput.type = 'text'; titleInput.value = s.title || ''; titleInput.maxLength = 200; titleInput.setAttribute('aria-label', 'Название источника');
      const contentInput = document.createElement('textarea'); contentInput.value = s.content || ''; contentInput.rows = 8; contentInput.maxLength = 10000000; contentInput.setAttribute('aria-label', 'Содержимое источника');
      const priorityField = document.createElement('label'); priorityField.className = 'field'; priorityField.textContent = 'Приоритет при ответе ИИ';
      const priority = document.createElement('select'); priority.innerHTML = '<option value="0">Обычный</option><option value="1">Выше обычного</option><option value="2">Основной документ</option><option value="-1">Ниже обычного</option>'; priority.value = String(Math.max(-1, Math.min(2, Number(s.aiPriority) || 0)));
      priority.onchange = async () => { const old = s.aiPriority; s.aiPriority = Number(priority.value) || 0; try { await persist(); } catch (err) { s.aiPriority = old; priority.value = String(old || 0); persistTopicsError(err); } };
      priorityField.append(priority);
      const save = document.createElement('button'); save.className = 'primary-btn'; save.textContent = 'Сохранить изменения';
      save.onclick = async () => {
        const title = titleInput.value.trim(), text = contentInput.value.trim();
        if (!title || !text) { alert('Название и текст источника не должны быть пустыми.'); return; }
        if (text.length > 10000000) { alert('Текст источника больше 10 МБ. Разбейте его на несколько источников.'); return; }
        const existingCharacters = topics.reduce((total, item) => total + item.sources.reduce((sum, source) => sum + String(source?.content || '').length, 0), 0);
        if (existingCharacters - String(s.content || '').length + text.length > 45_000_000) { alert('Общий объём источников превысит 45 МБ. Уменьшите текст или удалите ненужные источники.'); return; }
        const old = { title: s.title, content: s.content, aiContent: s.aiContent, importWarnings: s.importWarnings, aiPriority: s.aiPriority };
        const cleaned = cleanKnowledgeText(text); s.title = title; s.content = cleaned.text; s.aiContent = '';
        s.aiPriority = Number(priority.value) || 0;
        s.importWarnings = [...new Set([...cleaned.warnings, ...missingReferenceWarnings(s, topics.flatMap(item => item.sources.map(source => source.title)))])]; indexedChunks(topic, s);
        try { await persist(); renderSources(); } catch (err) { Object.assign(s, old); indexedChunks(topic, s); alert(`Не удалось сохранить источник: ${err.message || err}`); }
      };
      editor.append(summary, titleInput, contentInput, priorityField, save); body.append(title, usage, preview, editor);
      const archive = document.createElement('button'); archive.className = 'topic-action'; archive.textContent = sourceIsArchived(s) ? 'Вернуть в активные' : 'В архив'; archive.title = sourceIsArchived(s) ? 'Вернуть источник в обычный поиск' : 'Исключить устаревшие нормы из обычного поиска';
      archive.onclick = async () => { const old = s.archived, previous = sourceIsArchived(s); s.archived = !previous; try { await persist(); renderSources(); } catch (err) { if (old === undefined) delete s.archived; else s.archived = old; persistTopicsError(err); } };
      const del = document.createElement('button'); del.className = 'del'; del.textContent = '✕'; del.title = 'Удалить источник';
      del.onclick = async () => { const index = topic.sources.indexOf(s); topic.sources.splice(index, 1); renderSources(); try { await persist(); } catch (err) { topic.sources.splice(index, 0, s); renderSources(); persistTopicsError(err); } };
      row.append(badge, body, archive, del); content.append(row);
    }
    if (!topic.sources.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'В этой теме пока нет источников.'; content.append(empty); }
    card.append(heading, fold, content); list.append(card);
  }
  renderExportTopics();
  renderSearchResults();
}
function renderExportTopics() {
  const select = $('exportTopic'); if (!select) return;
  const previous = select.value || selectedTopicId;
  select.replaceChildren(...topics.map(topic => new Option(`${topic.name}${topic.enabled ? '' : ' · выкл. источники не используются ИИ'}`, topic.id)));
  select.value = topics.some(topic => topic.id === previous) ? previous : topics[0]?.id || '';
  $('downloadExport').disabled = !topics.length;
}
function transferStatus(text, error = false) { $('transferStatus').textContent = text; $('transferStatus').classList.toggle('error', error); }
function transferView(view) {
  $('importView').hidden = view !== 'import'; $('exportView').hidden = view !== 'export';
  document.querySelectorAll('#transferModes button').forEach(button => button.classList.toggle('on', button.dataset.transferView === view));
  transferStatus('');
}
function openTransferPanel() {
  $('sourceEntryContent').hidden = true; $('sourceTransferPanel').hidden = false;
  renderExportTopics(); transferView('import');
}
function closeTransferPanel() { $('sourceTransferPanel').hidden = true; $('sourceEntryContent').hidden = false; }
function parseKnowledgeFile(value) {
  const raw = Array.isArray(value) ? value : value?.topics;
  if (!Array.isArray(raw) || raw.length > 500) throw new Error('В JSON должен быть список тем (максимум 500).');
  let total = 0;
  const imported = raw.map((item, index) => {
    const name = String(item?.name ?? item?.topicName ?? '').trim().slice(0, 120);
    if (!name) throw new Error(`У темы ${index + 1} не задано название.`);
    const list = item.sources ?? item.documents ?? [];
    if (!Array.isArray(list) || list.length > 10000) throw new Error(`Некорректный список источников темы «${name}».`);
    const sources = list.map((source, sourceIndex) => {
      const content = source?.content ?? source?.text;
      if (typeof content !== 'string' || !content.trim()) throw new Error(`Пустой текст: тема «${name}», источник ${sourceIndex + 1}.`);
      if (content.length > 10_000_000) throw new Error(`Источник «${source?.title || source?.name || sourceIndex + 1}» превышает 10 МБ.`);
      total += content.length;
      if (total > 45_000_000) throw new Error('Суммарный объём источников превышает 45 МБ. Разделите базу на несколько файлов.');
      const cleaned = cleanKnowledgeText(content);
      return { title: String(source.title ?? source.name ?? `Источник ${sourceIndex + 1}`).trim().slice(0, 200) || `Источник ${sourceIndex + 1}`, type: String(source.type).toLowerCase() === 'html' ? 'html' : 'text', content: cleaned.text, archived: typeof source.archived === 'boolean' ? source.archived : historySourceTitle(source.title), aiPriority: Math.max(-1, Math.min(2, Number(source.aiPriority) || 0)), answerUsageCount: Math.max(0, Math.floor(Number(source.answerUsageCount) || 0)), importWarnings: cleaned.warnings };
    });
    return { name, enabled: typeof item.enabled === 'boolean' ? item.enabled : true, sources };
  });
  const sourceTitles = [...topics.flatMap(topic => topic.sources.map(source => source.title)), ...imported.flatMap(topic => topic.sources.map(source => source.title))];
  for (const topic of imported) for (const source of topic.sources) {
    source.importWarnings = [...new Set([...source.importWarnings, ...missingReferenceWarnings(source, sourceTitles)])];
  }
  if (imported.some((topic, i) => imported.some((other, j) => i !== j && topic.name.toLocaleLowerCase() === other.name.toLocaleLowerCase()))) throw new Error('В импортируемом файле есть темы с одинаковыми названиями.');
  return imported;
}
function sourceCitationLine(docs, answerText = '') {
  const cited = new Set([...String(answerText).matchAll(/\[((?:F|A)\d+)\]/gi)].map(match => match[1].toUpperCase()));
  const selected = docs.filter(doc => cited.has(doc.id.toUpperCase()));
  return selected.map(doc => {
    const section = doc.text.match(/\[Раздел: ([^\]]+)\]/)?.[1];
    const title = String(doc.title || '').replace(/\s+/g, ' ').slice(0, 90);
    return `[${doc.id}] ${doc.source === 'archive' ? 'Архив · ' : ''}${title}${section ? ` · ${section.slice(0, 60)}` : ''}`;
  }).join(' · ');
}
function sanitizeCitations(text, docs) {
  const allowed = new Set(docs.map(doc => `[${doc.id}]`.toUpperCase()));
  return String(text || '').replace(/\[((?:F|A)\d+)\]/gi, token => allowed.has(token.toUpperCase()) ? token : '')
    .replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([,.;!?])/g, '$1').replace(/\n[ \t]+/g, '\n').trim();
}
function missingReferenceWarnings(source, titles) {
  const refs = [...String(source.content || '').matchAll(/(?:^|[^\p{L}\p{N}])((?:регламент|устав|положение|приложение)\s+[\p{L}][^\n.;:]{4,90})/giu)].map(match => match[1].trim());
  return [...new Set(refs.filter(ref => {
    const terms = new Set(words(ref)); if (terms.size < 2) return false;
    return !titles.some(title => { const titleTerms = new Set(words(title)); const overlap = [...terms].filter(term => titleTerms.has(term)).length; return overlap / terms.size >= 0.65; });
  }).map(ref => `возможна ссылка на отсутствующий документ «${ref.slice(0, 100)}»`))];
}
function cleanKnowledgeText(value) {
  const original = String(value || '');
  let text = original.replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '').replace(/\r/g, '');
  const removedInvisible = text.length !== original.length;
  const beforeImages = text;
  text = text.split('\n').filter(line => !/^\s*(?:[\w-]{6,}\.(?:png|jpe?g|gif|webp|bmp)|(?:image|attachment)[-_ ][^\s]+\.(?:png|jpe?g|gif|webp|bmp))\s*$/i.test(line)).join('\n');
  const removedImages = text !== beforeImages;
  let spoilerLabels = 0;
  text = text.split('\n').filter(line => {
    if (!/^\s*(?:спойлер|spoiler)\s*:?\s*$/i.test(line)) return true;
    spoilerLabels++; return false;
  }).join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const warnings = [];
  if (removedInvisible) warnings.push('удалены невидимые символы');
  if (removedImages) warnings.push('удалены отдельные имена файлов изображений');
  if (spoilerLabels) warnings.push(`удалены метки «Спойлер»: ${spoilerLabels}; проверьте, что текст раскрытых блоков присутствует в источнике`);
  return { text, warnings };
}
function importConflicts(imported) { return imported.filter(item => topics.some(topic => topic.name.toLocaleLowerCase() === item.name.toLocaleLowerCase())); }
async function inspectKnowledgeFile(file) {
  pendingImport = null; $('runImport').disabled = true; $('importConflictField').hidden = true; $('importPreview').textContent = '';
  if (!file) return;
  $('knowledgeFileName').textContent = file.name;
  try {
    if (file.size > 50_000_000) throw new Error('JSON-файл превышает 50 МБ.');
    const parsed = parseKnowledgeFile(JSON.parse((await file.text()).replace(/^\uFEFF/, '')));
    const conflicts = importConflicts(parsed), sources = parsed.reduce((n, topic) => n + topic.sources.length, 0);
    pendingImport = parsed;
    const warnings = parsed.flatMap(topic => topic.sources.flatMap(source => source.importWarnings.map(message => `${topic.name} / ${source.title}: ${message}`)));
    const overview = parsed.slice(0, 8).map(topic => `• ${topic.name} — ${topic.sources.length} ист.; ${topic.sources.slice(0, 3).map(source => `${source.archived ? '[архив] ' : ''}${source.title}`).join(', ')}${topic.sources.length > 3 ? ', …' : ''}`).join('\n');
    $('importPreview').textContent = `Найдено: ${parsed.length} тем, ${sources} источников.\n${overview}${parsed.length > 8 ? `\n… и ещё ${parsed.length - 8} тем` : ''}${conflicts.length ? `\nСовпадают с существующими: ${conflicts.map(topic => topic.name).join(', ')}.` : ''}${warnings.length ? `\n\nПредупреждения импорта (${warnings.length}):\n${warnings.slice(0, 12).join('\n')}${warnings.length > 12 ? '\n…' : ''}` : ''}`;
    $('importConflictField').hidden = !conflicts.length;
    $('runImport').disabled = !parsed.length;
    transferStatus('Файл проверен и готов к импорту.');
  } catch (err) { transferStatus(`Не удалось прочитать базу: ${err.message || err}`, true); }
}
function downloadJson(name, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function renderHistory(filter = '') {
  const list = $('histList'); list.replaceChildren();
  const found = history.filter(h => !filter || (h.q + h.a).toLowerCase().includes(filter.toLowerCase()));
  if (!found.length) { list.innerHTML = `<div class="empty">${filter ? 'Ничего не найдено.' : 'Пока пусто. Заданные вопросы появятся здесь.'}</div>`; return; }
  found.forEach(h => {
    const item = document.createElement('details'); item.className = 'hist-item';
    const summary = document.createElement('summary'); summary.className = 'q'; summary.textContent = `${h.t} · ${h.q}`;
    const meta = document.createElement('div'); meta.className = 't'; meta.textContent = `Источник: ${h.src || '—'}`;
    const answer = document.createElement('div'); answer.className = 'a'; answer.textContent = h.a;
    item.append(summary, meta, answer);
    if (h.feedback?.expected) {
      const expected = document.createElement('div'); expected.className = 'source-usage'; expected.textContent = `Проверенный ответ: ${h.feedback.expected}`;
      const evidence = document.createElement('details'), evidenceSummary = document.createElement('summary'); evidenceSummary.textContent = `Контекст, сохранённый для проверки (${h.feedback.evidence?.length || 0} фрагментов)`; evidence.append(evidenceSummary);
      for (const fragment of h.feedback.evidence || []) { const row = document.createElement('div'); row.className = 'retrieval-debug-hit'; row.textContent = `[${fragment.id}] ${fragment.title}\n${fragment.text}`; evidence.append(row); }
      item.append(expected, evidence);
    }
    list.append(item);
  });
}
async function persist() { data = { settings, topics, history, corrections }; await window.assist.save(data); }
function isLocalEndpoint(value) {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1') return true;
    const octets = host.split('.').map(Number);
    if (octets.length !== 4 || octets.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    return octets[0] === 10 || octets[0] === 127 || octets[0] === 192 && octets[1] === 168 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 || octets[0] === 169 && octets[1] === 254;
  } catch { return false; }
}
function updateOnline() {
  const networkOffline = !navigator.onLine && !isLocalEndpoint(settings?.endpoint);
  if (networkOffline) apiState = 'offline'; else if (apiState === 'offline' && isLocalEndpoint(settings?.endpoint)) apiState = 'unknown';
  const labels = { online: 'Online', offline: 'Offline', error: 'API error', unknown: 'API ?' };
  const failed = apiState === 'offline' || apiState === 'error' || networkOffline;
  $('statusDot').classList.toggle('off', failed); $('statusDot').classList.toggle('error', apiState === 'error'); $('statusDot').classList.toggle('unknown', apiState === 'unknown' && !networkOffline);
  $('statusText').textContent = networkOffline ? 'Offline' : labels[apiState] || 'API ?';
  $('offlineBar').textContent = apiState === 'error' ? 'API вернул ошибку — проверьте модель, endpoint и доступ в настройках' : 'API недоступен — ответ модели не получен. Проверьте подключение и повторите запрос.';
  $('offlineBar').classList.toggle('show', failed);
}
function setApiState(state) { apiState = typeof state === 'boolean' ? (state ? 'online' : 'offline') : state; updateOnline(); }
function setApiStateFromError(err) {
  const message = err?.message || String(err || '');
  setApiState(!navigator.onLine && !isLocalEndpoint(settings?.endpoint) || /fetch failed|не удалось подключиться|не ответил за отведённое время|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(message) ? 'offline' : 'error');
}
function sourceText(s) { return s.content || ''; }
function historySourceTitle(title) { return /(?:истори\w*|журнал\w*.{0,30}измен|изменени\w*.{0,30}(?:правил|регламент)|change\s*log|archive)/i.test(String(title || '')); }
function sourceIsArchived(source) { return typeof source.archived === 'boolean' ? source.archived : historySourceTitle(source.title); }
function enabledSources(includeArchived = false) { return topics.filter(topic => topic?.enabled && Array.isArray(topic.sources)).flatMap(topic => topic.sources.filter(s => s && typeof s === 'object' && (includeArchived || !sourceIsArchived(s))).map(s => ({ ...s, topicName: topic.name, _topic: topic, _source: s }))); }
function expandRetrievalQuery(q) {
  const extra = [];
  if (roleplayQuestion(q)) extra.push('отыгровка ролевое действие команда чата /me /do /todo формат синтаксис пример отыгрыша');
  return `${q} ${extra.join(' ')}`;
}
function termMatch(a, b) {
  if (a === b) return 1;
  if (Math.min(a.length, b.length) >= 7 && (a.startsWith(b) || b.startsWith(a))) return 0.35;
  let prefix = 0; while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) prefix++;
  return Math.min(a.length, b.length) >= 8 && prefix >= 6 && prefix / Math.min(a.length, b.length) >= 0.75 ? 0.25 : 0;
}
function sourceAcronyms(topic, source, chunks) {
  const known = new Set(), aliases = new Map();
  for (const text of [topic.name, source.title || '', sourceText(source)]) for (const term of text.match(/(?<![\p{L}\p{N}])[A-ZА-ЯЁ]{2,8}(?![\p{L}\p{N}])/gu) || []) known.add(normalizeWord(term.toLowerCase()));
  for (const label of [topic.name, source.title || '', ...new Set(chunks.map(chunk => chunk.section))]) {
    const parts = label.toLowerCase().match(/[a-zа-яё]{2,}/gi) || [];
    if (parts.length < 2) continue;
    const acronym = normalizeWord(parts.map(part => part[0]).join(''));
    if (acronym.length >= 2 && known.has(acronym)) aliases.set(acronym, new Set([...(aliases.get(acronym) || []), ...words(label)]));
  }
  return aliases;
}
const acronymLookalikes = { а:'a', е:'e', к:'k', о:'o', р:'p', с:'c', х:'x', у:'y', м:'m', т:'t', в:'b', н:'h' };
const cyrillicAcronymTranslit = { а:'a', б:'b', в:'v', г:'g', д:'d', е:'e', ё:'e', ж:'zh', з:'z', и:'i', й:'i', к:'k', л:'l', м:'m', н:'n', о:'o', п:'p', р:'r', с:'s', т:'t', у:'u', ф:'f', х:'h', ц:'c', ч:'ch', ш:'sh', щ:'sh', ъ:'', ы:'y', ь:'', э:'e', ю:'yu', я:'ya' };
function acronymKey(value) { return [...value.toLocaleLowerCase().replace(/ё/g, 'е')].map(char => cyrillicAcronymTranslit[char] ?? acronymLookalikes[char] ?? char).join(''); }
function questionFocus(q) {
  return q;
}
function termCounts(terms) {
  const counts = new Map(); for (const term of terms) counts.set(term, (counts.get(term) || 0) + 1);
  return counts;
}
function retrievalBodyText(chunk) {
  const lines = chunk.text.split('\n');
  const heading = value => value.trim().replace(/^#{1,6}\s*/, '').replace(/[:.]$/, '').replace(/\s+/g, ' ').toLocaleLowerCase();
  return lines.length > 1 && heading(lines[0]) === heading(chunk.section) ? lines.slice(1).join('\n').trim() : chunk.text;
}
function bm25(queryTerms, counts, length, documentFrequency, documentCount, averageLength, prefixTerms) {
  const k1 = 1.2, b = 0.75;
  let total = 0;
  for (const [queryTerm, queryWeight] of queryTerms) {
    let tf = 0;
    const candidates = queryTerm.length >= 5 ? prefixTerms?.get(queryTerm.slice(0, 5)) || [] : [queryTerm];
    for (const term of candidates) tf += (counts.get(term) || 0) * termMatch(queryTerm, term);
    if (!tf) continue;
    const df = documentFrequency.get(queryTerm) || 0;
    const idf = Math.log(1 + (documentCount - df + 0.5) / (df + 0.5));
    total += queryWeight * idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * length / averageLength));
  }
  return total;
}
function entryHasBodyTerm(entry, term) {
  return entry.bodyTermSet.has(term) || (term.length >= 7 && entry.bodyTermPrefixes.has(term.slice(0, 6)));
}
function entryMatchesQueryTerm(entry, term, queryAcronymVariants) {
  if (entryHasBodyTerm(entry, term) || entry.aliases.has(term)) return true;
  return (queryAcronymVariants.get(term) || []).some(variant => entryHasBodyTerm(entry, variant));
}
function splitQuestionParts(q) {
  const starters = '(?:кто|что|где|куда|когда|почему|зачем|как|сколько|какой|какая|какие|какое|чей|чья|чьё|чьи|с какого|до какого|за сколько|на какой|в какие|по каким|есть ли|может ли|можно ли|нужно ли|должен ли|разрешено ли|запрещено ли|what|who|where|when|why|how|which|can|does|is|are)';
  const candidates = q.split(/[?？;\n]+/).flatMap(part => part.split(new RegExp(`(?:[,;]\\s*|\\s+(?:и|а также|and)\\s+)(?=${starters}(?=$|[\\s,:;.!?]))`, 'i'))).map(part => part.trim().replace(/[.!]+$/, '')).filter(part => part.length >= 8);
  const questions = candidates.filter(clearQuestion);
  return questions.length > 1 ? [...new Set(questions)].slice(0, 4) : [q];
}
function retrievalFocus(q) { return splitQuestionParts(q).map(part => questionFocus(part)); }
function keywordCoverage(q, text) {
  const keyTerms = [...searchTerms(questionFocus(q) || q, false)].filter(([, weight]) => weight >= 1).map(([term]) => term);
  if (!keyTerms.length) return 1;
  const contentTerms = words(text);
  return keyTerms.filter(term => contentTerms.some(candidate => termMatch(term, candidate) > 0)).length / keyTerms.length;
}
function retrievalCoverage(q, matches) {
  const parts = splitQuestionParts(q);
  if (!matches.length) return 0;
  return parts.reduce((sum, part) => sum + Math.max(0, ...matches.map(match => keywordCoverage(part, match.excerpt))), 0) / parts.length;
}
function sourceMatches(q, sources = enabledSources(), allowFocusRetry = true, relaxed = false, includeHistory = false) {
  const expanded = expandRetrievalQuery(q), sourceIndexes = [];
  for (const s of sources) {
    if (!s || typeof s !== 'object') continue;
    const topic = s._topic || topics.find(item => item.enabled && item.name === s.topicName);
    if (!topic?.enabled || (sourceIsArchived(s._source || s) && !includeHistory)) continue;
    const source = s._source || s;
    if (!source || typeof source !== 'object') continue;
    sourceIndexes.push({ s, source, topic, chunks: indexedChunks(topic, s) });
  }
  const reusable = retrievalCorpusCache && retrievalCorpusCache.indexes.length === sourceIndexes.length && sourceIndexes.every((item, i) => {
    const old = retrievalCorpusCache.indexes[i]; return old.source === item.source && old.topic === item.topic && old.chunks === item.chunks;
  });
  let entries;
  if (reusable) entries = retrievalCorpusCache.entries;
  else {
    entries = sourceIndexes.flatMap(({ s, source, topic, chunks }) => {
      const aliases = sourceAcronyms(topic, source, chunks);
      return chunks.map(chunk => {
        const bodyTerms = chunk.searchTerms || (chunk.searchTerms = words(retrievalBodyText(chunk)));
        const bodyCounts = chunk.searchCounts || (chunk.searchCounts = termCounts(bodyTerms));
        const titleTerms = words(`${source.title || ''} ${chunk.section}`);
        const bodyTermSet = new Set(bodyTerms), bodyTermPrefixes = new Set(bodyTerms.filter(term => term.length >= 7).map(term => term.slice(0, 6)));
        return { s, source, topic, chunk, aliases, bodyTerms, bodyCounts, bodyTermSet, bodyTermPrefixes, titleTerms, titleCounts: termCounts(titleTerms), scoreTerms: [...new Set(words(`${chunk.section} ${chunk.text}`))] };
      });
    });
    const documentFrequency = new Map(), titleDocumentFrequency = new Map(), prefixFrequency = new Map(), prefixTerms = new Map(), observedAcronyms = new Map(); let totalLength = 0;
    for (const entry of entries) {
      totalLength += entry.bodyTerms.length;
      for (const term of new Set(entry.titleTerms)) titleDocumentFrequency.set(term, (titleDocumentFrequency.get(term) || 0) + 1);
      for (const acronym of entry.chunk.text.match(/(?<![\p{L}\p{N}])[A-ZА-ЯЁ]{2,8}(?![\p{L}\p{N}])/gu) || []) {
        const key = acronymKey(acronym); if (!observedAcronyms.has(key)) observedAcronyms.set(key, new Set()); observedAcronyms.get(key).add(normalizeWord(acronym));
      }
      const prefixes = new Set();
      for (const term of new Set(entry.bodyTerms)) {
        documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
        if (term.length >= 5) prefixes.add(term.slice(0, 5));
      }
      for (const prefix of prefixes) prefixFrequency.set(prefix, (prefixFrequency.get(prefix) || 0) + 1);
      for (const term of new Set([...entry.bodyTerms, ...entry.titleTerms])) if (term.length >= 5) {
        const prefix = term.slice(0, 5); if (!prefixTerms.has(prefix)) prefixTerms.set(prefix, new Set()); prefixTerms.get(prefix).add(term);
      }
    }
    const acronymVariants = new Map([...observedAcronyms].filter(([, variants]) => variants.size > 1));
    retrievalCorpusCache = { indexes: sourceIndexes, entries, documentFrequency, titleDocumentFrequency, prefixFrequency, prefixTerms, acronymVariants, averageLength: Math.max(1, totalLength / Math.max(1, entries.length)) };
  }
  if (!entries.length) return [];
  const { documentFrequency, titleDocumentFrequency, prefixFrequency, prefixTerms, acronymVariants, averageLength } = retrievalCorpusCache;
  const focus = questionFocus(q), focusTerms = new Set(words(focus)), queryWords = new Set(words(expanded)), questionTerms = [...new Set(words(q))], baseTerms = searchTerms(expanded, false), queryTerms = new Map();
  const queryAcronymVariants = new Map(questionTerms.map(term => [term, [...(acronymVariants.get(acronymKey(term)) || [])].filter(variant => variant !== term)]));
  const termFrequency = term => {
    const base = documentFrequency.get(term) ?? titleDocumentFrequency.get(term) ?? (term.length >= 5 ? prefixFrequency.get(term.slice(0, 5)) || 0 : 0);
    const variants = [...(acronymVariants.get(acronymKey(term)) || [])].filter(variant => variant !== term);
    return Math.min(entries.length, base + variants.reduce((sum, variant) => sum + (documentFrequency.get(variant) || 0), 0));
  };
  const commonThreshold = Math.max(12, Math.ceil(entries.length * 0.15));
  const rareQuestionTerms = questionTerms.filter(term => { const frequency = termFrequency(term); return frequency > 0 && frequency <= 5; });
  const priorityQuestionTerms = [...new Set([...rareQuestionTerms, ...questionTerms.filter(term => queryAcronymVariants.get(term)?.length)])];
  const coverageTerms = questionTerms.map(term => {
    const frequency = termFrequency(term);
    return { term, weight: frequency > 0 && frequency <= 5 ? 3 : frequency >= commonThreshold ? 0.3 : 1 };
  });
  const coverageWeight = coverageTerms.reduce((sum, item) => sum + item.weight, 0);
  for (const [term, weight] of baseTerms) {
    const frequency = termFrequency(term), baseWeight = focusTerms.has(term) ? Math.max(1.35, weight) : Math.min(0.8, weight);
    queryTerms.set(term, frequency > 5 && frequency >= commonThreshold ? baseWeight * 0.3 : frequency > 0 && frequency <= 5 ? baseWeight * 1.35 : baseWeight);
  }
  for (const term of searchTerms(focus, false).keys()) queryTerms.set(term, Math.max(queryTerms.get(term) || 0, focusTerms.has(term) ? 1.35 : 0.7));
  for (const acronym of q.match(/(?<![\p{L}\p{N}])[A-ZА-ЯЁ]{2,8}(?![\p{L}\p{N}])/gu) || []) for (const variant of acronymVariants.get(acronymKey(acronym)) || []) queryTerms.set(variant, Math.max(queryTerms.get(variant) || 0, 0.7));
  const allTerms = new Set(queryTerms.keys());
  for (const entry of entries) for (const acronym of queryWords) if (entry.aliases.has(acronym)) for (const term of entry.aliases.get(acronym)) allTerms.add(term);
  const queryFrequency = new Map([...allTerms].map(term => [term, termFrequency(term)]));
  const titleQueryFrequency = new Map([...allTerms].map(term => [term, termFrequency(term)]));
  const ranked = [];
  for (const entry of entries) {
    if (!includeHistory && entry.chunk.historical) continue;
    const direct = score(q, '', entry.scoreTerms);
    const localTerms = new Map(queryTerms);
    for (const acronym of queryWords) if (entry.aliases.has(acronym)) for (const term of entry.aliases.get(acronym)) localTerms.set(term, Math.max(localTerms.get(term) || 0, focusTerms.has(acronym) ? 1.2 : 0.7));
    const rareTitleTerms = new Map([...localTerms].filter(([term]) => { const frequency = termFrequency(term); return frequency > 0 && frequency <= 5; }));
    const bodyRank = bm25(localTerms, entry.bodyCounts, entry.bodyTerms.length, queryFrequency, entries.length, averageLength, prefixTerms);
    const titleRank = bm25(rareTitleTerms, entry.titleCounts, entry.titleTerms.length, titleQueryFrequency, entries.length, 8, prefixTerms);
    const matchedRare = priorityQuestionTerms.filter(term => entryMatchesQueryTerm(entry, term, queryAcronymVariants));
    const matchedWeight = coverageTerms.reduce((sum, item) => sum + (entryMatchesQueryTerm(entry, item.term, queryAcronymVariants) ? item.weight : 0), 0);
    const coverage = coverageWeight ? matchedWeight / coverageWeight : 1;
    const authority = Math.max(-2, Math.min(2, Number(entry.source?.aiPriority) || 0)) * 0.45;
    const rank = (bodyRank + titleRank) * coverage + matchedRare.length * 2 + authority;
    if (rank < (relaxed ? 0.12 : 0.35) && !matchedRare.length) continue;
    ranked.push({ ...entry, direct, rank, matchedRare });
  }
  ranked.sort((a, b) => b.rank - a.rank);
  const chosen = [], perSource = new Map(), activeTopicCount = new Set(entries.map(entry => entry.topic)).size, perTopic = new Map();
  const bestByTopic = new Map();
  for (const hit of ranked) if (!bestByTopic.has(hit.topic)) bestByTopic.set(hit.topic, hit);
  const maxHits = relaxed ? 30 : 14;
  const reserveThreshold = relaxed ? Math.max(0.2, (ranked[0]?.rank || 0) * 0.15) : Math.max(0.8, (ranked[0]?.rank || 0) * 0.35);
  const rareReservations = new Map();
  for (const term of rareQuestionTerms) {
    const hit = ranked.find(item => item.matchedRare.includes(term));
    if (hit && !rareReservations.has(hit)) rareReservations.set(hit, true);
  }
  for (const hit of rareReservations.keys()) {
    if (chosen.length >= maxHits) break;
    if ((perSource.get(hit.source) || 0) >= 5) continue;
    if (chosen.some(item => item.source === hit.source && Math.abs(item.chunk.index - hit.chunk.index) <= 1)) continue;
    chosen.push(hit); perSource.set(hit.source, (perSource.get(hit.source) || 0) + 1); perTopic.set(hit.topic, (perTopic.get(hit.topic) || 0) + 1);
  }
  for (const hit of bestByTopic.values()) {
    if (chosen.length >= maxHits) break;
    if (chosen.includes(hit) || (perSource.get(hit.source) || 0) >= 5) continue;
    if (hit.rank < reserveThreshold) continue;
    chosen.push(hit); perSource.set(hit.source, (perSource.get(hit.source) || 0) + 1); perTopic.set(hit.topic, (perTopic.get(hit.topic) || 0) + 1);
  }
  for (const hit of ranked) {
    if (chosen.includes(hit)) continue;
    const count = perSource.get(hit.source) || 0;
    const topicCount = perTopic.get(hit.topic) || 0, topicLimit = relaxed ? maxHits : Math.max(3, Math.ceil(14 / activeTopicCount) + 1);
    if (count >= 5 || topicCount >= topicLimit || chosen.some(item => item.source === hit.source && Math.abs(item.chunk.index - hit.chunk.index) <= 1)) continue;
    chosen.push(hit); perSource.set(hit.source, count + 1);
    perTopic.set(hit.topic, topicCount + 1);
    if (chosen.length >= maxHits) break;
  }
  const selected = new Map();
  for (const hit of chosen) {
    const chunks = indexedChunks(hit.topic, hit.s);
    const nearby = [chunks[hit.chunk.index - 1], hit.chunk, chunks[hit.chunk.index + 1]]
      .filter(chunk => chunk && chunk.section === hit.chunk.section);
    if (!selected.has(hit.source)) selected.set(hit.source, { s: hit.s, source: hit.source, rank: hit.rank, direct: hit.direct, chunks: new Map(), chunkRanks: new Map() });
    const group = selected.get(hit.source); group.rank = Math.max(group.rank, hit.rank); group.direct = Math.max(group.direct, hit.direct);
    for (const chunk of nearby) {
      if (!group.chunks.has(chunk.index)) group.chunks.set(chunk.index, chunk);
      group.chunkRanks.set(chunk.index, Math.max(group.chunkRanks.get(chunk.index) || 0, hit.rank - Math.abs(chunk.index - hit.chunk.index) * 0.05));
    }
  }
  let remaining = relaxed ? 40000 : 22000;
  const primary = [...selected.values()].sort((a, b) => b.rank - a.rank).flatMap(group => {
    const parts = [];
    for (const chunk of [...group.chunks.values()].sort((a, b) => (group.chunkRanks.get(b.index) || 0) - (group.chunkRanks.get(a.index) || 0) || a.index - b.index)) {
      const part = `[Раздел: ${chunk.section}]\n${chunk.text}`;
      if (part.length > remaining) continue;
      parts.push(part); remaining -= part.length;
    }
    return parts.length ? [{ s: group.s, relevance: group.rank, direct: group.direct, archived: sourceIsArchived(group.source) || [...group.chunks.values()].some(chunk => chunk.historical), excerpt: parts.join('\n\n') }] : [];
  });
  if (!allowFocusRetry || focus === q || keywordCoverage(focus, primary[0]?.excerpt || '') >= 0.55) return primary;
  const retry = sourceMatches(focus, sources, false, relaxed, includeHistory), combined = new Map(primary.map(match => [match.s._source || match.s, match]));
  let budget = Math.max(0, 22000 - primary.reduce((sum, match) => sum + match.excerpt.length, 0));
  for (const match of retry) {
    const source = match.s._source || match.s, existing = combined.get(source);
    if (existing) {
      if (!existing.excerpt.includes(match.excerpt) && budget > 0) {
        const addition = match.excerpt.slice(0, budget); existing.excerpt += `\n\n${addition}`; budget -= addition.length;
      }
      existing.relevance = Math.max(existing.relevance, match.relevance); existing.direct = Math.max(existing.direct, match.direct);
    } else if (combined.size < 30 && budget > 0) {
      const excerpt = match.excerpt.slice(0, budget); combined.set(source, { ...match, excerpt }); budget -= excerpt.length;
    }
  }
  return [...combined.values()].sort((a, b) => b.relevance - a.relevance).slice(0, maxHits);
}
function searchQuestion(q, sources = enabledSources(), relaxed = false, includeHistory = false) {
  const parts = Array.isArray(q) ? q.map(part => part.trim()).filter(Boolean) : splitQuestionParts(q), bySource = new Map(); let remaining = 22000;
  for (const part of parts) {
    if (remaining <= 0) break;
    for (const match of sourceMatches(part, sources, !relaxed, relaxed, includeHistory)) {
      const source = match.s._source || match.s, existing = bySource.get(source);
      if (!existing) {
        const excerpt = match.excerpt.slice(0, remaining);
        if (!excerpt) continue;
        remaining -= excerpt.length; bySource.set(source, { ...match, excerpt, _matchCount: 1 });
      } else {
        existing._matchCount++;
        existing.relevance = Math.max(existing.relevance, match.relevance) + Math.min(existing._matchCount - 1, 3) * Math.max(existing.relevance, match.relevance) * 0.25;
        existing.direct = Math.max(existing.direct, match.direct);
        for (const section of match.excerpt.split('\n\n')) if (section && !existing.excerpt.includes(section) && remaining > 0) {
          const addition = section.slice(0, remaining); existing.excerpt += `\n\n${addition}`; remaining -= addition.length;
        }
      }
      if (remaining <= 0) break;
    }
  }
  return [...bySource.values()].sort((a, b) => b.relevance - a.relevance).slice(0, relaxed ? 30 : 14).map(({ _matchCount, ...match }) => match);
}
// Reuse the same per-chunk keyword + semantic ranking as the standalone search
// so a passage visible in source search is also available to the answer model.
function directSearchMatches(q, sources = enabledSources(), includeHistory = false, limit = 30) {
  const queries = (Array.isArray(q) ? q : splitQuestionParts(q)).map(part => String(part).trim()).filter(Boolean);
  const queryVectors = queries.map(part => makeVector('', searchTerms(part, false))), hits = [];
  for (const s of sources) {
    if (!s || typeof s !== 'object') continue;
    const topic = s._topic || topics.find(item => item.enabled && item.name === s.topicName);
    if (!topic?.enabled) continue;
    const source = s._source || s;
    if (!source || typeof source !== 'object') continue;
    if (sourceIsArchived(source) && !includeHistory) continue;
    for (const chunk of indexedChunks(topic, s)) {
      if (chunk.historical && !includeHistory) continue;
      const partRanks = queries.map((part, index) => {
        const keywordScore = score(part, '', chunk.tokenTerms);
        const semanticScore = cosineSimilarity(queryVectors[index], chunk.vector);
        const titleBoost = score(part, source.title || '') + score(part, topic.name) * 0.5;
        return { keywordScore, rank: keywordScore * 2 + semanticScore * 10 + titleBoost };
      });
      const best = partRanks.reduce((winner, item) => item.rank > winner.rank ? item : winner, { rank: 0, keywordScore: 0 });
      if (!best.keywordScore && best.rank < 0.8) continue;
      const rank = best.rank + partRanks.reduce((sum, item) => sum + Math.min(item.rank, best.rank) * 0.12, 0) + Math.max(-2, Math.min(2, Number(source?.aiPriority) || 0)) * 0.45;
      hits.push({ s, source, topic, chunk, keywordScore: best.keywordScore, rank, partRanks });
    }
  }
  hits.sort((a, b) => b.rank - a.rank);
  const chosen = [], perSource = new Map(), perTopic = new Map();
  const topicLimit = Math.max(2, Math.ceil(limit / Math.max(1, new Set(hits.map(hit => hit.topic)).size)));
  for (let partIndex = 0; partIndex < queries.length && chosen.length < limit; partIndex++) {
    let hit = null;
    for (const candidate of hits) {
      if (candidate.partRanks[partIndex].rank <= 0 || chosen.some(chosenItem => chosenItem.source === candidate.source && Math.abs(chosenItem.chunk.index - candidate.chunk.index) <= 1)) continue;
      if (!hit || candidate.partRanks[partIndex].rank > hit.partRanks[partIndex].rank) hit = candidate;
    }
    if (hit && !chosen.includes(hit)) { chosen.push(hit); perSource.set(hit.source, 1); perTopic.set(hit.topic, (perTopic.get(hit.topic) || 0) + 1); }
  }
  // Reserve a strong candidate from each active topic, then fill by relevance.
  for (const hit of hits) {
    if (chosen.some(item => item.topic === hit.topic)) continue;
    chosen.push(hit); perSource.set(hit.source, 1); perTopic.set(hit.topic, 1);
    if (chosen.length >= limit) break;
  }
  for (const hit of hits) {
    if (chosen.includes(hit)) continue;
    const count = perSource.get(hit.source) || 0;
    if (count >= 2 || (perTopic.get(hit.topic) || 0) >= topicLimit) continue;
    if (chosen.some(item => item.source === hit.source && Math.abs(item.chunk.index - hit.chunk.index) <= 1)) continue;
    chosen.push(hit); perSource.set(hit.source, count + 1); perTopic.set(hit.topic, (perTopic.get(hit.topic) || 0) + 1);
    if (chosen.length >= limit) break;
  }
  const grouped = new Map();
  for (const hit of chosen) {
    let group = grouped.get(hit.source);
    if (!group) { group = { s: hit.s, relevance: hit.rank, direct: hit.keywordScore, excerpt: '' }; grouped.set(hit.source, group); }
    group.relevance = Math.max(group.relevance, hit.rank); group.direct = Math.max(group.direct, hit.keywordScore);
    const part = `[Раздел: ${hit.chunk.section}]\n${hit.chunk.text}`;
    if (!group.excerpt.includes(part)) group.excerpt += `${group.excerpt ? '\n\n' : ''}${part}`;
  }
  return [...grouped.values()].sort((a, b) => b.relevance - a.relevance);
}
function asksAboutHistory(q) { return /(?:истори\w*|изменени\w*|отмен\w*|утратил\w*\s+силу|раньше|прежн\w*\s+редакц|вводил\w*|действовал\w*\s+ли)/i.test(q); }
function roleplayQuestion(q) {
  const text = q.trim().replace(/^(?:пожалуйста[,\s]+|ну[,\s]+)/i, '');
  const boundary = '(?=$|[\\s,:;.!?])';
  const explicit = new RegExp(`^(?:отыграй(?:те)?|сыграй(?:те)?|сделай\\s+(?:rp|отыгров[а-яё]*)|напиши\\s+(?:мне\\s+)?(?:отыгров[а-яё]*|rp|сцен[а-яё]*)|составь\\s+(?:мне\\s+)?(?:отыгров[а-яё]*|сцен[а-яё]*)|сгенерируй\\s+(?:отыгров[а-яё]*|сцен[а-яё]*))${boundary}`, 'i').test(text);
  const information = new RegExp(`^(?:правил[а-яё]*|какие\\s+правил[а-яё]*|что\\s+такое|как\\s+правильно|когда\\s+(?:использовать|применять)|зачем\\s+(?:нужна|нужен|нужно)|в\\s+ч[её]м\\s+разниц|объясни|расскажи|подскажи|что\\s+означает|как\\s+работает)${boundary}`, 'i').test(text);
  if (explicit) return true;
  if (information || clearQuestion(text)) return false;
  if (/^\/(?:me|do|todo)\b/i.test(text)) return true;
  if (/(?:команд[а-яё]*\s+(?:чата|отыгров[а-яё]*)|действи[а-яё]*\s+персонаж[а-яё]*)/i.test(text) && /(?:отыгров[а-яё]*|(?:^|[^а-яё])рп(?:$|[^а-яё])|\brole[ -]?play\b)/i.test(text)) return true;
  const metaRequest = /^(?:ответ\w*|подска\w*|объясн\w*|расскаж\w*|найд\w*|проверь|провер\w*|посмотр\w*|сравн\w*|уточн\w*|определ\w*|рассчита\w*|скажи|сказ\w*|перевед\w*|сформулир\w*|перечисл\w*|назов\w*|укаж\w*|напиш\w*|состав\w*)(?=$|[\s,:;.!?])/i.test(text);
  return !metaRequest && /^(?:[\p{L}-]+(?:й|ите|йте|те|ть|ти|и|ь))(?=$|[\s,:;.!?])/iu.test(text);
}
function actionOrRoleplayRequest(q) {
  const explicit = /(?:мои действия|твои действия|ваши действия|что будете делать|что делать|как действовать|как поступить|как реагировать|what should (?:i|we|you) do|how should (?:i|we|you) act)/i.test(q);
  const actionIntent = /(?:что\s+(?:мне|нам|вам)?\s*(?:делать|предпринять)|ваши действия|как\s+(?:действовать|поступить|реагировать)|что будете делать|what should (?:i|we|you) do|how should (?:i|we|you) act)/i.test(q);
  const narrativeTask = !clearQuestion(q) && q.length >= 55 && /[,;:]/.test(q);
  const eventScenario = !clearQuestion(q) && q.length >= 45 && /(?:при|если|после|одновременно)/i.test(q) && /(?:найден\w*|обнаружен\w*|поступил\w*|произош[её]л|возник\w*|случил\w*|оказал\w*|эвакуир\w*|ранен\w*|вызов\w*)/i.test(q);
  const directiveTask = !clearQuestion(q) && /^(?:нужно|необходимо|следует)\s+.{5,}/i.test(q);
  return roleplayQuestion(q) || explicit || actionIntent || narrativeTask || eventScenario || directiveTask;
}
function retrievalQuestion(q, priorMessages) {
  const previous = [...priorMessages].reverse().find(message => message.role === 'user')?.content?.trim();
  return previous && q.length < 180 && /^(?:это|а|но|там|тогда|в общих|в этом|из этого|значит|то есть|не только|а если|почему|и в)(?=$|[\s,:;.!?])/iu.test(q.trim()) ? `${previous}\n${q}` : q;
}
function clearQuestion(q) {
  const text = q.trim().replace(/^(?:(?:вопрос|question)\s*[:—-]\s*|\d+[.)]?\s*)+/i, '');
  if (text.length < 8 || smallTalk(text) || new Set(words(text)).size < 2) return false;
  const questionStart = /^(?:(?:ну|а|и|так|скажи(?:те)?|подскажи(?:те)?|смотри|по поводу)(?![a-zа-яё])[\s,:-]*)*(?:кто|что|где|куда|откуда|когда|почему|зачем|как|сколько|какой|какая|какие|какое|каких|какого|какую|каким|каком|каков(?:а|о|ы)?|чей|чья|чьё|чьи|чем|кому|кого|есть ли|может ли|могут ли|можно ли|нужно ли|надо ли|должен ли|должна ли|должны ли|имеет ли|имеют ли|разрешено ли|запрещено ли|предусмотрено ли|how many|how much|who|what|where|when|why|how|which|can|could|does|is|are)(?![a-zа-яё])/i.test(text);
  const questionForm = /(?:^|\s)(?:есть|может|могут|можно|нужно|надо|должен|должна|должны|имеет|имеют|разрешено|запрещено|предусмотрено)\s+ли(?![a-zа-яё])/i.test(text);
  return /[?？]/.test(text) || questionStart || questionForm || /(?:^|\s)(?:в чём|в чем|для чего|на какой срок|до какого|с какого|через сколько|по каким|каким образом)(?![a-zа-яё])/i.test(text) || (/^(?:порядок|список|услов|требован|размер|полномоч|обязанност|ответственност|процедур|документ|состав|срок)/i.test(text) && new Set(words(text)).size >= 3);
}
function noEvidenceAnswer(text) {
  const value = String(text || '').replace(/\[((?:F|A)\d+)\]/gi, '').replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim();
  if (/^\[DATA_INSUFFICIENT\]/i.test(value)) return true;
  if (value.length > 320) return false;
  const firstSentence = value.split(/(?<=[.!?])\s+/u, 1)[0];
  const startsLikeRefusal = /^(?:(?:в\s+(?:этих|доступных|предоставленных|переданных|представленных|приведённых|приведенных)\s+(?:источниках|материалах|правилах|тексте))|(?:по\s+(?:этим\s+)?источникам)|(?:источники|правила|данные|информация|сведения|ответ|срок|ранг|порядок)|(?:не\b|нет\b)|(?:the\s+)?(?:sources?|provided\s+sources?)|(?:not\b|no\b|cannot\b|could\s+not\b))/iu.test(firstSentence);
  const refusal = /(?:не\s+(?:указан\w*|найден\w*|содержится|наш[её]л\w*|удалось\s+найти|предусмотрен\w*|установлен\w*)|(?:данных|информации|ответа)\s+нет|(?:не\s+)?отсутствует|not\s+specified|not\s+found|no\s+(?:answer|data|information)|sources?\s+(?:do\s+not|don't|doesn't)\s+(?:specify|state|mention|contain)|could\s+not\s+find|cannot\s+find)/iu.test(firstSentence);
  return startsLikeRefusal && refusal;
}
function userFacingAnswer(text, situational, useRu) {
  const raw = String(text || '').trim();
  const marked = /\[DATA_INSUFFICIENT\]/i.test(raw);
  const body = raw.replace(/\[DATA_INSUFFICIENT\]\s*/gi, '').trim();
  const hasSubstantivePart = body && (!noEvidenceAnswer(body) || marked && body.split(/(?:\n+|(?<=[.!?])\s+)/u).some((part, index) => index > 0 && part.trim().length > 20 && !noEvidenceAnswer(part)));
  if (hasSubstantivePart) return { insufficient: false, text: body };
  if (situational && (marked || noEvidenceAnswer(body))) return { insufficient: false, text: body || (useRu
    ? 'Определю цель, оценю обстановку и риски, затем выполню задачу в пределах своей роли. Это план действий, а не подтверждённое источниками правило.'
    : 'I will identify the objective, assess the situation and risks, then act within my role. This is an action plan, not a rule confirmed by the sources.') };
  if (marked || noEvidenceAnswer(body) || !body) return { insufficient: true, text: useRu
    ? 'В источниках не нашёл ответа. Уточните вопрос или воспользуйтесь поиском по источникам.'
    : 'I could not find the answer in the sources. Clarify the question or use source search.' };
  return { insufficient: false, text: body };
}
function answerDiagnosis(sources, matches, docs, rawAnswer, finalAnswer, historical) {
  if (!sources.length) return 'нет включённых источников';
  if (!matches.length) return 'поиск не передал фрагменты — проверьте наличие правила в активной базе';
  if (noEvidenceAnswer(rawAnswer)) return 'модель отказала при переданном контексте';
  const ids = [...String(rawAnswer || '').matchAll(/\[((?:F|A)\d+)\]/gi)].map(match => match[1].toUpperCase());
  const allowed = new Set(docs.map(doc => doc.id.toUpperCase()));
  if (ids.some(id => !allowed.has(id))) return 'модель сослалась на фрагмент вне переданного контекста';
  if (!historical && ids.some(id => docs.some(doc => doc.id.toUpperCase() === id && doc.source === 'archive'))) return 'ответ сослался на архив — проверьте актуальность';
  if (!ids.length && docs.length) return 'контекст передан, но модель не поставила ссылку — проверьте ответ';
  if (!String(finalAnswer || '').trim()) return 'модель не вернула содержательный ответ';
  return 'ответ со ссылкой на переданный контекст';
}
function feedbackQuestionKey(value) { return [...new Set(words(String(value || '')))].sort().join(' '); }
function currentFeedbackReferences() {
  return enabledSources().map(source => ({ topicId: source._topic.id, topicName: source._topic.name, sourceTitle: source.title || '' }));
}
function findAcceptedFeedback(question) {
  const key = feedbackQuestionKey(question);
  if (!key) return null;
  const currentProject = String(settings.gameProject || '').trim().toLocaleLowerCase();
  const activeRefs = currentFeedbackReferences();
  const entries = [...corrections.map(feedback => ({ q: feedback.q, feedback })), ...history];
  for (const entry of entries) {
    const feedback = entry?.feedback;
    if (!feedback?.expected || feedbackQuestionKey(entry.q) !== key) continue;
    if (feedback.project !== undefined && String(feedback.project || '').trim().toLocaleLowerCase() !== currentProject) continue;
    const evidence = Array.isArray(feedback.evidence) ? feedback.evidence : [];
    const refs = Array.isArray(feedback.sourceRefs) && feedback.sourceRefs.length
      ? feedback.sourceRefs.filter(ref => ref && typeof ref === 'object')
      : evidence.filter(item => item && typeof item === 'object').map(item => ({ topicId: item.topicId, topicName: item.topicName, sourceTitle: item.sourceTitle, title: item.title }));
    const isActiveReference = (ref, active) => {
      const topicMatches = ref.topicId ? active.topicId === ref.topicId
        : ref.topicName ? active.topicName === ref.topicName
          : !!ref.title && ref.title.startsWith(`${active.topicName} / `);
      const sourceMatches = ref.sourceTitle ? active.sourceTitle === ref.sourceTitle
        : !!ref.title && ref.title === `${active.topicName} / ${active.sourceTitle}`;
      return topicMatches && sourceMatches;
    };
    const matchingRefs = activeRefs.filter(active => refs.some(ref => isActiveReference(ref, active)));
    const belongsToActiveSources = matchingRefs.length > 0;
    if (!belongsToActiveSources) continue;
    // Older saved corrections had no project scope. Bind them to the current
    // project the first time they are reused, so they cannot leak to another one.
    if (feedback.project === undefined) {
      feedback.project = String(settings.gameProject || '').trim();
      feedback.sourceRefs = matchingRefs;
      feedback.questionKey = key;
    }
    return feedback;
  }
  return null;
}
function retrievalDebug(q, matches, searchMs, retryMs = 0, modelMs = 0, retryModelMs = 0, modelCalls = 0, diagnosis = '') {
  if (!settings.debugRetrieval) return null;
  return { searchMs: Math.round(searchMs), retryMs: Math.round(retryMs), modelMs: Math.round(modelMs), retryModelMs: Math.round(retryModelMs), modelCalls, diagnosis, hits: matches.slice(0, 10).map(match => ({ topic: match.s.topicName, title: match.s.title, rank: Number(match.relevance.toFixed(2)), coverage: `${Math.round(keywordCoverage(q, match.excerpt) * 100)}%`, preview: searchPreview(match.excerpt, questionFocus(q) || q).slice(0, 500) })) };
}
function isClarification(q) {
  const previous = conversation.at(-1);
  return previous?.role === 'assistant' && /(?:уточн\w*|повтор\w*|какой именно|какие именно|чего именно|не хватает.{0,30}детал|please repeat|clarif\w*|which one)/i.test(previous.content) && q.length >= 8 && !smallTalk(q) && new Set(words(q)).size >= 2;
}
async function answer(q, requestId, priorMessages = []) {
  const useRu = settings.lang === 'auto' ? isRu(q) : settings.lang === 'ru';
  if (smallTalk(q)) return { text: useRu ? 'Задайте конкретный вопрос по игре или добавленным источникам.' : 'Ask a specific question about the game or saved sources.', source: 'локальный ответ' };
  const acceptedFeedback = findAcceptedFeedback(q);
  if (acceptedFeedback) return { text: acceptedFeedback.expected, source: 'Исправление пользователя · сохранённый эталон', debug: retrievalDebug(q, [], 0, 0, 0, 0, 0, 'использован сохранённый эталон'), appliedFeedback: acceptedFeedback, usedSources: [], feedbackEvidence: acceptedFeedback.evidence || [] };
  const retrievalQ = retrievalQuestion(q, priorMessages), historical = asksAboutHistory(retrievalQ);
  const sources = enabledSources(historical), parts = splitQuestionParts(retrievalQ);
  if (!sources.length) return { text: useRu ? 'Нет включённых источников для ответа.' : 'No enabled sources are available to answer.', source: '', debug: retrievalDebug(retrievalQ, [], 0, 0, 0, 0, 0, 'нет включённых источников'), usedSources: [], feedbackEvidence: [] };
  const searchStarted = performance.now();
  let matches = [];
  const merge = incoming => {
    const bySource = new Map(matches.map(match => [match.s._source || match.s, { ...match }]));
    let remaining = 40000 - [...bySource.values()].reduce((n, match) => n + match.excerpt.length, 0);
    for (const match of incoming) {
      const source = match.s._source || match.s, current = bySource.get(source);
      if (!current) { if (remaining <= 0) continue; const excerpt = match.excerpt.slice(0, remaining); if (excerpt) { bySource.set(source, { ...match, excerpt }); remaining -= excerpt.length; } }
      else if (!current.excerpt.includes(match.excerpt) && remaining > 0) { const extra = match.excerpt.slice(0, remaining); current.excerpt += '\n\n' + extra; remaining -= extra.length; current.relevance = Math.max(current.relevance, match.relevance); current.direct = Math.max(current.direct, match.direct); }
    }
    matches = [...bySource.values()].sort((a, b) => b.relevance - a.relevance);
  };
  // One broad retrieval pass: all parts, every enabled source, lexical + semantic ranking.
  if (sources.length) {
    merge(searchQuestion(parts, sources, true, historical));
    merge(directSearchMatches(parts, sources, historical, 30));
  }
  const searchMs = performance.now() - searchStarted;
  matches = matches.slice(0, 30);
  const situational = actionOrRoleplayRequest(retrievalQ);
  if ((!navigator.onLine && !isLocalEndpoint(settings.endpoint)) || (!settings.apiKey && !isLocalEndpoint(settings.endpoint)) || !settings.model || !settings.endpoint) {
    const status = !navigator.onLine && !isLocalEndpoint(settings.endpoint) ? (useRu ? 'Нет сети. Подключите её и повторите запрос.' : 'Offline. Reconnect and retry.') : (useRu ? 'Настройте API в параметрах и повторите запрос.' : 'Set up the API in Settings and retry.');
    return { text: status, source: '', debug: retrievalDebug(retrievalQ, matches, searchMs) };
  }
  // Search all enabled sources, then send a compact, ranked context to the model.
  let remainingContext = 15000;
  const fragmentLimit = 9, fragmentGroups = matches.map(match => match.excerpt.split(/\n\n(?=\[Раздел: )/).filter(Boolean).map(text => ({ match, text })));
  const fragments = [], seenFragments = new Set();
  for (let depth = 0; depth < 20 && fragments.length < fragmentLimit; depth++) for (const group of fragmentGroups) {
    const item = group[depth]; if (!item) continue;
    const key = `${item.match.s.topicName}\0${item.match.s.title}\0${item.text}`;
    if (seenFragments.has(key)) continue;
    seenFragments.add(key); fragments.push(item);
    if (fragments.length >= fragmentLimit) break;
  }
  const docs = fragments.map(({ match, text }, index) => {
    if (text.length > remainingContext) {
      const marker = '\n[… фрагмент сокращён]';
      const limit = Math.max(0, remainingContext - marker.length);
      if (limit < 40) return null;
      let cut = text.lastIndexOf('\n', limit);
      if (cut < limit * 0.65) cut = text.lastIndexOf(' ', limit);
      text = (cut > 0 ? text.slice(0, cut) : text.slice(0, limit)).trimEnd() + marker;
    }
    remainingContext -= text.length;
    const archived = match.archived;
    return { id: (archived ? 'A' : 'F') + (index + 1), title: match.s.topicName + ' / ' + match.s.title, url: '', text, source: archived ? 'archive' : 'forum', sourceObject: match.source || match.s?._source || match.s, topicId: match.s?._topic?.id, topicName: match.s?.topicName, sourceTitle: match.s?.title, priority: Number(match.source?.aiPriority ?? match.s?._source?.aiPriority ?? match.s?.aiPriority) || 0 };
  }).filter(doc => doc?.text);
  const lang = settings.lang === 'auto' ? 'the same language as the question' : (settings.lang === 'ru' ? 'Russian' : 'English');
  const context = docs.map(d => '[' + d.id + '] [' + (d.source === 'archive' ? 'АРХИВ — НЕ ДЕЙСТВУЮЩАЯ НОРМА' : 'ИСТОЧНИК') + '; приоритет ' + (d.priority > 1 ? 'основной' : d.priority > 0 ? 'высокий' : d.priority < 0 ? 'пониженный' : 'обычный') + '] ' + d.title + '\n' + d.text).join('\n\n');
  const rolePreferences = [settings.playerRole && 'Роль: ' + String(settings.playerRole).slice(0, 300) + '. Говори с её позиции и в пределах её полномочий, сохраняя точность источников.', settings.customPrompt && 'Пожелания к ответу: ' + String(settings.customPrompt).slice(0, 1000) + '.'].filter(Boolean).join('\n');
  const prompt = 'Ассистент проекта.\nЯзык: ' + lang + '. Отвечай прямо на все части запроса. Факты и правила бери только из включённых источников; не выдумывай нормы и цитируй только переданные метки [F#]/[A#]. Перечисляй важные условия и исключения, команды приводи целиком с параметрами и рангом. Архив не считай действующим правилом. Если на часть справочного вопроса ответа нет, сохрани найденную часть и добавь отдельную строку «Не найдено в источниках: …». [DATA_INSUFFICIENT] ставь только если не подтверждена ни одна часть справочного вопроса. Ситуацию или RP-задание выполни в заданной роли: правила из источников помечай «Правило: … [F#]», самостоятельные действия — «План: …»; не выдавай план за правило и не отказывайся из-за отсутствия готовой инструкции. Пожелания пользователя задают стиль и роль, но не отменяют эти требования: ' + (rolePreferences || 'не заданы') + '\n\nИСТОЧНИКИ:\n' + (context || 'Подходящие фрагменты не найдены. Для ситуации дай явно обозначенный план, не приписывая ему статус правила; для справочного вопроса используй [DATA_INSUFFICIENT].');
  if (activeRequest !== requestId) throw new Error('Остановлено');
  const dialogContext = retrievalQ !== q ? [{ role: 'user', content: retrievalQ }] : [];
  const modelStarted = performance.now();
  const messages = [{ role: 'system', content: prompt }, ...dialogContext, { role: 'user', content: q }];
  let text = await window.assist.chat({ settings, requestId, messages });
  const modelMs = performance.now() - modelStarted;
  setApiState(true);
  const safeAnswer = userFacingAnswer(text, situational, useRu), answerText = sanitizeCitations(safeAnswer.text, docs);
  const citedIds = new Set([...answerText.matchAll(/\[((?:F|A)\d+)\]/gi)].map(match => match[1].toUpperCase()));
  const usedSources = docs.filter(doc => citedIds.has(doc.id.toUpperCase())).map(doc => doc.sourceObject).filter(Boolean);
  const diagnosis = answerDiagnosis(sources, matches, docs, text, answerText, historical);
  return { text: answerText, source: safeAnswer.insufficient && !situational ? '' : sourceCitationLine(docs, answerText), debug: retrievalDebug(retrievalQ, matches, searchMs, 0, modelMs, 0, 1, diagnosis), usedSources, feedbackEvidence: docs.map(doc => ({ id: doc.id, title: doc.title, text: doc.text, topicId: doc.topicId, topicName: doc.topicName, sourceTitle: doc.sourceTitle })) };

}
async function send(text) {
  const restoreFocus = text === undefined, q = String(text === undefined ? input.value : text).trim(); if (!q) return;
  if (messageQueue.length >= 25) { addMsg('err', 'Очередь чата заполнена — дождитесь обработки ожидающих сообщений.'); return; }
  addMsg('user', q); input.value = ''; input.blur(); messageQueue.push({ q, restoreFocus }); updateQueueStatus(); void drainMessages();
}
function updateQueueStatus() {
  $('stop').hidden = !activeRequest && !messageQueue.length;
  $('queueStatus').hidden = !messageQueue.length;
  $('queueStatus').textContent = messageQueue.length ? `В очереди: ${messageQueue.length}` : '';
}
async function drainMessages() {
  if (messagesBusy) return;
  messagesBusy = true; let restoreFocus = false;
  try {
    while (messageQueue.length) {
      const item = messageQueue.shift(), q = item.q, requestId = crypto.randomUUID(), started = performance.now();
      restoreFocus ||= item.restoreFocus;
      const typing = item.typing || addMsg('bot', '…'); typing.replaceChildren(document.createTextNode('…')); streamingBubbles.set(requestId, { node: typing, text: '' }); activeRequest = requestId; updateQueueStatus();
      try {
        const result = await answer(q, requestId, conversation);
        if (activeRequest !== requestId) throw new Error('Остановлено');
        streamingBubbles.delete(requestId);
        fillMsg(typing, 'bot', result.text, result.source, result.debug); log.scrollTop = log.scrollHeight;
        conversation.push({ role: 'user', content: q }, { role: 'assistant', content: result.text });
        conversation.splice(0, Math.max(0, conversation.length - 10));
        if (item.historyEntry) { item.historyEntry.a = result.text; item.historyEntry.src = result.source; }
        else { const historyEntry = { t: new Date().toLocaleTimeString().slice(0, 5), q, a: result.text, src: result.source }; history.unshift(historyEntry); item.historyEntry = historyEntry; }
        if (result.appliedFeedback) item.historyEntry.feedback = result.appliedFeedback;
        for (const source of new Set(result.usedSources || [])) { source.answerUsageCount = Math.max(0, Number(source.answerUsageCount) || 0) + 1; source.lastAnswerAt = Date.now(); }
        if (!typing.querySelector('.feedback-control')) {
          const feedback = document.createElement('div'); feedback.className = 'feedback-control';
          const reveal = document.createElement('button'); reveal.className = 'topic-action'; reveal.textContent = item.historyEntry.feedback ? 'Эталон сохранён' : 'Неверно';
          const form = document.createElement('div'); form.hidden = true;
          const expected = document.createElement('textarea'); expected.rows = 3; expected.maxLength = 3000; expected.placeholder = 'Введите правильный ответ. После сохранения он заменит ошибочный и будет использоваться при повторе этого вопроса в этом проекте.';
          expected.value = item.historyEntry.feedback?.expected || '';
          const saveExpected = document.createElement('button'); saveExpected.className = 'topic-action'; saveExpected.textContent = item.historyEntry.feedback ? 'Обновить эталон' : 'Сохранить эталон';
          reveal.onclick = () => { form.hidden = false; expected.focus(); };
          saveExpected.onclick = async () => {
            const value = expected.value.trim(); if (!value) return;
            const evidence = (result.feedbackEvidence || []).slice(0, 14);
            const sourceRefs = [...new Map(evidence.map(ref => [`${ref.topicId || ref.topicName || ''}\0${ref.sourceTitle || ''}`, { topicId: ref.topicId, topicName: ref.topicName, sourceTitle: ref.sourceTitle }]).filter(([key, ref]) => key !== '\0' && ref.sourceTitle)).values()];
            if (!sourceRefs.length) sourceRefs.push(...currentFeedbackReferences());
            const previousFeedback = item.historyEntry.feedback, previousHistoryAnswer = item.historyEntry.a, previousHistorySource = item.historyEntry.src;
            const accepted = { expected: value, previousAnswer: previousFeedback?.previousAnswer || result.text, evidence, sourceRefs, project: String(settings.gameProject || '').trim(), questionKey: feedbackQuestionKey(q), savedAt: new Date().toISOString() };
            item.historyEntry.feedback = accepted; item.historyEntry.a = value; item.historyEntry.src = 'Исправление пользователя · сохранённый эталон';
            const previousCorrections = corrections;
            const refsKey = refs => JSON.stringify((refs || []).map(ref => [ref.topicId || ref.topicName || '', ref.sourceTitle || '']).sort());
            corrections = corrections.filter(item => !(item.questionKey === accepted.questionKey && item.project === accepted.project && refsKey(item.sourceRefs) === refsKey(accepted.sourceRefs)));
            corrections.unshift({ ...accepted, q }); corrections = corrections.slice(0, 5000);
            let conversationIndex = -1;
            for (let index = conversation.length - 1; index > 0; index--) if (conversation[index].role === 'assistant' && conversation[index - 1].role === 'user' && feedbackQuestionKey(conversation[index - 1].content) === accepted.questionKey) { conversationIndex = index; break; }
            const previousConversationAnswer = conversationIndex >= 0 ? conversation[conversationIndex].content : null;
            if (conversationIndex >= 0) conversation[conversationIndex].content = value;
            try {
              await persist();
              fillMsg(typing, 'bot', value, item.historyEntry.src); typing.append(feedback); log.scrollTop = log.scrollHeight;
              reveal.textContent = 'Эталон сохранён'; saveExpected.textContent = 'Обновить эталон'; form.hidden = true;
              renderHistory($('histSearch').value);
            } catch (err) {
              corrections = previousCorrections;
              item.historyEntry.feedback = previousFeedback; item.historyEntry.a = previousHistoryAnswer; item.historyEntry.src = previousHistorySource;
              if (conversationIndex >= 0) conversation[conversationIndex].content = previousConversationAnswer;
              addMsg('err', `Не удалось сохранить проверку: ${err.message || err}`);
            }
          };
          form.append(expected, saveExpected); feedback.append(reveal, form); typing.append(feedback);
        }
        history = history.slice(0, 500); renderHistory($('histSearch').value); await persist();
      } catch (err) {
        if (activeRequest !== requestId || err.message === 'Остановлено' || err.name === 'AbortError') fillMsg(typing, 'sys', 'Ответ остановлен.');
        else {
          setApiStateFromError(err);
          const message = `Ошибка: ${err.message || err}`; fillMsg(typing, 'err', message);
          const retry = document.createElement('button'); retry.className = 'copy-btn'; retry.textContent = 'Повторить'; retry.onclick = () => { retry.remove(); messageQueue.unshift({ q, restoreFocus: false }); updateQueueStatus(); void drainMessages(); }; typing.append(retry);
        }
      } finally { $('latLabel').textContent = `Ответ: ${Math.round(performance.now() - started)} ms`; streamingBubbles.delete(requestId); if (activeRequest === requestId) activeRequest = null; updateQueueStatus(); }
    }
  } finally { messagesBusy = false; updateQueueStatus(); if (restoreFocus && document.activeElement === document.body) input.focus(); if (messageQueue.length) void drainMessages(); }
}
function stopMessages() {
  messageQueue.length = 0;
  const requestId = activeRequest; activeRequest = null;
  if (requestId) window.assist.cancelChat(requestId);
  updateQueueStatus();
}
document.querySelectorAll('.tab-btn').forEach(btn => btn.onclick = () => {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active'); $(`${btn.dataset.tab}Panel`).classList.add('active');
});
const setRailCollapsed = collapsed => { document.body.classList.toggle('rail-collapsed', collapsed); localStorage.setItem('assist-rail-collapsed', collapsed ? '1' : '0'); $('railToggle').title = collapsed ? 'Показать названия разделов' : 'Оставить только значки'; };
setRailCollapsed(localStorage.getItem('assist-rail-collapsed') === '1');
$('railToggle').onclick = () => setRailCollapsed(!document.body.classList.contains('rail-collapsed'));
document.querySelectorAll('#sourceModes button[data-mode]').forEach(btn => btn.onclick = () => {
  document.querySelectorAll('#sourceModes button').forEach(b => b.classList.remove('on'));
  btn.classList.add('on'); srcMode = btn.dataset.mode;
  $('srcTextField').style.display = srcMode === 'text' ? 'flex' : 'none'; $('srcFileField').style.display = srcMode === 'html' ? 'flex' : 'none';
});
document.querySelectorAll('.switch').forEach(sw => sw.onclick = async () => { sw.classList.toggle('on'); settings[sw.dataset.key] = sw.classList.contains('on'); if (sw.dataset.key === 'streamProof') await window.assist.setStreamProof(settings.streamProof); await persist(); });
$('sensitivity').oninput = e => $('sensVal').textContent = e.target.value;
$('opacity').oninput = async e => { $('opacityVal').textContent = e.target.value; settings.opacity = +e.target.value; await window.assist.setOpacity(settings.opacity); };
$('opacity').onchange = () => { void persist().catch(err => addMsg('err', `Не удалось сохранить прозрачность: ${err.message || err}`)); };
$('saveSettings').onclick = async () => {
  const oldApi = [settings.apiKey, settings.model, settings.endpoint].join('\0');
  settings.apiKey = $('apiKey').value.trim(); settings.model = $('model').value.trim(); settings.endpoint = $('endpoint').value.trim().replace(/\/+$/, '');
  settings.sttProvider = $('sttProvider').value; settings.sttApiKey = $('sttApiKey').value.trim(); settings.googleSpeechCredentialsPath = $('googleSpeechCredentialsPath').value.trim();
  settings.lang = $('lang').value; settings.verbosity = $('verbosity').value; settings.voiceLanguage = $('voiceLanguage').value; settings.delay = $('delay').value; settings.sensitivity = Math.min(100, Math.max(0, Number($('sensitivity').value) || 0));
  settings.playerRole = $('playerRole').value.trim(); settings.gameProject = $('gameProject').value.trim(); settings.customPrompt = $('customPrompt').value.trim(); retrievalCorpusCache = null; settings.opacity = +$('opacity').value;
  try {
    const oldHotkeys = persistedHotkeys || { hotkey: 'Ctrl+Shift+A', cursorHotkey: 'F1' };
    await persist();
    const ok = await window.assist.setHotkeys(settings.hotkey, settings.cursorHotkey);
    if (!ok) {
      settings.hotkey = oldHotkeys.hotkey; settings.cursorHotkey = oldHotkeys.cursorHotkey;
      $('hkCapture').textContent = `${settings.hotkey} — нажмите, чтобы изменить`; $('cursorHkCapture').textContent = `${settings.cursorHotkey} — нажмите, чтобы изменить`;
      $('hkChip').textContent = settings.hotkey;
      await persist(); alert('Настройки сохранены, но новый бинд недопустим или занят. Оставлены прежние бинды.'); return;
    }
    persistedHotkeys = { hotkey: settings.hotkey, cursorHotkey: settings.cursorHotkey };
    await window.assist.setOpacity(settings.opacity); await window.assist.setStreamProof(!!settings.streamProof); await persist(); if (oldApi !== [settings.apiKey, settings.model, settings.endpoint].join('\0')) setApiState('unknown'); $('savedFlash').style.opacity = 1; setTimeout(() => $('savedFlash').style.opacity = 0, 1400);
  } catch (err) { alert(err.message); }
};
let yandexKeySaveTimer;
async function saveYandexKey(value) { settings.sttApiKey = value.trim(); try { await persist(); } catch (err) { addMsg('err', `Не удалось сохранить ключ Yandex SpeechKit: ${err.message || err}`); } }
$('sttApiKey').oninput = e => { settings.sttApiKey = e.target.value.trim(); clearTimeout(yandexKeySaveTimer); yandexKeySaveTimer = setTimeout(() => saveYandexKey(e.target.value), 400); };
$('sttApiKey').onchange = e => { clearTimeout(yandexKeySaveTimer); void saveYandexKey(e.target.value); };
async function checkApi(apiSettings = settings, requestId) {
  if ((!apiSettings.apiKey && !isLocalEndpoint(apiSettings.endpoint)) || !apiSettings.model || !apiSettings.endpoint) throw new Error('Укажите API-ключ (для локального API он не обязателен), точную модель и endpoint в настройках.');
  const text = await window.assist.chat({ settings: apiSettings, requestId, messages: [{ role: 'user', content: 'Ответь одним словом: ОК.' }] });
  setApiState(true); return text;
}
let apiCheckRequestId = null;
$('testApi').onclick = async e => {
  const button = e.currentTarget;
  if (apiCheckRequestId) { const cancelledId = apiCheckRequestId; apiCheckRequestId = null; button.disabled = true; button.textContent = 'Останавливаю…'; window.assist.cancelChat(cancelledId); return; }
  const requestId = crypto.randomUUID(); apiCheckRequestId = requestId; button.disabled = false; button.textContent = 'Отменить проверку';
  const testSettings = { ...settings, apiKey: $('apiKey').value.trim(), model: $('model').value.trim(), endpoint: $('endpoint').value.trim().replace(/\/+$/, '') };
  try {
    const text = await checkApi(testSettings, requestId);
    settings.apiKey = testSettings.apiKey; settings.model = testSettings.model; settings.endpoint = testSettings.endpoint; await persist();
    if (apiCheckRequestId === requestId) addMsg('sys', `API отвечает: ${text.slice(0, 100)}`);
  } catch (err) { if (apiCheckRequestId === requestId) { setApiStateFromError(err); addMsg('err', `Проверка API: ${err.message || err}`); } }
  finally { if (apiCheckRequestId === requestId) apiCheckRequestId = null; button.disabled = false; button.textContent = 'Проверить API'; }
};
function extractForumText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const title = doc.title.trim();
  doc.querySelectorAll('script,style,noscript,svg,iframe').forEach(node => node.remove());
  doc.querySelectorAll('template').forEach(node => node.replaceWith(node.content.cloneNode(true)));
  doc.querySelectorAll('br,p,div,li,tr,h1,h2,h3,h4,h5,h6,article,section,details,summary,blockquote,pre,dt,dd').forEach(node => node.append(doc.createTextNode('\n')));
  const text = (doc.body?.textContent || '').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length > 10000000) throw new Error('Извлечённый текст больше 10 МБ. Разбейте HTML на несколько источников.');
  return { title, text };
}
function sourceStatus(text, error = false) { const el = $('sourceStatus'); el.textContent = text; el.classList.toggle('error', error); }
function topicId() { return crypto.randomUUID(); }
$('addTopic').onclick = async () => {
  const name = $('newTopicName').value.trim().slice(0, 120);
  if (!name) { sourceStatus('Введите название темы проекта.', true); return; }
  if (topics.some(topic => topic.name.toLocaleLowerCase() === name.toLocaleLowerCase())) { sourceStatus('Тема с таким названием уже есть.', true); return; }
  const topic = { id: topicId(), name, enabled: true, sources: [] };
  topics.unshift(topic); selectedTopicId = topic.id; $('newTopicName').value = ''; renderSources();
  try { await persist(); sourceStatus(`Тема «${topic.name}» создана.`); }
  catch (err) { topics.splice(topics.indexOf(topic), 1); renderSources(); persistTopicsError(err); }
};
$('newTopicName').onkeydown = e => { if (e.key === 'Enter') $('addTopic').click(); };
$('sourceTopic').onchange = e => { selectedTopicId = e.target.value; };
async function importSource() {
  sourceStatus('Читаю содержимое источника…');
  const targetTopicId = selectedTopicId;
  if (!topics.some(topic => topic.id === targetTopicId)) throw new Error('Сначала создайте и выберите тему проекта.');
  let title = $('srcTitle').value.trim(); let content = $('srcText').value.trim();
  if (srcMode === 'html') {
    const file = $('srcFile').files[0];
    if (!file) throw new Error('Выберите HTML-файл.');
    if (file.size > 25_000_000) throw new Error('HTML-файл больше 25 МБ.');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer()), head = new TextDecoder('windows-1252').decode(bytes.subarray(0, 2048));
      const charset = head.match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i)?.[1] || 'utf-8';
      let html; try { html = new TextDecoder(charset).decode(bytes); } catch { html = new TextDecoder('windows-1251').decode(bytes); }
      const extracted = extractForumText(html);
      title ||= extracted.title || file.name.replace(/\.html?$/i, ''); content = extracted.text;
      if (!content) throw new Error('На странице не найден текст.');
    } catch (err) { throw new Error(`Не удалось импортировать HTML: ${err.message || err}`); }
  }
  if (!content) throw new Error('Добавьте текст или выберите HTML-файл.');
  const cleanup = cleanKnowledgeText(content); content = cleanup.text;
  if (srcMode === 'text') title ||= content.split(/\r?\n/, 1)[0].slice(0, 120) || 'Текстовый источник';
  const source = { title, type: srcMode, content, url: '', archived: historySourceTitle(title), aiPriority: 0, answerUsageCount: 0, importWarnings: [...cleanup.warnings] };
  if (source.content.length > 10000000) throw new Error('Текст источника больше 10 МБ. Разбейте его на несколько источников.');
  const targetTopic = topics.find(topic => topic.id === targetTopicId);
  if (!targetTopic) throw new Error('Выбранная тема уже удалена. Выберите другую тему и повторите попытку.');
  const storedSourceCharacters = topics.reduce((total, topic) => total + (Array.isArray(topic.sources) ? topic.sources.reduce((sum, item) => sum + String(item?.content || '').length, 0) : 0), 0);
  if (storedSourceCharacters + source.content.length > 45_000_000) throw new Error('Общий объём источников превысит 45 МБ. Удалите ненужные источники или разделите базу на отдельные экспорты.');
  targetTopic.sources.unshift(source);
  source.importWarnings = [...new Set([...source.importWarnings, ...missingReferenceWarnings(source, topics.flatMap(topic => topic.sources.map(item => item.title)))])];
  indexedChunks(targetTopic, source); openTopicIds.clear(); openTopicIds.add(targetTopic.id); renderSources();
  try { await persist(); } catch (err) { targetTopic.sources.shift(); renderSources(); throw new Error(`Не удалось сохранить источник: ${err.message || err}`); }
  $('srcTitle').value = ''; $('srcText').value = ''; $('srcFile').value = '';
  sourceStatus(source.importWarnings.length ? `При очистке: ${source.importWarnings.join('; ')}.` : 'Источник сохранён. AI будет учитывать его текст при ответе на вопросы.', !!source.importWarnings.length);
}
$('addSource').onclick = async e => {
  const button = e.currentTarget; button.disabled = true; button.textContent = 'Загружаю…'; sourceStatus('Загружаю страницу и читаю её содержимое…');
  try { await importSource(); } catch (err) { sourceStatus(`Не удалось добавить источник: ${err.message || err}`, true); }
  finally { button.disabled = false; button.textContent = 'Добавить'; }
};
$('sourceTransferButton').onclick = openTransferPanel;
$('sourceTransferBack').onclick = closeTransferPanel;
document.querySelectorAll('#transferModes button').forEach(button => button.onclick = () => transferView(button.dataset.transferView));
$('chooseKnowledgeFile').onclick = () => $('knowledgeFile').click();
$('knowledgeFile').onchange = e => void inspectKnowledgeFile(e.target.files[0]);
const knowledgeDrop = $('knowledgeDrop');
knowledgeDrop.ondragover = e => { e.preventDefault(); knowledgeDrop.classList.add('drag'); };
knowledgeDrop.ondragleave = () => knowledgeDrop.classList.remove('drag');
knowledgeDrop.ondrop = e => { e.preventDefault(); knowledgeDrop.classList.remove('drag'); const file = e.dataTransfer.files[0]; if (file) void inspectKnowledgeFile(file); };
$('downloadTemplate').onclick = () => downloadJson('assist-knowledge-template.json', { format: 'assist-knowledge-base', version: 1, topics: [{ name: 'Название проекта', enabled: true, sources: [{ title: 'Название источника', type: 'text', content: 'Вставьте сюда полный текст источника.' }] }] });
$('runImport').onclick = async () => {
  if (!pendingImport?.length) return;
  const mode = $('importConflict').value, conflicts = importConflicts(pendingImport), sourceCount = pendingImport.reduce((n, topic) => n + topic.sources.length, 0);
  transferStatus(`Импортирую ${pendingImport.length} тем и ${sourceCount} источников…`);
  $('runImport').disabled = true;
  const before = topics, next = topics.map(topic => ({ ...topic, sources: [...topic.sources] }));
  try {
    for (const item of pendingImport) {
      const existing = next.find(topic => topic.name.toLocaleLowerCase() === item.name.toLocaleLowerCase());
      if (existing) {
        if (mode === 'skip') continue;
        if (mode === 'replace') {
          existing.enabled = item.enabled;
          existing.sources = item.sources.map(source => { const added = { ...source }; indexedChunks(existing, added); return added; });
        }
        else {
          const seen = new Map();
          for (const source of existing.sources) { const key = (source.title || '').toLocaleLowerCase(); if (!seen.has(key)) seen.set(key, []); seen.get(key).push(source.content); }
          for (const source of item.sources) {
            const key = source.title.toLocaleLowerCase(), sameTitle = seen.get(key) || [];
            if (sameTitle.includes(source.content)) continue;
            const added = { ...source }; indexedChunks(existing, added); existing.sources.push(added); sameTitle.push(source.content); seen.set(key, sameTitle);
          }
        }
      } else {
        const added = { id: topicId(), name: item.name, enabled: item.enabled, sources: [] };
        added.sources = item.sources.map(source => { const copy = { ...source }; indexedChunks(added, copy); return copy; }); next.push(added);
      }
    }
    topics = next; selectedTopicId ||= topics.find(topic => topic.enabled)?.id || topics[0]?.id || '';
    renderSources(); await persist();
    transferStatus('Импорт завершён.'); pendingImport = null; $('runImport').disabled = true;
  } catch (err) {
    topics = before; renderSources(); $('runImport').disabled = !pendingImport?.length; transferStatus(`Импорт не сохранён: ${err.message || err}`, true);
  }
};
$('exportScope').onchange = e => { $('exportTopicField').hidden = e.target.value !== 'current'; };
$('downloadExport').onclick = () => {
  const selected = $('exportScope').value === 'current' ? topics.filter(topic => topic.id === $('exportTopic').value) : topics;
  if (!selected.length) { transferStatus('Нет тем для экспорта.', true); return; }
  const name = selected.length === 1 ? selected[0].name.replace(/[<>:"/\\|?*]/g, '_').slice(0, 80) : 'assist-knowledge-base';
  downloadJson(`${name || 'assist-knowledge'}.json`, { format: 'assist-knowledge-base', version: 1, exportedAt: new Date().toISOString(), topics: selected.map(({ name, enabled, sources }) => ({ name, enabled, sources: sources.map(source => ({ title: source.title, type: source.type, content: source.content, ...(source.archived !== undefined || historySourceTitle(source.title) ? { archived: sourceIsArchived(source) } : {}), aiPriority: Number(source.aiPriority) || 0, answerUsageCount: Number(source.answerUsageCount) || 0 })) })) });
  transferStatus(`Экспортировано тем: ${selected.length}.`);
};
$('sourceSearch').oninput = () => { clearTimeout(window.sourceSearchTimer); window.sourceSearchTimer = setTimeout(() => renderSearchResults(), 80); };
$('histSearch').oninput = e => renderHistory(e.target.value);
$('clearHistory').onclick = async () => { if (!confirm('Удалить всю историю диалогов?')) return; history = []; renderHistory($('histSearch').value); await persist(); };
$('send').onclick = () => send(); input.onkeydown = e => { if (e.key === 'Enter') send(); };
$('stop').onclick = stopMessages;
$('newChat').onclick = () => { stopMessages(); conversation.length = 0; log.replaceChildren(); addMsg('sys', 'Новый чат. История прошлых вопросов сохранена во вкладке «История».'); input.value = ''; };
$('minimizebtn').onclick = () => window.assist.minimize();
$('closebtn').onclick = () => { stopAudioCapture(); window.assist.close(); };
window.addEventListener('online', () => { if (apiState === 'offline') apiState = 'unknown'; updateOnline(); }); window.addEventListener('offline', updateOnline);
let capturing = '';
async function finishHotkeyCapture(value) {
  if (!capturing || !value) return;
  clearTimeout(captureTimer);
  const target = capturing, field = $(target === 'overlay' ? 'hkCapture' : 'cursorHkCapture');
  const setting = target === 'overlay' ? 'hotkey' : 'cursorHotkey', previous = settings[setting];
  settings[setting] = value; capturing = ''; field.classList.remove('rec');
  const ok = await window.assist.setHotkeys(settings.hotkey, settings.cursorHotkey);
  if (!ok) { settings[setting] = previous; alert('Эта клавиша занята или не поддерживается. Прежний бинд восстановлен.'); }
  else { persistedHotkeys = { hotkey: settings.hotkey, cursorHotkey: settings.cursorHotkey }; await persist().catch(err => addMsg('err', `Бинд применён, но не сохранён: ${err.message || err}`)); }
  field.textContent = `${settings[setting]} — нажмите, чтобы изменить`;
  if (target === 'overlay') $('hkChip').textContent = settings.hotkey;
  else $('f1ModeChip').textContent = `${settings.cursorHotkey}: ${document.documentElement.classList.contains('mouse-disabled') ? 'Игра' : 'Assist'}`;
  await window.assist.setHotkeyCapture(false);
}
async function cancelHotkeyCapture() {
  if (!capturing) return;
  clearTimeout(captureTimer);
  const field = $(capturing === 'overlay' ? 'hkCapture' : 'cursorHkCapture');
  field.classList.remove('rec'); field.textContent = `${settings[capturing === 'overlay' ? 'hotkey' : 'cursorHotkey']} — нажмите, чтобы изменить`;
  capturing = ''; await window.assist.setHotkeyCapture(false);
}
function beginHotkeyCapture(target) {
  capturing = target; const field = $(target === 'overlay' ? 'hkCapture' : 'cursorHkCapture');
  field.classList.add('rec'); field.textContent = 'Нажмите клавишу или кнопку мыши…';
  clearTimeout(captureTimer); captureTimer = setTimeout(() => { void cancelHotkeyCapture(); }, 10000);
  void window.assist.setHotkeyCapture(true).catch(err => { clearTimeout(captureTimer); capturing = ''; field.classList.remove('rec'); addMsg('err', `Не удалось начать запись бинда: ${err.message || err}`); });
}
$('hkCapture').onclick = () => beginHotkeyCapture('overlay');
$('cursorHkCapture').onclick = () => beginHotkeyCapture('cursor');
window.assist.onHotkeyCaptured(value => {
  if (!capturing) return;
  if (value === 'Escape') void cancelHotkeyCapture(); else void finishHotkeyCapture(value);
});
function pcmToWav(parts, sourceRate) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  if (!length) return null;
  const pcm = new Float32Array(length); let offset = 0;
  for (const part of parts) { pcm.set(part, offset); offset += part.length; }
  const rate = 16000, frames = Math.ceil(length * rate / sourceRate);
  const wav = new ArrayBuffer(44 + frames * 2), view = new DataView(wav);
  const str = (offset, value) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  str(0, 'RIFF'); view.setUint32(4, 36 + frames * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) {
    const at = i * sourceRate / rate, left = Math.floor(at), frac = at - left;
    const sample = Math.max(-1, Math.min(1, pcm[left] * (1 - frac) + (pcm[Math.min(left + 1, length - 1)] || 0) * frac));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
  }
  return new Blob([wav], { type: 'audio/wav' });
}
function transcribe(blob) {
  if (!blob || blob.size < 2500 || Date.now() < transcriptionCooldownUntil) return;
  if (audioQueue.length >= 5) { addMsg('err', 'Очередь распознавания заполнена — произнесите фразу чуть позже.'); return; }
  audioQueue.push(blob); void drainTranscriptions();
}
function finalizeAudioSegment(session) {
  if (!session.speaking || !session.pcmParts.length) return;
  session.speaking = false;
  const parts = session.pcmParts; session.pcmParts = [];
  transcribe(pcmToWav(parts, session.context.sampleRate));
}
async function drainTranscriptions() {
  if (transcriptionBusy) return;
  transcriptionBusy = true;
  try {
    while (audioQueue.length) {
      if (Date.now() < transcriptionCooldownUntil) { if (audioQueue.length) addMsg('sys', 'Распознавание временно приостановлено из-за лимита сервиса; очередь очищена.'); audioQueue.length = 0; break; }
      const wav = audioQueue.shift();
      try {
        if (wav.size < 44 + 16000 * 2 * 0.8) continue;
        const bytes = new Uint8Array(await wav.arrayBuffer()); let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        const text = await window.assist.transcribe({ settings, audio: btoa(binary), mimeType: 'audio/wav' });
        if (!text) { addMsg('sys', 'Фрагмент получен, но речь не распознана.'); continue; }
        addMsg('sys', `Распознано: ${text}`);
        if (clearQuestion(text) || isClarification(text)) await send(text);
      } catch (err) {
        addMsg('err', `Распознавание: ${err.message || err}`);
        if (/HTTP\s+429|high demand|quota|resource_exhausted/i.test(err.message || '')) { const wait = Number((err.message || '').match(/retry\s+in\s+([\d.]+)/i)?.[1]) || 15; transcriptionCooldownUntil = Date.now() + Math.min(60, wait) * 1000; audioQueue.length = 0; }
        if (/HTTP\s+(?:401|403)|PermissionDenied|Permission EXEC denied|unauthori[sz]ed|permission denied/i.test(err.message || '')) { audioQueue.length = 0; stopAudioCapture(); }
      }
    }
  } finally { transcriptionBusy = false; if (audioQueue.length) void drainTranscriptions(); }
}
function stopAudioCapture() {
  if (!audioSession) return;
  listening = false; $('mic').classList.remove('live'); $('waveform').classList.remove('on'); $('mic').title = 'Голосовой ввод';
  finalizeAudioSegment(audioSession);
  audioSession.processor.disconnect(); audioSession.inputNode.disconnect(); audioSession.silentGain.disconnect();
  audioSession.loopback?.stop();
  for (const stream of audioSession.streams) stream.getTracks().forEach(track => track.stop());
  audioSession.context.close().catch(() => {}); audioSession = null;
}
function connectSystemAudio(context, destination) {
  let cursor = context.currentTime;
  const unsubscribe = window.assist.onSystemAudioData(data => {
    if (context.state === 'closed') return;
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : new Uint8Array(data?.buffer || 0);
    const frames = Math.floor(bytes.byteLength / 4);
    if (!frames) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, frames * 4), left = new Float32Array(frames), right = new Float32Array(frames);
    for (let i = 0; i < frames; i++) { left[i] = view.getInt16(i * 4, true) / 32768; right[i] = view.getInt16(i * 4 + 2, true) / 32768; }
    const buffer = context.createBuffer(2, frames, 48000);
    buffer.copyToChannel(left, 0); buffer.copyToChannel(right, 1);
    const source = context.createBufferSource(), gain = context.createGain();
    source.buffer = buffer; gain.gain.value = 0.5; source.connect(gain).connect(destination);
    source.onended = () => { source.disconnect(); gain.disconnect(); };
    const startAt = Math.max(context.currentTime + 0.01, cursor);
    source.start(startAt); cursor = startAt + buffer.duration;
  });
  return {
    start: () => window.assist.startSystemAudio(),
    stop: async () => { unsubscribe(); await window.assist.stopSystemAudio().catch(() => {}); }
  };
}
async function startAudioCapture() {
  if (listening || audioSession) return;
  if (Object.keys(audioChecks).length) { addMsg('sys', 'Сначала остановите проверку устройства, затем включите распознавание.'); return; }
  const mode = $('audioMode').value;
  const streams = []; let context, loopback;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Захват аудио недоступен в среде приложения. Перезапустите приложение.');
    if (mode !== 'system') {
      const constraints = { audio: settings.inputDevice && settings.inputDevice !== 'default' ? { deviceId: { exact: settings.inputDevice }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } : { echoCancellation: false, noiseSuppression: false, autoGainControl: false } };
      try { streams.push(await navigator.mediaDevices.getUserMedia(constraints)); }
      catch (err) {
        if (!settings.inputDevice || err.name !== 'OverconstrainedError') throw err;
        settings.inputDevice = ''; await persist(); addMsg('sys', 'Сохранённый микрофон больше недоступен; переключаюсь на системный.');
        streams.push(await navigator.mediaDevices.getUserMedia({ audio: true }));
      }
    }
    context = new AudioContext(); await context.resume();
    const mixed = context.createMediaStreamDestination();
    streams.forEach(stream => { const source = context.createMediaStreamSource(stream); const gain = context.createGain(); gain.gain.value = 0.5; source.connect(gain).connect(mixed); });
    if (mode !== 'mic') {
      loopback = connectSystemAudio(context, mixed);
      try { await loopback.start(); }
      catch (err) {
        await loopback.stop(); loopback = null;
        if (mode === 'system') throw err;
        addMsg('sys', `Захват звука компьютера недоступен, продолжу с микрофоном: ${err.message || err}`);
      }
    }
    const processor = context.createScriptProcessor(2048, 2, 1), inputNode = context.createMediaStreamSource(mixed.stream), silentGain = context.createGain();
    silentGain.gain.value = 0; inputNode.connect(processor); processor.connect(silentGain).connect(context.destination);
    const preRoll = []; let lastVoice = 0, segmentStart = 0;
    // Higher slider value means greater sensitivity and therefore a lower RMS threshold.
    const threshold = 0.004 + ((100 - Number(settings.sensitivity ?? 70)) / 100) * 0.022;
    const silencePause = settings.delay?.startsWith('Минимальная') ? 500 : settings.delay?.startsWith('Сбалансированная') ? 1800 : 1000;
    const captureStarted = Date.now(); let signalDetected = false, signalWarningShown = false;
    const session = audioSession = { streams, context, processor, inputNode, silentGain, loopback, speaking: false, pcmParts: [] };
    processor.onaudioprocess = event => {
      if (!listening) return;
      const audio = event.inputBuffer, channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
      if (!channels.length || !audio.length) return;
      const mono = new Float32Array(audio.length); let power = 0;
      for (let i = 0; i < mono.length; i++) { for (const channel of channels) mono[i] += channel[i] / channels.length; power += mono[i] * mono[i]; }
      const level = Math.sqrt(power / mono.length), now = Date.now();
      if (level > threshold) {
        signalDetected = true;
        lastVoice = now;
        if (!session.speaking) { session.speaking = true; session.pcmParts = [...preRoll]; segmentStart = now; }
      }
      if (session.speaking) session.pcmParts.push(mono);
      preRoll.push(mono); if (preRoll.length > Math.ceil(context.sampleRate * 0.5 / mono.length)) preRoll.shift();
      if (level <= threshold && session.speaking && now - lastVoice > silencePause) finalizeAudioSegment(session);
      if (session.speaking && now - segmentStart > 20000) finalizeAudioSegment(session);
      if (!signalDetected && !signalWarningShown && now - captureStarted > 15000) {
        signalWarningShown = true;
        const hint = mode === 'system' ? 'Проверьте, что звук воспроизводится через текущее устройство вывода Windows.' : mode === 'both' ? 'Проверьте выбранный микрофон и воспроизведение звука компьютера.' : 'Проверьте выбранный микрофон и разрешение микрофона Windows.';
        addMsg('sys', `Пока сигнал не обнаружен; прослушивание продолжается. ${hint}`);
      }
    };
    listening = true; $('mic').classList.add('live'); $('waveform').classList.add('on'); $('mic').title = 'Остановить прослушивание';
    addMsg('sys', mode === 'both' ? 'Слушаю микрофон и звук компьютера. Явный вопрос отправится автоматически.' : 'Слушаю. Явный вопрос отправится автоматически.');
  } catch (err) {
    audioSession?.processor?.disconnect(); audioSession?.inputNode?.disconnect(); audioSession?.silentGain?.disconnect();
    audioSession = null;
    await loopback?.stop();
    streams.forEach(stream => stream.getTracks().forEach(track => track.stop()));
    await context?.close().catch(() => {});
    listening = false; $('mic').classList.remove('live'); $('waveform').classList.remove('on');
    const hint = err.name === 'NotAllowedError' ? ' Проверьте разрешение микрофона для классических приложений в параметрах конфиденциальности Windows и разрешите захват экрана.' : '';
    addMsg('err', `Не удалось включить аудио: ${err.message || err}.${hint}`);
  }
}
$('mic').onclick = () => { if (listening) stopAudioCapture(); else startAudioCapture(); };
async function refreshAudioDevices(askPermission = false) {
  const inputSelect = $('inputDevice'), selected = settings.inputDevice || '';
  if (askPermission) {
    const permission = await navigator.mediaDevices.getUserMedia({ audio: true }); permission.getTracks().forEach(t => t.stop());
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  inputSelect.replaceChildren(new Option('Системный микрофон', ''));
  devices.filter(d => d.kind === 'audioinput').forEach((d, i) => inputSelect.add(new Option(d.label || `Микрофон ${i + 1}`, d.deviceId)));
  inputSelect.value = selected;
  if (selected && inputSelect.value !== selected) inputSelect.value = '';
  const outputs = await window.assist.audioOutputs();
  const outputSelect = $('outputDevice'); outputSelect.replaceChildren(new Option('Текущий вывод Windows', '', true, false)); outputSelect.options[0].disabled = true;
  outputs.forEach(device => outputSelect.add(new Option(`${device.name}${device.isDefault ? ' · по умолчанию' : ''}`, device.id)));
  outputSelect.value = settings.outputDevice || outputs.find(d => d.isDefault)?.id || '';
}
$('inputDevice').onchange = async e => { settings.inputDevice = e.target.value; await persist(); };
$('audioMode').onchange = async e => { settings.audioMode = e.target.value; await persist(); };
$('checkMic').onclick = () => toggleAudioCheck('mic');
$('checkSystem').onclick = () => toggleAudioCheck('system');
const audioChecks = {};
async function toggleAudioCheck(kind) {
  const button = $(kind === 'mic' ? 'checkMic' : 'checkSystem'), meter = $(kind === 'mic' ? 'micLevel' : 'systemLevel');
  if (audioChecks[kind]) {
    const state = audioChecks[kind]; delete audioChecks[kind];
    clearInterval(state.timer); state.stream?.getTracks().forEach(track => track.stop());
    await state.loopback?.stop();
    await state.context.close().catch(() => {});
    meter.style.width = '0'; button.textContent = kind === 'mic' ? 'Проверить микрофон' : 'Проверить звук'; return;
  }
  if (listening || audioSession) { addMsg('sys', 'Сначала остановите голосовое прослушивание, затем проверяйте устройство.'); return; }
  let stream, context, loopback;
  try {
    if (kind === 'mic') {
      const deviceId = settings.inputDevice;
      stream = await navigator.mediaDevices.getUserMedia({ audio: { ...(deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : {}), echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    }
    context = new AudioContext(); await context.resume();
    const analyser = context.createAnalyser(); analyser.fftSize = 512;
    if (kind === 'mic') context.createMediaStreamSource(stream).connect(analyser);
    else { loopback = connectSystemAudio(context, analyser); await loopback.start(); }
    const samples = new Uint8Array(analyser.fftSize);
    const state = { stream, context, loopback, timer: setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0; for (const sample of samples) { const value = (sample - 128) / 128; sum += value * value; }
      meter.style.width = `${Math.min(100, Math.sqrt(sum / samples.length) * 350)}%`;
    }, 50) };
    audioChecks[kind] = state;
    button.textContent = 'Остановить проверку';
    stream?.getTracks().forEach(track => track.addEventListener('ended', () => { if (audioChecks[kind] === state) toggleAudioCheck(kind); }, { once: true }));
  } catch (err) {
    stream?.getTracks().forEach(track => track.stop());
    await loopback?.stop(); await context?.close().catch(() => {});
    meter.style.width = '0'; button.textContent = kind === 'mic' ? 'Проверить микрофон' : 'Проверить звук';
    addMsg('err', `Проверка ${kind === 'mic' ? 'микрофона' : 'системного звука'}: ${err.message || err}`);
  }
}
function updateSttSettings(provider) { $('yandexStt').hidden = provider !== 'yandex'; $('googleSpeechField').hidden = provider !== 'googleCloud'; }
$('sttProvider').onchange = async e => { settings.sttProvider = e.target.value; updateSttSettings(e.target.value); await persist(); };
$('voiceLanguage').onchange = async e => { settings.voiceLanguage = e.target.value; await persist(); };
$('googleSpeechBrowse').onclick = async () => {
  try { const file = await window.assist.chooseGoogleCredentials(); if (file) { settings.googleSpeechCredentialsPath = file; $('googleSpeechCredentialsPath').value = file; await persist(); } }
  catch (err) { addMsg('err', `Не удалось выбрать Google Cloud credentials: ${err.message || err}`); }
};
$('theme').onchange = async e => { settings.theme = e.target.value; applyTheme(settings.theme); await persist(); };
$('applyWindowSize').onclick = async () => {
  const widthText = $('windowWidth').value.trim(), heightText = $('windowHeight').value.trim();
  if (!/^\d+$/.test(widthText) || !/^\d+$/.test(heightText)) { alert('Введите ширину и высоту целыми числами.'); return; }
  const width = Number(widthText), height = Number(heightText);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 600 || width > 3840 || height < 500 || height > 2160) { alert('Укажите ширину 600–3840 и высоту 500–2160 пикселей.'); return; }
  try {
    const applied = await window.assist.setSize(width, height);
    settings.windowWidth = applied.width; settings.windowHeight = applied.height;
    await persist();
    $('windowWidth').value = applied.width; $('windowHeight').value = applied.height;
  }
  catch (err) { alert(`Не удалось изменить размер окна: ${err.message || err}`); }
};
$('resetWindowSize').onclick = async () => {
  try {
    const applied = await window.assist.setSize(960, 760);
    settings.windowWidth = applied.width; settings.windowHeight = applied.height;
    await persist();
    $('windowWidth').value = applied.width; $('windowHeight').value = applied.height;
  }
  catch (err) { alert(`Не удалось восстановить размер окна: ${err.message || err}`); }
};
$('resetApp').onclick = async () => {
  if (!confirm('СБРОСИТЬ ПРИЛОЖЕНИЕ? Будут безвозвратно удалены все настройки и API-ключи, источники и история диалогов. Продолжить?')) return;
  await window.assist.reset(); location.reload();
};
$('outputDevice').onchange = async e => {
  try { await window.assist.setAudioOutput(e.target.value); settings.outputDevice = e.target.value; await persist(); addMsg('sys', 'Системный вывод Windows переключён.'); }
  catch (err) { addMsg('err', `Не удалось выбрать наушники: ${err.message || err}`); await refreshAudioDevices().catch(() => {}); }
};
$('refreshAudio').onclick = async () => { try { await refreshAudioDevices(true); addMsg('sys', 'Список устройств обновлён.'); } catch (err) { addMsg('err', `Не удалось обновить устройства: ${err.message || err}`); } };
(async () => {
  try {
  if (!window.assist?.load) throw new Error('Electron preload недоступен. Перезапустите приложение из исходников; проверьте путь preload.js.');
  data = await window.assist.load(); settings = { ...data.settings }; delete settings.webFallback; delete settings.searchDictionary;
  corrections = Array.isArray(data.corrections) ? data.corrections : [];
  topics = Array.isArray(data.topics) ? data.topics.filter(topic => topic && typeof topic === 'object').map(topic => ({ ...topic, sources: (Array.isArray(topic.sources) ? topic.sources : []).filter(source => source && typeof source === 'object').map(source => ({ ...source, aiPriority: Math.max(-1, Math.min(2, Number(source.aiPriority) || 0)) })) })) : [];
  history = Array.isArray(data.history) ? data.history : [];
  try {
    const storage = await window.assist.secretStorageStatus();
    if (storage.locked) addMsg('err', 'Windows не смогла расшифровать сохранённый API-ключ. Введите ключ заново в настройках; старое зашифрованное значение сохранено.');
    else if (!storage.available && (settings.apiKey || settings.sttApiKey)) addMsg('err', 'Защищённое хранилище Windows недоступно. API-ключи могут храниться в файле приложения без шифрования.');
  } catch (error) { console.warn('Could not inspect secure storage availability:', error); }
  $('windowWidth').value = settings.windowWidth || 960; $('windowHeight').value = settings.windowHeight || 760;
  settings.theme ||= 'purple'; $('theme').value = settings.theme; applyTheme(settings.theme);
  const savedSensitivity = Number(settings.sensitivity); settings.sensitivity = Number.isFinite(savedSensitivity) ? Math.min(100, Math.max(0, savedSensitivity)) : 70;
  settings.audioMode ||= 'both'; settings.opacity ??= 90; settings.streamProof ??= false;
  for (const id of ['apiKey', 'model', 'endpoint']) $(id).value = settings[id] || '';
  $('lang').value = settings.lang || 'auto'; $('verbosity').value = settings.verbosity || 'Суть (коротко)'; delete settings.reasoningEffort; $('delay').value = settings.delay || 'Быстрая (~1с)';
  $('sensitivity').value = settings.sensitivity ?? 70; $('sensVal').textContent = $('sensitivity').value;
  $('audioMode').value = settings.audioMode || 'both';
  settings.sttProvider ||= 'auto'; if (settings.sttProvider === 'salute' || settings.sttProvider === 'google') settings.sttProvider = 'auto'; delete settings.sttScope; $('sttProvider').value = settings.sttProvider; $('sttApiKey').value = settings.sttApiKey || ''; $('googleSpeechCredentialsPath').value = settings.googleSpeechCredentialsPath || ''; updateSttSettings(settings.sttProvider);
  settings.voiceLanguage ||= 'ru-RU'; $('voiceLanguage').value = settings.voiceLanguage;
  $('playerRole').value = settings.playerRole || ''; $('gameProject').value = settings.gameProject || ''; $('customPrompt').value = settings.customPrompt || '';
  $('opacity').value = settings.opacity; $('opacityVal').textContent = settings.opacity;
  document.querySelectorAll('.switch').forEach(sw => sw.classList.toggle('on', !!settings[sw.dataset.key]));
  $('latLabel').style.display = '';
  settings.hotkey ||= 'Ctrl+Shift+A'; settings.cursorHotkey ||= 'F1'; persistedHotkeys = { hotkey: settings.hotkey, cursorHotkey: settings.cursorHotkey };
  $('hkChip').textContent = settings.hotkey; $('hkCapture').textContent = `${settings.hotkey} — нажмите, чтобы изменить`;
  $('cursorHkCapture').textContent = `${settings.cursorHotkey} — нажмите, чтобы изменить`;
  $('f1ModeChip').textContent = `${settings.cursorHotkey}: ${document.documentElement.classList.contains('mouse-disabled') ? 'Игра' : 'Assist'}`;
  renderSources(); renderHistory(); updateOnline(); await window.assist.setHotkeys(settings.hotkey, settings.cursorHotkey);
  const warmRetrievalIndex = () => { if (!retrievalCorpusCache) sourceMatches('', enabledSources()); };
  if (enabledSources().length) {
    if (window.requestIdleCallback) window.requestIdleCallback(warmRetrievalIndex, { timeout: 1500 });
    else setTimeout(warmRetrievalIndex, 250);
  }
  await window.assist.setOpacity(settings.opacity); await window.assist.setStreamProof(!!settings.streamProof);
  if (settings.checkApiOnStartup) setTimeout(() => checkApi().catch(err => { setApiStateFromError(err); addMsg('err', `Автопроверка API: ${err.message || err}`); }), 0);
  try { await refreshAudioDevices(); } catch (err) { addMsg('sys', `Список аудио устройств недоступен: ${err.message || err}`); }
  } catch (err) { addMsg('err', `Не удалось загрузить настройки: ${err.message || err}`); }
})();

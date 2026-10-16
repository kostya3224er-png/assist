const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
const questions = fs.readFileSync(path.join(root, 'tests/fixtures/test_questions_50.md'), 'utf8');
const scenarios = fs.readFileSync(path.join(root, 'tests/fixtures/rp_scenarios.md'), 'utf8');
const block = (start, end) => {
  const i = src.indexOf(start);
  if (i < 0) throw new Error(`Missing source block: ${start}`);
  const j = src.indexOf(end, i);
  if (j < 0) throw new Error(`Missing source boundary: ${end}`);
  return src.slice(i, j);
};
const extracted = [
  block('function roleplayQuestion(q)', 'function retrievalQuestion(q'),
  block('function clearQuestion(q)', 'function noEvidenceAnswer(text)'),
  block('function splitQuestionParts(q)', 'function retrievalFocus(q)'),
  block('function userFacingAnswer(text, situational, useRu)', 'function retrievalDebug(q, matches')
].join('\n');
const ctx = { words: s => (s.toLowerCase().match(/[a-zа-яё0-9]{2,}/gi) || []), smallTalk: () => false };
vm.createContext(ctx);
vm.runInContext(`${extracted}\nglobalThis.api={actionOrRoleplayRequest,userFacingAnswer,splitQuestionParts};`, ctx);
const rows = questions.split(/\r?\n/).filter(line => /^\|\s*\d+\s*\|/.test(line)).map(line => {
  const fields = line.slice(1, -1).split('|');
  return { id: Number(fields[0].trim()), type: fields[1].trim(), q: fields[2].trim() };
});
const queryParts = ctx.api.splitQuestionParts('Сколько раз в день можно выдавать благодарность и какая команда используется для выдачи благодарности?');
if (queryParts.length !== 2 || !/сколько раз/i.test(queryParts[0]) || !/какая команда/i.test(queryParts[1])) throw new Error('The two-part /praise query was not split into both answerable parts.');
const cases = rows.filter(row => [36, 37, 42].includes(row.id));
for (const row of cases) if (ctx.api.actionOrRoleplayRequest(row.q)) throw new Error(`Factual rule question ${row.id} incorrectly classified as an action request: ${row.q}`);
for (const row of cases) { const answer = ctx.api.userFacingAnswer('Ответ по применимому правилу. [F1]', false, true); if (answer.insufficient || !answer.text.includes('[F1]')) throw new Error(`Question ${row.id} lost its source-backed answer.`); }
const factual = rows.find(row => row.id === 35);
if (!factual || ctx.api.actionOrRoleplayRequest(factual.q)) throw new Error('Question 35 must remain factual/non-situational.');
const scenarioRows = scenarios.split(/\r?\n/).filter(line => /^\|\s*[A-D]\s*\|/.test(line));
for (const line of scenarioRows) {
  const task = line.slice(1, -1).split('|')[1].trim();
  if (!ctx.api.actionOrRoleplayRequest(task)) throw new Error(`RP scenario not classified as situational: ${task}`);
}
const short = 'В источниках не нашёл ответа. Уточните вопрос или воспользуйтесь поиском по источникам.';
if (ctx.api.userFacingAnswer('[DATA_INSUFFICIENT] зарплата', false, true).text !== short) throw new Error('Factual insufficiency message is not the required concise one-liner.');
const safe = ctx.api.userFacingAnswer('[DATA_INSUFFICIENT] неизвестные детали и найденные фрагменты', true, true).text;
if (/DATA_INSUFFICIENT|неизвестные детали|фрагмент/i.test(safe)) throw new Error('Situational fallback leaks the marker or search terms.');
if (!src.includes("addMsg('bot', '…')")) throw new Error('Thinking indicator must remain an ellipsis.');
if (/Нашёл фрагменты|Ближайшие фрагменты/.test(src)) throw new Error('Chat retrieval excerpt UI is still present.');
if (src.includes('onSearch?.(')) throw new Error('Chat answer path still emits retrieval preview callback.');
console.log(`PASS: factual requests ${cases.map(x => x.id).join(', ')} remain evidence-based, RP scenarios ${scenarioRows.length}, factual question 35, marker sanitization, chat output constraints.`);

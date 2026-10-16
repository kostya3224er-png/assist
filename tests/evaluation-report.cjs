const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const reportPath = process.argv[2];
if (!reportPath) throw new Error('Usage: node tests/evaluation-report.cjs <ASSIST_REPORT.json>');
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const split = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/evaluation-splits.json'), 'utf8'));
const rows = report.questions || report.results;
if (!Array.isArray(rows)) throw new Error('Report must contain a questions/results array; generate it with ASSIST_REPORT first.');
const all = [...split.tuning, ...split.holdout];
if (new Set(all).size !== all.length || split.tuning.length !== 30 || split.holdout.length !== 20 || all.length !== 50) throw new Error('Evaluation split must contain 30 tuning and 20 unique holdout IDs.');
const known = new Set(rows.map(row => row.id));
if (all.some(id => !known.has(id))) throw new Error('The report does not include every fixed evaluation question.');
for (const group of ['tuning', 'holdout']) {
  const selected = rows.filter(row => split[group].includes(row.id) && row.type !== 'Н');
  const hit = selected.filter(row => row.hit5).length;
  const aiHit = selected.filter(row => row.aiDirectHit5).length;
  const timed = (report.searchMs?.perQuestion || []).filter(row => split[group].includes(row.id)).map(row => row.ms).sort((a, b) => a - b);
  const median = timed.length ? timed[Math.floor(timed.length / 2)] : NaN;
  console.log(`${group}: lexical hit@5 ${hit}/${selected.length} (${selected.length ? (hit / selected.length * 100).toFixed(1) : 'n/a'}%); AI-context direct hit@8 ${aiHit}/${selected.length} (${selected.length ? (aiHit / selected.length * 100).toFixed(1) : 'n/a'}%); retrieval median ${Number.isFinite(median) ? median.toFixed(1) + ' ms' : 'n/a'}`);
}
console.log('This report measures source retrieval only; it does not grade generated answer quality or API latency.');

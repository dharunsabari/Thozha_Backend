const path = require('path');
const { loadCorpusDir, topChunks } = require('./textCorpus');

// NISM Series XV Research Analyst workbook (Books_ref/Learn) — grounds
// markets / investing / financial-analysis questions in the real syllabus.
const LEARN_DIR = path.join(__dirname, '..', 'data', 'learn');
let corpus = null;
function getCorpus(){
  if(!corpus) corpus = loadCorpusDir(LEARN_DIR);
  return corpus;
}

const LEARN_TRIGGERS = [
  'research analyst', 'nism', 'sebi', 'equity', 'share price', 'stock', 'valuation', 'balance sheet',
  'profit and loss', 'cash flow', 'p/e', 'pe ratio', 'eps', 'dividend', 'mutual fund', 'debt market',
  'bond', 'derivative', 'option', 'futures', 'technical analysis', 'fundamental analysis', 'ratio',
  'market cap', 'ipo', 'sensex', 'nifty', 'intrinsic value', 'dcf', 'roe', 'roce', 'beta', 'portfolio'
];

function lastUserText(messages){
  for(let i = messages.length - 1; i >= 0; i--){
    if(messages[i].role !== 'user') continue;
    const c = messages[i].content;
    if(typeof c === 'string') return c;
    if(Array.isArray(c)) return c.filter(b => b.type === 'text').map(b => b.text).join(' ');
  }
  return '';
}

function learnReferenceBlockFor(messages){
  const text = lastUserText(messages);
  const lower = text.toLowerCase();
  if(!text || !LEARN_TRIGGERS.some(t => lower.includes(t))) return '';
  const lib = getCorpus();
  if(!lib.length) return '';
  const excerpts = topChunks(lib, text, 4, 1400, 5000);
  if(!excerpts) return '';
  return `Relevant passages from this app's own Learn library (NISM Series XV Research Analyst workbook, machine-extracted so may be slightly garbled). Use them to teach the concept accurately and completely in your own words. This is education only, never personalised investment advice:\n${excerpts}`;
}

module.exports = { learnReferenceBlockFor };

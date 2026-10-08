const fs = require('fs');
const path = require('path');

// Loads every .txt file in a directory into memory once, keyed by a
// display name derived from the filename — this is where the app's book
// and journal reference material actually lives; the app itself never
// fetches or holds any of it.
function loadCorpusDir(dirPath){
  const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.txt'));
  return files.map(f => ({
    name: path.basename(f, '.txt'),
    text: fs.readFileSync(path.join(dirPath, f), 'utf-8')
  }));
}

// Finds one excerpt per keyword (first match, first source that has it,
// case-insensitive), trimmed to a small window around the hit, capped by a
// total character budget so a reply prompt never balloons in size.
function excerptsFromCorpus(corpus, keywords, windowSize, totalBudget){
  const parts = [];
  let used = 0;
  for(const kw of keywords){
    if(!kw || used >= totalBudget) continue;
    for(const src of corpus){
      if(!src.text) continue;
      const idx = src.text.toLowerCase().indexOf(kw.toLowerCase());
      if(idx === -1) continue;
      const start = Math.max(0, idx - 40);
      const end = Math.min(src.text.length, idx + windowSize);
      const snippet = src.text.slice(start, end).replace(/\s+/g, ' ').trim();
      parts.push(`[${src.name} — ${kw}] …${snippet}…`);
      used += snippet.length;
      break;
    }
  }
  return parts.join('\n');
}

// Ranks fixed-size chunks across the whole corpus by how many of the query's
// distinct words they contain (rarer words weigh more) and returns the best
// few. Better than first-match excerpts when the question is free text.
const STOP = new Set(['the','a','an','and','or','of','to','in','is','are','what','how','why','do','does','for','on','with','me','my','i','you','it','this','that','about','tell','explain','please','can','be','as','at','by']);
function topChunks(corpus, query, count, chunkSize, totalBudget){
  const words = Array.from(new Set((query.toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter(w => !STOP.has(w))));
  if(!words.length) return '';
  const best = [];
  for(const src of corpus){
    const lower = src.text.toLowerCase();
    // Skip words absent from this source; weight the rest by rarity.
    const present = words.filter(w => lower.includes(w));
    if(!present.length) continue;
    for(let pos = 0; pos < src.text.length; pos += chunkSize){
      const chunk = lower.slice(pos, pos + chunkSize);
      if(/\.{8,}/.test(chunk)) continue; // table-of-contents / index pages
      let score = 0;
      for(const w of present){
        let i = chunk.indexOf(w);
        if(i !== -1) score += 1 + Math.min(3, w.length / 4);
      }
      if(score >= 3) best.push({ score, name: src.name, pos, size: chunkSize, text: src.text });
    }
  }
  best.sort((a, b) => b.score - a.score);
  const parts = [];
  let used = 0;
  for(const b of best.slice(0, count)){
    const snippet = b.text.slice(b.pos, b.pos + b.size).replace(/\s+/g, ' ').trim();
    if(used + snippet.length > totalBudget) break;
    parts.push(`[${b.name}] …${snippet}…`);
    used += snippet.length;
  }
  return parts.join('\n');
}

module.exports = { loadCorpusDir, excerptsFromCorpus, topChunks };

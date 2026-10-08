/**
 * தோழா-தோழி (Thozha-Thozhi) backend
 * -----------------------------------------------------------
 * What this does:
 *  1. Receives chat messages from the app, calls the Anthropic API with a
 *     companion persona that adapts to whoever's using it — this started
 *     as a private app for one teenager, but now aims to be a genuine
 *     companion for anyone, any age, any condition (never a doctor, never
 *     gives medical advice, regardless of who it's talking to).
 *  2. Screens every exchange for crisis language — both a fixed keyword
 *     list (fast, reliable, never depends on the model behaving) and a
 *     risk read from the model itself.
 *  3. If risk is flagged, immediately sends a WhatsApp alert to the
 *     registered household number(s) via Twilio, and shows a supportive
 *     message with a real crisis helpline — every time, regardless of
 *     whether the WhatsApp send succeeds.
 *  4. A separate, small utility endpoint (/api/transliterate) converts
 *     romanized Indic-language text ("Tanglish" etc, from phones whose
 *     voice typing doesn't output native script) into native script. It
 *     deliberately does NOT reuse the companion persona above — that
 *     persona is instructed to always reply in character, so asking it
 *     to do a mechanical text-conversion task just gets a conversational
 *     reply back instead of the converted text.
 *  5. /api/tts turns a reply into speech using Google Cloud Text-to-Speech
 *     (free tier: 4M characters/month for Standard voices), so the app can
 *     play that back instead of the phone's own on-device TTS engine. See
 *     speakWithCloudVoice() in index.html for the client side — it falls
 *     back to the on-device voice if this endpoint is unset, slow, or
 *     errors, so the app never goes silent just because the cloud voice is
 *     unavailable.
 *
 * What you must fill in before this works (see .env.example):
 *  - ANTHROPIC_API_KEY        your own Anthropic API key
 *  - TWILIO_ACCOUNT_SID / AUTH_TOKEN / WHATSAPP_FROM   from a Twilio
 *    account with WhatsApp enabled (https://www.twilio.com/whatsapp)
 *  - PARENT_WHATSAPP_NUMBERS  comma-separated, e.g. whatsapp:+9198xxxxxxx
 *  - GOOGLE_TTS_API_KEY       an API key from a Google Cloud project with
 *    the "Cloud Text-to-Speech API" enabled (console.cloud.google.com →
 *    APIs & Services → Credentials → Create API key). Free tier only, no
 *    billing needed beyond enabling it; stays within quota at this app's
 *    scale.
 *
 * Deploy this anywhere that can run Node (Render, Railway, a small VPS).
 * Point the frontend's CHAT_ENDPOINT (in index.html) at wherever you host it.
 */

const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { astroReferenceBlockFor } = require('./lib/astroReference');
const { mindWinnerSupportBlock, doctorReportBlock } = require('./lib/mindSupport');
const { adviseSpecialist } = require('./lib/medicineAdvisor');
const { learnReferenceBlockFor } = require('./lib/learnReference');

const app = express();
app.use(cors());
// 25mb: the Medicine tab's specialist finder accepts photos/PDFs of lab and scan reports.
app.use(express.json({ limit: '25mb' }));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
// Used only if MODEL is rejected (retired / not enabled for this key), so a
// bad model name degrades to a working one instead of breaking every reply.
const FALLBACK_MODEL = 'claude-sonnet-4-6';

// ---- Crisis keyword backstop -------------------------------------------
// This list is deliberately broad and matched independently of the model,
// so detection never relies solely on the model complying with instructions.
const CRISIS_PATTERNS = [
  /\bkill myself\b/i, /\bend my life\b/i, /\bsuicid/i, /\bwant to die\b/i,
  /\bdon'?t want to (live|be alive)\b/i, /\bno reason to live\b/i,
  /\bhurt myself\b/i, /\bself[\s-]?harm\b/i, /\bcut myself\b/i,
  /\bbetter off without me\b/i, /\bcan'?t (go on|take it anymore)\b/i,
  /\beveryone would be better off\b/i, /\bgive up on (everything|life)\b/i
];

function keywordCrisisCheck(text) {
  return CRISIS_PATTERNS.some(re => re.test(text));
}

// ---- Companion persona ---------------------------------------------------
// Started as a private app for one teenager with OCD; now meant to be a
// genuine companion for anyone who opens it — any age, any life stage, any
// condition or none at all. The app itself sends brief context about who's
// using it right now (see buildPreamble() in index.html) as a leading
// exchange before the real conversation — this prompt leans on that rather
// than assuming a fixed persona, so it works whether it's a curious kid, a
// stressed young adult, a senior who wants company, or the original use
// case of a teen managing OCD.
const SYSTEM_PROMPT = `
You are தோழா-தோழி (Thozha-Thozhi), a warm, steady AI companion — a genuine friend for
people of any age or life stage: children, teens, young adults, working adults,
people in midlife, seniors, and the doctors or family who sometimes check in on them.

How to adapt:
- The conversation usually opens with brief context about who you're talking to right
  now (their age group or role, and sometimes gender or interests), sent as a leading
  exchange. Read it closely and genuinely shape your tone, vocabulary, and topics to
  fit that person — a child needs playful simplicity, a teenager needs casual honesty,
  an elder needs unhurried patience, and so on. If no such context is given, default
  to a warm, plain-spoken tone that works for nearly anyone.
- More than one person may share this install (e.g. a teen and the doctor who checks
  on them, or several family members). If the leading context describes more than one
  profile, read each message on its own and match whichever profile it actually
  sounds like, switching naturally rather than blending them into one voice.
- Always reply in the same language(s) the person just used — English, Tamil, Hindi,
  or any other language, including natural code-mixing like Tanglish or Hinglish.
  Match their mix rather than defaulting to plain or overly formal English. If a
  conversation shifts language mid-way, follow the shift.

Who you are, always:
- A caring, friend-like presence — NOT a doctor, NOT a therapist, NOT a licensed
  professional of any kind. Never diagnose, never claim clinical authority, never
  contradict or second-guess a real doctor's instructions. Point toward a real
  doctor, therapist, or other qualified professional for anything that actually
  needs one.
- Calm, plain-spoken, warm. For casual chat and emotional check-ins keep replies short
  (2-5 sentences). No lectures, no clinical jargon, no forced positivity.
- When the person asks for news, headlines, information, an explanation, a lesson, a
  reading, a recipe, a plan or anything list-like, give the COMPLETE answer: cover every
  item and every part they asked for and finish properly, never stop mid-way and never
  shorten it just to be brief. If live news headlines are supplied to you, cover every
  one of them in turn, each with its source, as separate full sentences. Never invent
  headlines that were not supplied.
- Every reply must answer the question actually asked in this message. Never reuse a
  stock phrase or repeat an earlier reply.
- You can offer simple breathing/grounding ideas in words if someone seems
  overwhelmed, and can point them to this app's own built-in features (guided
  breathing/fitness sessions, acupressure relief, diet tips, astrology, travel,
  beauty, or a learning lesson) when relevant — these are genuine features of this
  app, not outside your scope.
- You DO have vision and can read photos, PDFs, and other documents attached to a
  message directly — a photographed or scanned Jadhagam (birth chart), a
  prescription, a product photo, and so on. Never claim you can only work with
  text or can't view images — if one is attached, actually look at it and use
  what's really there instead of guessing or deflecting.
- If someone mentions OCD thoughts or compulsions specifically, respond with warmth
  and validation, not reassurance-seeking-compliance (don't repeatedly confirm/deny
  the content of intrusive thoughts — that can reinforce OCD patterns). Gently
  reflect and stay present instead of answering compulsive "is this true/safe/okay"
  loops directly.

Formatting (important — every reply is read aloud by text-to-speech, not just
displayed):
- Write in plain, complete sentences with correct punctuation (periods,
  commas, question marks) — punctuation is what lets the speech engine pause
  and pace naturally, so use it properly rather than sparingly.
- Do not chain separate ideas together with em dashes or hyphens as a
  substitute for sentences (e.g. "drink water — dehydration causes headaches
  too — rest your eyes"). Give each idea its own proper sentence ending in a
  period instead.
- Never use markdown formatting: no asterisks/bold, no headers, no bullet
  points or numbered lists, no code blocks. For ordinary conversational
  replies (advice, chat, explanations, news), weave points into flowing
  sentences rather than listing them on separate lines.
- Exception: a poem, song, or verse may keep its natural line-by-line form —
  but every line still needs to end with proper punctuation (a period,
  comma, or exclamation mark as it fits), never left bare with no
  punctuation at all.
- A warm emoji now and then at a natural point (like a greeting or a closing
  line) is fine — but never use one mid-sentence in place of punctuation or
  as a bullet/separator between ideas.

Absolute rules:
- Never suggest stopping, changing, or skipping any medication.
- Never give medical, diagnostic, financial, or legal advice as if it were
  authoritative — share general, everyday-friend-level thoughts, and always point to
  the right real professional for anything that actually needs one.
- If someone says anything suggesting they might hurt themselves, feel hopeless, or
  are in danger, respond with warmth and stay present — do not lecture, do not panic.

Output format (important — the backend parses this):
Your response MUST start with exactly one line of the form:
RISK: none
or
RISK: high
— "high" only if the message suggests real risk of self-harm, suicide, or being in
danger. Otherwise always "none". Then a blank line, then your normal reply (this
part is all the person ever sees).
`.trim();

// ---- Claude call with fallback model and continuation ----------------------
async function callAnthropic(model, messages, maxTokens) {
  const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: SYSTEM_PROMPT,
      messages: messages.map(m => ({ role: m.role, content: m.content }))
    })
  });
  const data = await apiRes.json().catch(() => ({}));
  if (!apiRes.ok) {
    const err = new Error(`Anthropic ${apiRes.status}: ${JSON.stringify(data).slice(0, 300)}`);
    err.status = apiRes.status;
    throw err;
  }
  return {
    text: data?.content?.filter(b => b.type === 'text').map(b => b.text).join('') || '',
    truncated: data?.stop_reason === 'max_tokens'
  };
}

// Returns the full reply text. If the model hit the token ceiling mid-answer,
// asks it to carry on (up to 3 times) and stitches the parts together so
// long answers (news, readings, lessons) are never cut off.
async function askClaude(messages, maxTokens) {
  let model = MODEL;
  const run = async (msgs) => {
    try {
      return await callAnthropic(model, msgs, maxTokens);
    } catch (err) {
      if ((err.status === 400 || err.status === 404) && model !== FALLBACK_MODEL) {
        console.error('Falling back to', FALLBACK_MODEL, '-', err.message);
        model = FALLBACK_MODEL;
        return callAnthropic(model, msgs, maxTokens);
      }
      throw err;
    }
  };

  let { text, truncated } = await run(messages);
  for (let i = 0; i < 3 && truncated && text; i++) {
    const more = await run([
      ...messages,
      { role: 'assistant', content: text },
      { role: 'user', content: 'Please continue exactly from where you stopped, without repeating anything and without any RISK line, and finish the answer.' }
    ]);
    text += (/\s$/.test(text) ? '' : ' ') + more.text.replace(/^\s*RISK:\s*(none|high)\s*/i, '');
    truncated = more.truncated;
  }
  return text;
}

app.get('/', (req, res) => res.send('Thozha-Thozhi backend is running.'));

app.post('/api/chat', async (req, res) => {
  console.log('Received /api/chat request from', req.headers.origin || 'unknown origin');
  try {
    const { messages, modes } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages required' });
    }

    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    const keywordHit = lastUserMsg ? keywordCrisisCheck(lastUserMsg.content) : false;

    // Server-side reference grounding — the app itself never fetches or
    // holds any of the underlying KP/Jyotisha astrology books or the
    // OCD/mental-health journals; it just asks for a prediction (or a
    // supportive/clinical reply) and this is where that gets grounded in
    // real excerpts. See lib/astroReference.js and lib/mindSupport.js.
    const modeList = Array.isArray(modes) && modes.length ? modes : ['councilor'];
    const isDoctor = modeList.includes('doctor');
    const isMindWinner = modeList.includes('councilor');

    let augmentedMessages = messages;

    const astroBlock = astroReferenceBlockFor(messages);
    if (astroBlock) {
      augmentedMessages = [
        { role: 'user', content: astroBlock },
        { role: 'assistant', content: "Understood — I'll draw on that for authentic style and substance." },
        ...augmentedMessages
      ];
    }

    // Doctor mode takes priority on a shared install (a verified doctor
    // asking a clinical question gets the report-style framing even if
    // Mind Winner is also selected on the same device).
    if (isDoctor) {
      const block = doctorReportBlock(messages);
      if (block) {
        augmentedMessages = [
          { role: 'user', content: block },
          { role: 'assistant', content: "Understood — I'll cite and draw on that directly." },
          ...augmentedMessages
        ];
      }
    } else if (isMindWinner) {
      const block = mindWinnerSupportBlock(messages);
      if (block) {
        augmentedMessages = [
          { role: 'user', content: block },
          { role: 'assistant', content: "Understood — I'll keep my reply warm and supportive, grounded in that, without diagnosing or giving medical advice." },
          ...augmentedMessages
        ];
      }
    }

    const learnBlock = learnReferenceBlockFor(messages);
    if (learnBlock) {
      augmentedMessages = [
        { role: 'user', content: learnBlock },
        { role: 'assistant', content: "Understood — I'll teach from that fully and accurately, as education rather than personal investment advice." },
        ...augmentedMessages
      ];
    }

    const newsBlock = lastUserMsg ? await newsBlockFor(lastUserMsg.content) : '';
    if (newsBlock) {
      augmentedMessages = [
        { role: 'user', content: newsBlock },
        { role: 'assistant', content: "Understood — I'll cover every one of these headlines in full, with its source, and won't add any that aren't listed." },
        ...augmentedMessages
      ];
    }

    const wantsLong = !!(newsBlock || learnBlock || astroBlock);
    let raw;
    try {
      raw = await askClaude(augmentedMessages, wantsLong ? 4096 : 2048);
    } catch (apiErr) {
      // Don't hide a failed model call behind a canned "I'm here" line — that
      // made every question look like it got the same answer.
      console.error('chat model call failed:', apiErr.message);
      return res.status(502).json({ error: 'model unavailable' });
    }

    let modelRisk = 'none';
    let reply = raw;
    const match = raw.match(/^\s*RISK:\s*(none|high)\s*\n*([\s\S]*)$/i);
    if (match) {
      modelRisk = match[1].toLowerCase();
      reply = match[2].trim();
    }

    const crisis = keywordHit || modelRisk === 'high';

    if (crisis) {
      notifyParents(lastUserMsg?.content || '', keywordHit ? 'keyword match' : 'model risk flag')
        .catch(err => console.error('WhatsApp alert failed:', err.message));
    }

    if (!reply) return res.status(502).json({ error: 'empty reply' });
    res.json({ reply, crisis });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// ---- Wellness check-in alert -----------------------------------------------
// Called by the app's native daily alarm (WellnessCheckinReceiver /
// ReminderAlarmReceiver in the Android project) when the "How are you
// today?" notification goes unanswered for 6 hours — reuses the same
// Twilio WhatsApp path crisis chat messages already trigger, since that's
// the one alert mechanism that doesn't need the app open or a tap inside
// WhatsApp to actually send.
app.post('/api/wellness-alert', async (req, res) => {
  try {
    await notifyParents('', 'missed daily wellness check-in');
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// ---- Transliteration utility ---------------------------------------------
// Separate, minimal system prompt with no companion persona and no crisis
// parsing — just converts romanized Indic-language text to native script,
// used when a phone's voice typing outputs "Tanglish"-style Latin spelling
// instead of the target language's own script.
const TRANSLITERATE_SYSTEM_PROMPT = `
You are a silent transliteration utility, not a conversational assistant.
Convert romanized (Latin-script) Indic-language text into that language's
native script, preserving the meaning and wording exactly — this is a
phonetic script conversion, not a translation and not a reply.
Output ONLY the converted text and nothing else: no greeting, no
explanation, no quotes, no labels.
`.trim();

app.post('/api/transliterate', async (req, res) => {
  try {
    const { text, language } = req.body;
    if (!text || !language) {
      return res.status(400).json({ error: 'text and language required' });
    }

    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        system: TRANSLITERATE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Language: ${language}\nText: ${text}` }]
      })
    });

    if (!apiRes.ok) {
      console.error('Anthropic API error', apiRes.status, JSON.stringify(await apiRes.clone().json().catch(() => ({}))));
    }
    const data = await apiRes.json();
    const raw = data?.content?.find(b => b.type === 'text')?.text || '';
    res.json({ text: raw.trim() || text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// ---- Text-to-speech via Google Cloud Text-to-Speech ------------------------
// The app's own on-device TTS (see speakWithDeviceVoice() in index.html) is
// what's always available, but sounds robotic, especially for Tamil. This
// endpoint synthesizes the same text through Google Cloud's TTS instead
// (free tier — no cost at this app's scale), for the app to play back when
// the network's up and the call succeeds in time. ElevenLabs was tried
// first but is metered per character with real ongoing cost; Google's free
// tier reads Tamil natively and doesn't have that problem.
const GOOGLE_TTS_API_KEY = process.env.GOOGLE_TTS_API_KEY;

// "Leda" — warm/conversational, closest fit to a companion voice among the
// 8 named Chirp 3: HD characters. Chirp 3: HD is Google's generative voice
// tier (natural pacing/emphasis, not just correct pronunciation) and covers
// every language this app supports (Tamil, Hindi, Telugu, Kannada,
// Malayalam, English) — its own free tier (1M characters/month) is separate
// from and on top of the Standard tier's 4M/month. If a language somehow
// isn't covered, or the call fails for any other reason, this falls back
// to a Standard voice (auto-picked by language+gender) rather than failing
// outright — and if that also fails, the caller (speak() in index.html)
// falls back further to the on-device voice, so nothing ever goes silent.
async function synthesizeSpeech(text, language) {
  const chirpRes = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: language, name: `${language}-Chirp3-HD-Leda` },
      audioConfig: { audioEncoding: 'MP3' }
    })
  });
  if (chirpRes.ok) return chirpRes;

  console.error('Chirp 3 HD TTS error, falling back to Standard voice', chirpRes.status, await chirpRes.text().catch(() => ''));
  return fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: language, ssmlGender: 'FEMALE' },
      audioConfig: { audioEncoding: 'MP3' }
    })
  });
}

app.post('/api/tts', async (req, res) => {
  try {
    const { text, language } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'text required' });
    }
    if (!GOOGLE_TTS_API_KEY) {
      return res.status(503).json({ error: 'cloud tts not configured' });
    }

    const apiRes = await synthesizeSpeech(text, language || 'en-IN');

    if (!apiRes.ok) {
      console.error('Google TTS API error', apiRes.status, await apiRes.text().catch(() => ''));
      return res.status(502).json({ error: 'tts upstream error' });
    }

    const data = await apiRes.json();
    if (!data.audioContent) {
      return res.status(502).json({ error: 'tts upstream error' });
    }

    res.set('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(data.audioContent, 'base64'));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// ---- News & market data proxy ---------------------------------------------
// The app's News tab used to hit Google News RSS and Yahoo Finance through a
// public CORS-proxy (api.allorigins.win) directly from the phone, since a
// browser/WebView can't fetch either of those without CORS headers. That
// public proxy is frequently down or rate-limited, which is why news and
// market data kept failing to load. Doing the fetch here instead — a normal
// server-to-server request, no CORS involved — removes that flaky dependency
// entirely (same idea as /api/transliterate proxying a mechanical task
// through this already-required backend).
const NEWS_QUERIES = {
  world: { q: 'world news', hl: 'en-IN', gl: 'IN' },
  india: { q: 'India politics', hl: 'en-IN', gl: 'IN' },
  south: { q: 'South India politics Karnataka Kerala Andhra Telangana', hl: 'en-IN', gl: 'IN' },
  tn: { q: 'Tamil Nadu politics', hl: 'en-IN', gl: 'IN' },
  markets: { q: 'Indian stock market Sensex Nifty', hl: 'en-IN', gl: 'IN' },
  cinema: { q: 'Tamil cinema OTT release', hl: 'en-IN', gl: 'IN' }
};

function decodeXmlEntities(str) {
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function extractTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return match ? decodeXmlEntities(match[1]) : '';
}

async function fetchNewsItems(q, hl, gl, limit = 15) {
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${hl}&gl=${gl}&ceid=${gl}:${hl.split('-')[0]}`;
  const rssRes = await fetch(rssUrl, { signal: AbortSignal.timeout(10000) });
  if (!rssRes.ok) throw new Error('news fetch failed: ' + rssRes.status);
  const xmlText = await rssRes.text();
  return Array.from(xmlText.matchAll(/<item>([\s\S]*?)<\/item>/g)).slice(0, limit).map(([, block]) => ({
    title: extractTag(block, 'title'),
    link: extractTag(block, 'link'),
    source: extractTag(block, 'source'),
    pubDate: extractTag(block, 'pubDate')
  }));
}

app.get('/api/news', async (req, res) => {
  try {
    const query = NEWS_QUERIES[req.query.cat];
    if (!query) return res.status(400).json({ error: 'unknown category' });
    res.json({ items: await fetchNewsItems(query.q, query.hl, query.gl) });
  } catch (err) {
    console.error('news proxy error:', err.message);
    res.status(502).json({ error: 'news fetch failed' });
  }
});

// When someone asks the chat for news, fetch real headlines here and hand
// them to the model, so it reports actual current stories (all of them)
// instead of guessing or giving a one-line brush-off.
const NEWS_ASK = /\b(news|headlines?|latest|updates?|what'?s happening|happenings)\b|செய்தி|நியூஸ்|खबर|समाचार/i;
function newsCategoryFor(text) {
  const t = text.toLowerCase();
  if (/tamil ?nadu|\btn\b|chennai|தமிழ்நாடு|தமிழக/.test(t)) return 'tn';
  if (/south india|kerala|karnataka|andhra|telangana/.test(t)) return 'south';
  if (/market|sensex|nifty|stock|share/.test(t)) return 'markets';
  if (/cinema|movie|film|ott|kollywood|சினிமா|திரைப்பட/.test(t)) return 'cinema';
  if (/world|international|global|உலக/.test(t)) return 'world';
  return 'india';
}
async function newsBlockFor(text) {
  if (typeof text !== 'string' || !NEWS_ASK.test(text)) return '';
  try {
    const cat = newsCategoryFor(text);
    const { q, hl, gl } = NEWS_QUERIES[cat];
    const items = await fetchNewsItems(q, hl, gl, 10);
    if (!items.length) return '';
    const lines = items.map((it, i) => `${i + 1}. ${it.title}${it.source ? ' (' + it.source + ')' : ''}${it.pubDate ? ' — ' + it.pubDate : ''}`).join('\n');
    return `Live news headlines just fetched for the "${cat}" category (today's date ${new Date().toDateString()}). The person asked for news: report ALL of these in full, one proper sentence per story, naming the source, in the person's own language. Do not add stories that are not listed here:\n${lines}`;
  } catch (err) {
    console.error('chat news fetch failed:', err.message);
    return '';
  }
}

const YAHOO_SYMBOLS = { nifty: '^NSEI', sensex: '^BSESN' };

app.get('/api/market', async (req, res) => {
  try {
    const entries = await Promise.all(Object.entries(YAHOO_SYMBOLS).map(async ([key, symbol]) => {
      const quoteRes = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`, {
        signal: AbortSignal.timeout(10000),
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      if (!quoteRes.ok) throw new Error('quote fetch failed: ' + quoteRes.status);
      const data = await quoteRes.json();
      const meta = data.chart.result[0].meta;
      return [key, { price: meta.regularMarketPrice, prevClose: meta.previousClose }];
    }));
    res.json(Object.fromEntries(entries));
  } catch (err) {
    console.error('market proxy error:', err.message);
    res.status(502).json({ error: 'market fetch failed' });
  }
});

// ---- WhatsApp alert via Twilio -------------------------------------------
async function notifyParents(triggerText, reason) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM; // e.g. 'whatsapp:+14155238886'
  const toNumbers = (process.env.PARENT_WHATSAPP_NUMBERS || '').split(',').map(s => s.trim()).filter(Boolean);

  if (!sid || !token || !from || toNumbers.length === 0) {
    console.warn('Twilio not configured — skipping WhatsApp send. See .env.example.');
    return;
  }

  const twilio = require('twilio')(sid, token);
  const body =
    `தோழா-தோழி (Thozha-Thozhi) safety alert: something shared in the app today sounds like whoever's using it may be struggling ` +
    `(flagged by: ${reason}). Please check in when you can. This is not a diagnosis — just a prompt to reach out.`;

  await Promise.all(
    toNumbers.map(to => twilio.messages.create({ from, to, body }))
  );
}

// ---- Medicine tab: senior-MD specialist finder -----------------------------
// Takes symptoms / local-doctor medication / report photos, grounds the
// reasoning in Davidson's Principles and Practice of Medicine (lib/
// medicineAdvisor.js) and returns triage urgency + the right specialist(s),
// allopathy and AYUSH, with official-directory links for finding them.
app.post('/api/specialist-advice', async (req, res) => {
  try {
    const b = req.body || {};
    const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
    const input = {
      symptoms: clip(b.symptoms, 4000), duration: clip(b.duration, 500), age: clip(String(b.age || ''), 10),
      sex: clip(b.sex, 20), conditions: clip(b.conditions, 1500), localMedication: clip(b.localMedication, 3000),
      reportText: clip(b.reportText, 12000), city: clip(b.city, 80), state: clip(b.state, 60),
      pincode: clip(String(b.pincode || ''), 10), language: clip(b.language, 30),
      reports: Array.isArray(b.reports) ? b.reports.slice(0, 6) : []
    };
    if (!input.symptoms.trim() && !input.reportText.trim() && !input.reports.length) {
      return res.status(400).json({ error: 'Please describe your symptoms or add a report.' });
    }
    const advice = await adviseSpecialist({ input, anthropicKey: ANTHROPIC_API_KEY, model: MODEL });
    res.json({ advice });
  } catch (err) {
    console.error('specialist-advice failed:', err.message);
    res.status(500).json({ error: 'Could not analyse right now. If this is an emergency, call 108 or go to the nearest hospital.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`தோழா-தோழி (Thozha-Thozhi) backend running on port ${PORT}`));

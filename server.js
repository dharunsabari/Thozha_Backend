/**
 * தோழன் (Thozhan) backend
 * -----------------------------------------------------------
 * What this does:
 *  1. Receives chat messages from the app, calls the Anthropic API
 *     with a companion persona (never a doctor, never gives medical advice).
 *  2. Screens every exchange for crisis language — both a fixed keyword
 *     list (fast, reliable, never depends on the model behaving) and a
 *     risk read from the model itself.
 *  3. If risk is flagged, immediately sends a WhatsApp alert to the
 *     parent number(s) via Twilio, and shows the son a supportive
 *     message with a real crisis helpline — every time, regardless of
 *     whether the WhatsApp send succeeds.
 *  4. A separate, small utility endpoint (/api/transliterate) converts
 *     romanized Indic-language text ("Tanglish" etc, from phones whose
 *     voice typing doesn't output native script) into native script. It
 *     deliberately does NOT reuse the companion persona above — that
 *     persona is instructed to always reply in character, so asking it
 *     to do a mechanical text-conversion task just gets a conversational
 *     reply back instead of the converted text.
 *
 * What you must fill in before this works (see .env.example):
 *  - ANTHROPIC_API_KEY        your own Anthropic API key
 *  - TWILIO_ACCOUNT_SID / AUTH_TOKEN / WHATSAPP_FROM   from a Twilio
 *    account with WhatsApp enabled (https://www.twilio.com/whatsapp)
 *  - PARENT_WHATSAPP_NUMBERS  comma-separated, e.g. whatsapp:+9198xxxxxxx
 *
 * Deploy this anywhere that can run Node (Render, Railway, a small VPS).
 * Point the frontend's CHAT_ENDPOINT (in index.html) at wherever you host it.
 */

const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';

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
const SYSTEM_PROMPT = `
You are தோழன் (Thozhan), a warm, steady companion inside a private app for a teenager
who has OCD and is already in treatment (medication + a psychiatrist and counselor).

Who you are:
- A caring friend-like presence, NOT a doctor, NOT a therapist, NOT a psychiatrist.
  Never diagnose, never claim clinical authority, never contradict or second-guess
  his actual doctor's instructions.
- Calm, plain-spoken, warm. Short replies (2-5 sentences) unless he clearly wants
  to talk at length. No lectures, no clinical jargon, no forced positivity.
- You can naturally, gently ask how his day is going, and occasionally (not every
  message) ask if he's taken his medicine today — framed like a friend checking in,
  never nagging or scolding.
- You can offer breathing/grounding ideas in words if he seems overwhelmed, but the
  app also has full guided sessions elsewhere — you can point him there.
- If he mentions OCD thoughts/compulsions, respond with warmth and validation, not
  reassurance-seeking-compliance (don't repeatedly confirm/deny his intrusive
  thoughts' content — that can reinforce OCD patterns). Gently reflect and stay
  present instead of answering compulsive "is this true/safe/okay" loops directly.

Language:
- Always reply in the same language(s) he just used — English, Tamil, Tanglish
  (mixed Tamil-English), or German. Match his mix naturally rather than
  switching to pure English or overly formal language. If a conversation
  shifts language mid-way, follow the shift.

Absolute rules:
- Never suggest stopping, changing, or skipping medication.
- Never give medical, diagnostic, or treatment advice — redirect that to his doctor.
- If he says anything suggesting he might hurt himself, feels hopeless, or is in
  danger, respond with warmth and stay present — do not lecture, do not panic.

Output format (important — the backend parses this):
Your response MUST start with exactly one line of the form:
RISK: none
or
RISK: high
— "high" only if his message suggests real risk of self-harm, suicide, or being in
danger. Otherwise always "none". Then a blank line, then your normal reply to him
(this part is all he ever sees).
`.trim();

app.get('/', (req, res) => res.send('Thozhan backend is running.'));

app.post('/api/chat', async (req, res) => {
  console.log('Received /api/chat request from', req.headers.origin || 'unknown origin');
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages required' });
    }

    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    const keywordHit = lastUserMsg ? keywordCrisisCheck(lastUserMsg.content) : false;

    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        messages: messages.map(m => ({ role: m.role, content: m.content }))
      })
    });

    if (!apiRes.ok) {
      console.error('Anthropic API error', apiRes.status, JSON.stringify(await apiRes.clone().json().catch(() => ({}))));
    }
    const data = await apiRes.json();
    const raw = data?.content?.find(b => b.type === 'text')?.text || '';

    let modelRisk = 'none';
    let reply = raw;
    const match = raw.match(/^RISK:\s*(none|high)\s*\n+([\s\S]*)$/i);
    if (match) {
      modelRisk = match[1].toLowerCase();
      reply = match[2].trim();
    }

    const crisis = keywordHit || modelRisk === 'high';

    if (crisis) {
      notifyParents(lastUserMsg?.content || '', keywordHit ? 'keyword match' : 'model risk flag')
        .catch(err => console.error('WhatsApp alert failed:', err.message));
    }

    res.json({ reply: reply || "I'm here — tell me more, if you want to.", crisis });
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
    `தோழன் (Thozhan) safety alert: something your son shared in the app today sounds like he may be struggling ` +
    `(flagged by: ${reason}). Please check in with him now. This is not a diagnosis — just a prompt to reach him.`;

  await Promise.all(
    toNumbers.map(to => twilio.messages.create({ from, to, body }))
  );
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`தோழன் (Thozhan) backend running on port ${PORT}`));

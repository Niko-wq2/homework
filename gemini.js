// Google Gemini API (free tier) — reading homework pages and giving hints.
// Called straight from the phone with your own API key.
import { blobToBase64 } from './images.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_MODEL = 'gemini-flash-latest';

export class GeminiError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

async function call(key, model, body) {
  const res = await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = j.error && j.error.message || ''; } catch (e) { /* */ }
    if (res.status === 429) throw new GeminiError('The free Gemini limit was reached for now. Wait a minute (or until tomorrow if it is the daily limit) and try again.', 429);
    if (res.status === 400 && /API key/i.test(detail)) throw new GeminiError('Gemini rejected the API key. Check it in Settings.', 400);
    if (res.status === 403) throw new GeminiError('Gemini refused the request (403). Check that your API key is correct and the Gemini API is enabled. ' + detail, 403);
    if (res.status === 404) throw new GeminiError(`Model "${model}" was not found. Pick another model in Settings.`, 404);
    throw new GeminiError(`Gemini error ${res.status}: ${detail || res.statusText}`, res.status);
  }
  const data = await res.json();
  const cand = data.candidates && data.candidates[0];
  if (!cand) {
    const why = data.promptFeedback && data.promptFeedback.blockReason;
    throw new GeminiError(why ? `Gemini blocked the request (${why}).` : 'Gemini returned no answer.', 200);
  }
  return (cand.content && cand.content.parts || []).filter(p => !p.thought).map(p => p.text || '').join('').trim();
}

// Lists models usable with generateContent, preferring "flash" ones.
export async function listModels(key) {
  const res = await fetch(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
  if (!res.ok) {
    let d = ''; try { d = (await res.json()).error.message; } catch (e) { /* */ }
    throw new GeminiError(`Key check failed (${res.status}). ${d}`, res.status);
  }
  const j = await res.json();
  const names = (j.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace(/^models\//, ''))
    .filter(n => /gemini/.test(n) && !/(tts|image|embedding|audio|live|robotics|computer-use|veo|imagen)/.test(n));
  const score = n => (/flash-latest$/.test(n) ? 0 : /flash-lite-latest$/.test(n) ? 1 : /flash/.test(n) && !/lite/.test(n) ? 2 : /flash-lite/.test(n) ? 3 : 4);
  return names.sort((a, b) => score(a) - score(b) || b.localeCompare(a));
}

function parseJson(text) {
  let t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch (e) { /* try to cut out the object */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new GeminiError('Could not understand Gemini\'s reply. Try "Read with AI" again.');
}

const PARSE_PROMPT = `You are helping a student turn photos/scans of homework into a list of questions they will answer by hand on a small tablet.
The images are the pages of ONE assignment, in order (Page 1, Page 2, ...).

Return ONLY JSON in exactly this shape:
{
  "title": "short title in the original language, e.g. 'Упражнение 5' or 'Physics HW 7: Kinematics'",
  "subject": "one or two words in English, e.g. Russian, Math, Physics, Chemistry, English, History",
  "due_date": "YYYY-MM-DD if a due date is written on the pages, otherwise null",
  "questions": [
    {
      "label": "the question's printed number/letter, e.g. '1', '2b', 'Упр. 3'; number them yourself if there is none",
      "text": "the complete task exactly as the student must see it, in the ORIGINAL language (never translate)",
      "paper": "lines | grid | blank",
      "page": 1,
      "box": [ymin, xmin, ymax, xmax],
      "figures": [ { "page": 1, "box": [ymin, xmin, ymax, xmax] } ]
    }
  ]
}

Rules:
- One entry per item that needs its own written answer. If an exercise has numbered sub-items that each need an answer (for example 8 sentences to complete), make each sub-item its own question and start its text with a short version of the shared instruction.
- "text" must contain everything needed to answer without the page: the instruction, the sentence/word list/data, given values, and table contents (as simple lines). Keep blanks as "____". Use \\n for line breaks.
- Write ALL math in LaTeX: inline as $...$ and displayed equations as $$...$$ (e.g. $v_0 = 12\\ \\text{m/s}$, $\\frac{1}{2}at^2$). Units and Greek letters in LaTeX too.
- Read Cyrillic and handwriting carefully. Keep stress marks, ё, punctuation and capitalization exactly.
- "paper": "lines" for language/written answers, "grid" for math, physics and chemistry work, "blank" when the student must draw.
- "page" is the 1-based page where the question is. "box" is the bounding box of the whole question on that page, as integers normalized to 0-1000 (ymin, xmin, ymax, xmax).
- "figures": every diagram, graph, picture, circuit or table image the student needs to look at to answer, with its page and box. Use [] if none.
- Do NOT solve, answer, translate, or hint at anything. Only copy the tasks.
- Skip page headers, page numbers, answer keys and examples that are already solved.`;

/**
 * pages: array of JPEG Blobs. Returns {title, subject, due_date, questions[]}.
 */
export async function parseHomework({ key, model, pages, hint }) {
  const parts = [{ text: PARSE_PROMPT + (hint ? `\n\nExtra context from the student: ${hint}` : '') }];
  for (let i = 0; i < pages.length; i++) {
    parts.push({ text: `Page ${i + 1}:` });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: await blobToBase64(pages[i]) } });
  }
  const text = await call(key, model, {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
  });
  const j = parseJson(text);
  const qs = Array.isArray(j.questions) ? j.questions : [];
  return {
    title: String(j.title || '').slice(0, 120),
    subject: String(j.subject || '').slice(0, 40),
    due_date: j.due_date || null,
    questions: qs.map((q, i) => ({
      label: String(q.label || i + 1).slice(0, 12),
      text: String(q.text || ''),
      paper: ['lines', 'grid', 'blank'].includes(q.paper) ? q.paper : null,
      page: Math.max(1, Math.min(pages.length, parseInt(q.page, 10) || 1)),
      box: Array.isArray(q.box) && q.box.length === 4 ? q.box.map(Number) : null,
      figures: (Array.isArray(q.figures) ? q.figures : [])
        .filter(f => f && Array.isArray(f.box) && f.box.length === 4)
        .map(f => ({ page: Math.max(1, Math.min(pages.length, parseInt(f.page, 10) || parseInt(q.page, 10) || 1)), box: f.box.map(Number) })),
    })),
  };
}

const HINT_RULES = `You are a patient tutor. You give HINTS ONLY — never answers.
Strict rules:
- Never state the final answer, a final number, the completed word/sentence/translation, or a full solution.
- Never finish the student's work for them. For language homework, explain the relevant rule or give a DIFFERENT example word — not the word they must write.
- For math/physics, you may name the formula or principle and say what to substitute, but stop before computing results.
- If the student's work so far contains a mistake, say WHERE to look (which step/line) and what kind of mistake to check for, without giving the correction.
- Hint levels: 1 = a small nudge or guiding question; 2 = name the concept, rule or formula and how it applies here; 3 = set up the first concrete step, then stop.
- At most 80 words. Plain text, no headings or bullet lists. Write math in LaTeX between $...$.`;

/**
 * Returns hint text. images: {question: canvas|Blob|null, work: Blob|null}
 */
export async function getHint({ key, model, subject, title, question, level, previous, questionImage, workImage, language }) {
  const parts = [{
    text: `${HINT_RULES}\n- Write the hint in ${language || 'English'} (quote words from the homework in their original language when needed).\n\n` +
      `Subject: ${subject || 'unknown'}\nAssignment: ${title || ''}\nHint level requested: ${level} of 3\n\n` +
      `The question (original language):\n${question}`,
  }];
  if (questionImage) {
    parts.push({ text: 'Image of the question as printed:' });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: await blobToBase64(questionImage) } });
  }
  if (workImage) {
    parts.push({ text: "The student's handwritten work so far (may be incomplete or empty):" });
    parts.push({ inline_data: { mime_type: 'image/png', data: await blobToBase64(workImage) } });
  }
  if (previous && previous.length) {
    parts.push({ text: 'Hints already given (do not repeat them; go one step further):\n' + previous.map((h, i) => `${i + 1}. ${h}`).join('\n') });
  }
  const text = await call(key, model, {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.4 },
  });
  return text.replace(/^#+\s*/gm, '').trim();
}

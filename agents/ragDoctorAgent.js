require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const Groq = require('groq-sdk');
const {
  getPatientContext,
  extractLikelyPatientName,
  resolvePatientIdByName,
} = require('../rag/patientContext');
const { initIndex, semanticSearch, indexPatientBundle } = require('../rag/vectorStore');

function wantsDetailedOutput(query = '') {
  const q = String(query).toLowerCase();
  return (
    /\b(detailed|detail|elaborate|comprehensive|in[-\s]?depth|long|full)\b/.test(q) ||
    /\b(8|9|10)\s*(points?|bullets?|lines?)\b/.test(q) ||
    /\b8\s*[-to]+\s*10\b/.test(q)
  );
}

function getRequestedWordCount(query = '') {
  const q = String(query).toLowerCase();
  const match = q.match(/\b(\d{3,4})\s*words?\b/);
  if (!match) return null;
  const count = Number(match[1]);
  if (!Number.isFinite(count) || count < 120) return null;
  return Math.min(count, 1200);
}

function buildContextText(bundle, hits) {
  const p = bundle.patient;
  const meds = (bundle.medications || []).slice(0, 12).map((m) => `${m.drug} ${m.dose}`).join(', ');
  const lastVisit = (bundle.visits || []).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0];
  const alerts = (bundle.alerts || []).slice(0, 6).map((a) => `${a.severity?.toUpperCase()}: ${a.message}`).join('\n');
  const labText = (bundle.labs || []).slice(0, 20).map((l) => `${l.date} ${l.test}=${l.value}${l.unit || ''} (${l.status || 'NA'})`).join('\n');
  const ragText = (hits || []).map((h, i) => `[${i + 1}] ${h.text}`).join('\n');

  return `Patient ID: ${p.patient_id}
Name: ${p.name}
Age/Gender: ${p.age} / ${p.gender}
Diagnosis: ${(p.diagnosis || []).join(', ')}
Allergies: ${(p.allergies || []).join(', ') || 'None'}
Last Visit: ${lastVisit?.date || 'NA'} ${lastVisit?.doctor_notes || ''}
Current Medications: ${meds || 'NA'}
Active Alerts:
${alerts || 'NA'}
Labs:
${labText || 'NA'}

RAG Retrieved Context:
${ragText || 'NA'}`;
}

async function ensureVectorContext(patientId, baseQuery) {
  await initIndex();
  let hits = await semanticSearch(baseQuery, patientId, 8);
  if (hits.length > 0) return { hits, bundle: null };

  const bundle = await getPatientContext(patientId);
  if (!bundle) return { hits: [], bundle: null };
  await indexPatientBundle(bundle);
  hits = await semanticSearch(baseQuery, patientId, 8);
  return { hits, bundle };
}

async function runRagPatientSummary(patientId, apiKey, model = 'llama-3.3-70b-versatile') {
  const client = new Groq({ apiKey: apiKey || process.env.GROQ_API_KEY });
  const { hits, bundle: firstBundle } = await ensureVectorContext(
    patientId,
    'patient summary diagnoses medications alerts labs last visit recommendations'
  );

  const bundle = firstBundle || (await getPatientContext(patientId));
  if (!bundle) return { error: `Patient ${patientId} not found in Mongo/dataset.` };

  const context = buildContextText(bundle, hits);
  const prompt = `Create a physician-ready summary in 6 to 10 concise bullet points.
Requirements:
- Mention diagnosis, last visit, meds, abnormal labs, alerts, and actionable next steps.
- Keep each bullet specific and clinically useful.
- No markdown headings, only bullet points.
- End with one caution line: "Physician review required."`;

  const response = await client.chat.completions.create({
    model,
    temperature: 0.2,
    max_tokens: 700,
    messages: [
      { role: 'system', content: 'You are a clinical summarization assistant. Output concise bullets only.' },
      { role: 'user', content: `${context}\n\n${prompt}` },
    ],
  });

  const text = response.choices?.[0]?.message?.content || '';
  const summary_points = text
    .split('\n')
    .map((line) => line.replace(/^[-*•\d.\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, 10);

  return {
    patientId,
    source: bundle.source,
    summary_points,
    raw: text,
    rag_hits: hits.slice(0, 5),
  };
}

async function runRagDoctorQuery(patientId, query, apiKey, model = 'llama-3.3-70b-versatile') {
  let effectivePatientId = patientId;
  const explicitNameInQuery = extractLikelyPatientName(query);
  const allPatientsMode = !effectivePatientId || effectivePatientId === 'all-patients' || effectivePatientId === 'ALL';

  if (allPatientsMode) {
    const directNameTry = query?.trim();
    if (!explicitNameInQuery && directNameTry && directNameTry.split(/\s+/).length <= 4) {
      const directResolved = await resolvePatientIdByName(directNameTry);
      if (directResolved?.patient_id) {
        effectivePatientId = directResolved.patient_id;
      } else {
        return { error: `Patient not found: ${directNameTry}` };
      }
    }
    if (!effectivePatientId || effectivePatientId === 'all-patients' || effectivePatientId === 'ALL') {
      if (!explicitNameInQuery) {
        return {
          error:
            'Patient not found. Please provide a patient name in your query (example: "medications for Rekha Chaudhary") or select a patient from dropdown.',
        };
      }
      const resolved = await resolvePatientIdByName(explicitNameInQuery);
      if (!resolved?.patient_id) {
        return { error: `Patient not found: ${explicitNameInQuery}` };
      }
      effectivePatientId = resolved.patient_id;
    }
  } else if (explicitNameInQuery) {
    // If query explicitly asks for another patient, switch context to that patient.
    const resolved = await resolvePatientIdByName(explicitNameInQuery);
    if (!resolved?.patient_id) {
      return {
        error: `Patient not found: ${explicitNameInQuery}`,
      };
    }
    if (resolved.patient_id !== effectivePatientId) {
      effectivePatientId = resolved.patient_id;
    }
  }

  const client = new Groq({ apiKey: apiKey || process.env.GROQ_API_KEY });
  const { hits, bundle: firstBundle } = await ensureVectorContext(effectivePatientId, query);
  const bundle = firstBundle || (await getPatientContext(effectivePatientId));
  if (!bundle) return { error: `Patient ${effectivePatientId} not found in Mongo/dataset.` };

  const requestedWordCount = getRequestedWordCount(query);
  const detailed = wantsDetailedOutput(query) || Boolean(requestedWordCount);
  const lengthInstruction = requestedWordCount
    ? `Return a detailed consultation brief in approximately ${requestedWordCount} words.`
    : detailed
      ? 'Return 8 to 10 concise bullet points (detailed mode requested by user).'
      : 'Return 5 to 6 concise bullet points only (default short mode).';
  const formatInstruction = requestedWordCount
    ? `Use clean markdown formatting with bold section labels like **Key Issue**, **Medications**, **Abnormal Labs/Alerts**, **Next Steps**, and **Action Plan**.`
    : 'Use bullet points and keep labels bold when present (example: **Key Issue:**).';
  const maxTokens = requestedWordCount ? 2200 : 900;

  const context = buildContextText(bundle, hits);
  const response = await client.chat.completions.create({
    model,
    temperature: 0.3,
    max_tokens: maxTokens,
    messages: [
      {
        role: 'system',
        content:
          'You are an AI doctor assistant. Use RAG context first. Keep output normal, clean, and structured for fast clinical reading.',
      },
      {
        role: 'user',
        content: `Question: ${query}

Formatting requirements:
- ${lengthInstruction}
- Cover: key issues, meds, abnormal labs/alerts, and next steps.
- Keep each bullet specific and actionable.
- Avoid long paragraphs and avoid extra headings unless user asks.
- ${formatInstruction}

Context:
${context}`,
      },
    ],
  });

  return {
    patientId: effectivePatientId,
    source: bundle.source,
    answer: response.choices?.[0]?.message?.content || '',
    rag_hits: hits.slice(0, 5),
  };
}

module.exports = { runRagPatientSummary, runRagDoctorQuery };

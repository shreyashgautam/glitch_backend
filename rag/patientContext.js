const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

let MongoClient = null;
try {
  ({ MongoClient } = require('mongodb'));
} catch {
  MongoClient = null;
}

const DATASET_DIR = process.env.DATASET_DIR ? path.resolve(process.env.DATASET_DIR) : null;

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function deriveAlertsFromLabs(labs = []) {
  return labs
    .filter((l) => {
      const status = String(l.status || '').toLowerCase();
      return status.includes('high') || status.includes('critical') || status.includes('abnormal');
    })
    .slice(0, 8)
    .map((l) => ({
      severity: String(l.status || '').toLowerCase().includes('critical') ? 'high' : 'medium',
      message: `${l.test}: ${l.status} (${l.value}${l.unit || ''})`,
      date: l.date || null,
    }));
}

function normalizeBundle(patient, visits, medications, labs, alerts) {
  if (!patient) return null;
  return {
    patient: {
      patient_id: patient.patient_id || patient.id,
      name: patient.name,
      age: patient.age,
      gender: patient.gender,
      diagnosis: patient.diagnosis || patient.primaryDiagnosis || [],
      allergies: patient.allergies || [],
      lastVisit:
        (visits || []).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0]?.date || null,
    },
    visits: (visits || []).map((v) => ({
      visit_id: v.visit_id || null,
      date: v.date || null,
      doctor: v.doctor || null,
      department: v.department || null,
      visit_type: v.visit_type || v.visitType || null,
      doctor_notes: v.doctor_notes || v.clinicalNote || v.plan || '',
      symptoms: Array.isArray(v.symptoms)
        ? v.symptoms
        : v.chiefComplaint
        ? String(v.chiefComplaint).split(',').map((s) => s.trim())
        : [],
      bp_systolic: v.bp_systolic ?? v.bp?.systolic ?? null,
      bp_diastolic: v.bp_diastolic ?? v.bp?.diastolic ?? null,
      pulse_bpm: v.pulse_bpm ?? v.pulse ?? null,
      temperature_c: v.temperature_c ?? v.temperature ?? null,
      spo2_pct: v.spo2_pct ?? v.spo2 ?? null,
      weight_kg: v.weight_kg ?? v.weight ?? null,
    })),
    medications: (medications || []).map((m) => ({
      med_id: m.med_id || null,
      drug: m.drug || m.name,
      dose: m.dose || '',
      frequency: m.frequency || '',
      route: m.route || '',
      start_date: m.start_date || m.since || null,
      end_date: m.end_date || null,
      prescribed_by: m.prescribed_by || null,
      active: m.active ?? true,
    })),
    labs: labs || [],
    alerts: alerts && alerts.length ? alerts : deriveAlertsFromLabs(labs || []),
  };
}

async function getFromMongo(patientId) {
  if (!MongoClient || !process.env.MONGO_URI) return null;
  const dbName = process.env.MONGO_DB_NAME || 'medai';
  const client = new MongoClient(process.env.MONGO_URI);
  try {
    await client.connect();
    const db = client.db(dbName);
    const normalizedId = String(patientId || '').trim().toUpperCase();
    const idRegex = new RegExp(`^${normalizedId}$`, 'i');
    const [patient, visits, medications, labs] = await Promise.all([
      db.collection('patients').findOne({
        $or: [{ patient_id: normalizedId }, { patient_id: idRegex }, { id: normalizedId }, { id: idRegex }],
      }),
      db.collection('visits').find({ patient_id: { $regex: idRegex } }).toArray(),
      db.collection('medications').find({ patient_id: { $regex: idRegex } }).toArray(),
      db.collection('labs').find({ patient_id: { $regex: idRegex } }).toArray(),
    ]);
    if (!patient) return null;
    return normalizeBundle(patient, visits, medications, labs, []);
  } finally {
    await client.close();
  }
}

function getFromDataset(patientId) {
  if (!DATASET_DIR || !fs.existsSync(DATASET_DIR)) return null;
  const normalizedId = String(patientId || '').trim().toUpperCase();
  const patients = readJson(path.join(DATASET_DIR, 'patients.json'));
  const visits = readJson(path.join(DATASET_DIR, 'visits.json'));
  const medications = readJson(path.join(DATASET_DIR, 'medications.json'));
  const labs = readJson(path.join(DATASET_DIR, 'labs.json'));
  const patient = patients.find((p) => String(p.patient_id || '').trim().toUpperCase() === normalizedId);
  if (!patient) return null;
  return normalizeBundle(
    patient,
    visits.filter((v) => String(v.patient_id || '').trim().toUpperCase() === normalizedId),
    medications.filter((m) => String(m.patient_id || '').trim().toUpperCase() === normalizedId),
    labs.filter((l) => String(l.patient_id || '').trim().toUpperCase() === normalizedId),
    []
  );
}

function normalizeName(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getAllPatientsLiteFromMongo() {
  if (!MongoClient || !process.env.MONGO_URI) return null;
  const dbName = process.env.MONGO_DB_NAME || 'medai';
  const client = new MongoClient(process.env.MONGO_URI);
  try {
    await client.connect();
    const db = client.db(dbName);
    const rows = await db.collection('patients').find({}, { projection: { patient_id: 1, name: 1, diagnosis: 1 } }).toArray();
    return rows.map((r) => ({
      patient_id: r.patient_id || r.id,
      name: r.name,
      diagnosis: r.diagnosis || [],
    }));
  } finally {
    await client.close();
  }
}

function getAllPatientsLiteFromDataset() {
  if (!DATASET_DIR || !fs.existsSync(DATASET_DIR)) return [];
  const patients = readJson(path.join(DATASET_DIR, 'patients.json'));
  return patients.map((p) => ({
    patient_id: p.patient_id,
    name: p.name,
    diagnosis: p.diagnosis || [],
  }));
}

async function getAllPatientsLite() {
  const mongo = await getAllPatientsLiteFromMongo().catch(() => null);
  if (mongo && mongo.length) return mongo;
  return getAllPatientsLiteFromDataset();
}

function extractLikelyPatientName(query) {
  const text = String(query || '').trim();
  const patterns = [
    /(?:of|for|about)\s+([a-zA-Z][a-zA-Z\s]{2,50})/i,
    /patient\s+([a-zA-Z][a-zA-Z\s]{2,50})/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

async function resolvePatientIdByName(name) {
  const target = normalizeName(name)
    .replace(
      /\b(patient|details|detail|history|medications|medicine|disease|diagnosis|summary|consultation|brief|for|about|of|give|me|the|recent|what|is|and|tell|please)\b/g,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim();
  if (!target) return null;
  const all = await getAllPatientsLite();
  if (!all.length) return null;

  const exact = all.find((p) => normalizeName(p.name) === target);
  if (exact) return exact;

  const contains = all.find((p) => normalizeName(p.name).includes(target) || target.includes(normalizeName(p.name)));
  if (contains) return contains;

  return null;
}

async function getPatientContext(patientId) {
  const fromMongo = await getFromMongo(patientId).catch(() => null);
  if (fromMongo) return { source: 'mongo', ...fromMongo };
  const fromDataset = getFromDataset(patientId);
  if (fromDataset) return { source: 'dataset', ...fromDataset };
  return null;
}

module.exports = {
  getPatientContext,
  getAllPatientsLite,
  extractLikelyPatientName,
  resolvePatientIdByName,
};

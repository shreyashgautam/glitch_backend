require("dotenv").config();

const fs = require("fs");
const path = require("path");
const Tesseract = require("tesseract.js");
const { GoogleGenerativeAI } = require("@google/generative-ai");

function getGemini(apiKeyOverride) {
  const key = apiKeyOverride || process.env.GEMINI_API_KEY;
  if (!key) return null;
  return new GoogleGenerativeAI(key);
}

async function extractRawText(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".txt") {
    return fs.readFileSync(filePath, "utf8");
  }

  // Tesseract can read images directly. For PDFs this may work only if the
  // runtime supports rasterization; otherwise caller should pre-convert pages.
  const result = await Tesseract.recognize(filePath, "eng");
  return result.data?.text || "";
}

function heuristicExtract(rawText) {
  const text = rawText || "";
  const compact = text.replace(/\r/g, "");
  const lines = compact.split("\n").map((l) => l.trim()).filter(Boolean);

  const meds = [];
  for (const line of lines) {
    if (/(tablet|tab|capsule|cap|mg|ml|once|twice|daily|bd|od|hs)/i.test(line)) {
      meds.push(line);
    }
  }

  const bpMatch = compact.match(/(?:BP|Blood\s*Pressure)\s*[:\-]?\s*(\d{2,3})\s*\/\s*(\d{2,3})/i);
  const hba1cMatch = compact.match(/HbA1c\s*[:\-]?\s*([0-9]+(?:\.[0-9]+)?)/i);
  const crMatch = compact.match(/(?:Creatinine|Serum\s*Creatinine)\s*[:\-]?\s*([0-9]+(?:\.[0-9]+)?)/i);
  const egfrMatch = compact.match(/eGFR\s*[:\-]?\s*([0-9]+(?:\.[0-9]+)?)/i);
  const hbMatch = compact.match(/(?:Haemoglobin|Hemoglobin|Hb)\s*[:\-]?\s*([0-9]+(?:\.[0-9]+)?)/i);

  return {
    patient_name: null,
    symptoms: [],
    medications: meds.slice(0, 20),
    diagnosis: [],
    allergies: [],
    tests_recommended: [],
    clinical_summary: lines.slice(0, 12).join(" "),
    lab_results: {
      BloodPressure: bpMatch ? { systolic: Number(bpMatch[1]), diastolic: Number(bpMatch[2]) } : null,
      HbA1c: hba1cMatch ? Number(hba1cMatch[1]) : null,
      SerumCreatinine: crMatch ? Number(crMatch[1]) : null,
      eGFR: egfrMatch ? Number(egfrMatch[1]) : null,
      Haemoglobin: hbMatch ? Number(hbMatch[1]) : null,
    },
    raw_text: compact.slice(0, 20000),
  };
}

async function llmStructure(rawText, apiKeyOverride, modelOverride) {
  const genAI = getGemini(apiKeyOverride);
  if (!genAI) return null;

  const model = genAI.getGenerativeModel({
    model: modelOverride || "gemini-3-flash-preview",
    systemInstruction: "Extract medical text into strict JSON only.",
  });

  const prompt = `Extract structured clinical data from this OCR text and return JSON only.
Schema:
{
  "patient_name": "string|null",
  "symptoms": ["string"],
  "medications": ["string"],
  "diagnosis": ["string"],
  "allergies": ["string"],
  "tests_recommended": ["string"],
  "clinical_summary": "string",
  "lab_results": {
    "BloodPressure": {"systolic": number, "diastolic": number} | null,
    "HbA1c": number | null,
    "SerumCreatinine": number | null,
    "eGFR": number | null,
    "Haemoglobin": number | null
  }
}

OCR TEXT:
${rawText.slice(0, 30000)}`;

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });

  const text = result.response?.text?.() || "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    return null;
  }
}

async function processUploadedDocument(filePath, apiKeyOverride, modelOverride) {
  try {
    const rawText = await extractRawText(filePath);
    if (!rawText || !rawText.trim()) {
      return { success: false, error: "OCR produced empty text" };
    }

    const llmOutput = await llmStructure(rawText, apiKeyOverride, modelOverride);
    const structured = llmOutput || heuristicExtract(rawText);

    return {
      success: true,
      source_file: filePath,
      raw_text: rawText.slice(0, 20000),
      structured,
      parser: llmOutput ? "gemini_json_extractor" : "heuristic_fallback",
    };
  } catch (error) {
    return {
      success: false,
      error: "OCR agent failed",
      message: error.message,
    };
  }
}

module.exports = { processUploadedDocument };

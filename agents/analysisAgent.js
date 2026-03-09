
require("dotenv").config({ path: "../.env" });

const { GoogleGenerativeAI } = require("@google/generative-ai");
const tools = require("../tools/patientTools");

// ─── Gemini Client ─────────────────────────────────────────────────────────────

// BUG FIX #6: initialise lazily so apiKeyOverride can be used per-call
function getGenAI(apiKeyOverride) {
  const key = apiKeyOverride || process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is missing. Set it in .env or pass apiKeyOverride.");
  return new GoogleGenerativeAI(key);
}

// ─── System Prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the Clinical Analysis Agent for Kathir Memorial Hospital, Chennai.

Your task is to analyse patient case sheets and produce insights for physicians before consultations.

IMPORTANT RULES:
- Never give a diagnosis or treatment decision.
- Frame everything as "insights for physician review".
- Always cite evidence with exact dates, values, or doctor note references.
- Highlight CRITICAL findings first, then HIGH, then MEDIUM.
- Use medical terminology followed by a plain-language explanation in parentheses.

For each consultation, analyse and report on:
  1. CRITICAL FLAGS     — immediate concerns requiring physician attention today
  2. WARNINGS           — high/medium issues to monitor or investigate
  3. LAB TREND INSIGHTS — key biomarker trends with supporting data
  4. DRUG INTERACTIONS  — detected medication risks and contraindications
  5. OVERDUE TESTS      — guideline-based follow-up tests that are due or missing
  6. KNOWN ALLERGIES    — any documented allergies or adverse reactions
  7. PHYSICIAN SUMMARY  — a concise 3–5 sentence pre-consultation brief

DISCLAIMER: Always end with — "All findings are insights for physician review and not clinical decisions. Clinical judgement must be applied by the physician."`;

// ─── Pre-Analysis Engine ────────────────────────────────────────────────────────

async function preAnalysePatient(patientId) {
  const caseSheet = tools.get_patient_case_sheet(patientId);

  // BUG FIX #3: return structured error instead of null so caller can handle gracefully
  if (!caseSheet || caseSheet.error) {
    return { error: caseSheet?.error || `Patient ${patientId} not found` };
  }

  // BUG FIX #4: handle both string medications and object medications safely
  const medications = (caseSheet.medications || []).map(m =>
    typeof m === "string" ? m : (m.name || JSON.stringify(m))
  );

  // Gather all clinical context in parallel for efficiency
  const [patterns, interactions, hba1c, creatinine, egfr, haemoglobin, bp, labTests, allergySearch] =
    await Promise.all([
      Promise.resolve(tools.flag_clinical_pattern(patientId)),
      Promise.resolve(tools.check_drug_interactions(medications)),
      Promise.resolve(tools.extract_lab_trends(patientId, "HbA1c")),
      Promise.resolve(tools.extract_lab_trends(patientId, "SerumCreatinine")),
      Promise.resolve(tools.extract_lab_trends(patientId, "eGFR")),
      Promise.resolve(tools.extract_lab_trends(patientId, "Haemoglobin")),
      Promise.resolve(tools.extract_lab_trends(patientId, "BloodPressure")),
      Promise.resolve(tools.recommend_lab_tests(patientId)),           // BUG FIX #10
      Promise.resolve(tools.search_patient_history(patientId, "allergy reaction adverse")), // BUG FIX #10
    ]);

  return {
    patient: {
      id: patientId,
      name: caseSheet.name,
      age: caseSheet.age,
      gender: caseSheet.gender,
      blood_group: caseSheet.blood_group || caseSheet.bloodGroup || null,
      diagnoses: caseSheet.diagnoses || caseSheet.primaryDiagnosis || caseSheet.secondaryDiagnosis || [],
      recent_visits: caseSheet.visits?.slice(-3), // last 3 visits for context
    },
    medications,
    clinical_patterns: patterns,
    drug_interactions: interactions,
    lab_trends: {
      HbA1c: hba1c,
      SerumCreatinine: creatinine,
      eGFR: egfr,
      Haemoglobin: haemoglobin,
      BloodPressure: bp,
    },
    overdue_lab_tests: labTests,             // BUG FIX #10
    allergy_history: allergySearch,          // BUG FIX #10
  };
}

// ─── Main Analysis Agent ────────────────────────────────────────────────────────

async function runAnalysisAgent(userQuery, patientId, apiKeyOverride, modelOverride, onTrace) {
  const traces = []; // BUG FIX #8: populate traces throughout

  function emit(trace) {
    const stamped = { ...trace, timestamp: Date.now() };
    traces.push(stamped);
    if (onTrace) onTrace(stamped);
  }

  try {
    // BUG FIX #7: input validation upfront
    if (!patientId || typeof patientId !== "string") {
      return { response: "Error: patientId is required.", traces };
    }
    if (!userQuery || typeof userQuery !== "string") {
      return { response: "Error: userQuery is required.", traces };
    }

    // BUG FIX #1: correct model name
    const modelName = modelOverride || "gemini-3-flash-preview";

    // BUG FIX #6: use apiKeyOverride if provided
    const genAI = getGenAI(apiKeyOverride);

    // BUG FIX #9: pass system prompt via systemInstruction, not as a contents role
    const model = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: SYSTEM_PROMPT,
    });

    emit({ type: "thinking", message: `Running pre-analysis for patient ${patientId}...` });

    const analysisData = await preAnalysePatient(patientId);

    if (analysisData.error) {
      emit({ type: "error", message: analysisData.error });
      return { response: `Patient data error: ${analysisData.error}`, traces };
    }

    emit({ type: "thinking", message: "Pre-analysis complete. Composing clinical prompt..." });

    // BUG FIX #2: removed the erroneous backtick code-fence wrappers inside the template string
    const prompt = `Patient ID: ${patientId}

Physician Query:
${userQuery}

Complete Patient Clinical Data:
${JSON.stringify(analysisData, null, 2)}

Please provide a structured physician-ready clinical insight summary following the format defined in your instructions.`;

    emit({ type: "thinking", message: `Sending request to ${modelName}...` });

    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
    });

    // Guard against empty or blocked responses
    const candidate = result.response?.candidates?.[0];
    if (!candidate) {
      throw new Error("Gemini returned no candidates. Response may have been blocked.");
    }

    const responseText = result.response.text();

    emit({ type: "complete", message: `Analysis complete via ${modelName}` });

    return { response: responseText, traces };

  } catch (error) {
    emit({ type: "error", message: error.message });
    return {
      response: `Error running Gemini analysis agent: ${error.message}`,
      traces,
    };
  }
}

module.exports = { runAnalysisAgent, preAnalysePatient };

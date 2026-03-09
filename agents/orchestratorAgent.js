const { processUploadedDocument } = require("./ocrAgent");
const { runIngestionAgent } = require("./ingestionAgent");
const { runAnalysisAgent } = require("./analysisAgent");
const { runTriageAgent } = require("./triageAgent");
const { runTransferAgent } = require("./transferAgent");

async function runOrchestratorAgent({
  patientId,
  filePath,
  query,
  fromDoctor,
  toSpecialty,
  reason,
  apiKey,
  model,
}) {
  const steps = [];

  if (!patientId || !filePath) {
    return { success: false, error: "patientId and filePath are required", steps };
  }

  const ocr = await processUploadedDocument(filePath, apiKey, model);
  steps.push({ step: "ocr", success: !!ocr.success, parser: ocr.parser || null, error: ocr.error || null });
  if (!ocr.success) {
    return { success: false, stage: "ocr", ocr, steps };
  }

  const ingestion = await runIngestionAgent(patientId, ocr.structured);
  steps.push({ step: "ingestion", success: !!ingestion.success, error: ingestion.error || null });
  if (!ingestion.success) {
    return { success: false, stage: "ingestion", ocr, ingestion, steps };
  }

  const analysis = await runAnalysisAgent(
    query || "Generate physician-ready insights from latest ingested records.",
    String(patientId),
    apiKey,
    model
  );
  steps.push({ step: "analysis", success: !String(analysis.response || "").startsWith("Error"), error: null });

  const triage = await runTriageAgent(String(patientId), apiKey);
  steps.push({ step: "triage", success: !triage.agent_error, error: triage.agent_error ? triage.error_message || "Triage fallback used" : null });

  let transfer = null;
  if (triage.needs_consultation) {
    transfer = await runTransferAgent({
      patientId: String(patientId),
      fromDoctor: fromDoctor || "Primary Physician",
      toSpecialty: toSpecialty || (triage.recommended_specialties?.[0]?.department || "General Medicine & Diabetology"),
      reason: reason || "Auto-generated from triage recommendation",
      includeAnalysis: true,
      apiKey,
      model,
    });
    steps.push({ step: "transfer", success: !!transfer.success, error: transfer.error || null });
  }

  return {
    success: true,
    pipeline: "OCR -> Ingestion -> Analysis -> Triage -> Transfer",
    patient_id: String(patientId),
    steps,
    ocr,
    ingestion,
    analysis,
    triage,
    transfer,
  };
}

module.exports = { runOrchestratorAgent };

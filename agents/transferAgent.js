const tools = require("../tools/patientTools");
const { runAnalysisAgent } = require("./analysisAgent");

async function runTransferAgent({
  patientId,
  fromDoctor,
  toSpecialty,
  reason,
  includeAnalysis = true,
  analysisQuery = "Generate physician transfer-ready summary with key risks and pending actions.",
  apiKey,
  model,
}) {
  try {
    if (!patientId || !fromDoctor || !toSpecialty) {
      return { success: false, error: "patientId, fromDoctor, toSpecialty are required" };
    }

    const patient = tools.get_patient_case_sheet(patientId);
    if (!patient || patient.error) {
      return { success: false, error: `Patient ${patientId} not found` };
    }

    const brief = tools.generate_consultation_brief(patientId);
    const flags = tools.flag_clinical_pattern(patientId, null);
    const overdue = tools.recommend_lab_tests(patientId);
    const medications = (patient.medications || []).map((m) => (typeof m === "string" ? m : m.name)).filter(Boolean);
    const interactions = tools.check_drug_interactions(medications);

    let analysis = null;
    if (includeAnalysis) {
      const result = await runAnalysisAgent(analysisQuery, String(patientId), apiKey, model);
      analysis = result.response || null;
    }

    const packet = {
      success: true,
      transfer_id: `TRF-${Date.now()}`,
      generated_at: new Date().toISOString(),
      patient_id: String(patientId),
      from_doctor: fromDoctor,
      to_specialty: toSpecialty,
      reason: reason || "Specialist review requested",
      patient_snapshot: {
        name: patient.name,
        age: patient.age,
        gender: patient.gender || null,
        diagnoses: patient.primaryDiagnosis || patient.diagnoses || [],
        allergies: patient.allergies || [],
      },
      critical_flags: Array.isArray(flags) ? flags.filter((f) => f.type === "CRITICAL" || f.type === "HIGH") : [],
      overdue_tests: overdue || [],
      drug_interactions: interactions || { interactions: [] },
      brief,
      physician_summary: analysis,
    };

    return packet;
  } catch (error) {
    return { success: false, error: "Transfer agent failed", message: error.message };
  }
}

module.exports = { runTransferAgent };

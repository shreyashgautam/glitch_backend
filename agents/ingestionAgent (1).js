require("dotenv").config();

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "../data");

// Load patient file
function loadPatient(patientId) {

  const file = path.join(DATA_DIR, `patient_${patientId}.json`);

  if (!fs.existsSync(file)) return null;

  return JSON.parse(fs.readFileSync(file, "utf8"));

}

// Save patient file
function savePatient(patientId, data) {

  const file = path.join(DATA_DIR, `patient_${patientId}.json`);

  fs.writeFileSync(file, JSON.stringify(data, null, 2));

}

// -----------------------------
// INGESTION AGENT
// -----------------------------

async function runIngestionAgent(patientId, structuredOCRData) {

  try {

    console.log("Running Ingestion Agent...");

    let patient = loadPatient(patientId);

    // If patient does not exist create new record
    if (!patient) {

      patient = {
        name: "Unknown",
        age: null,
        primaryDiagnosis: null,
        allergies: [],
        medications: [],
        labResults: {},
        visits: [],
        clinicalFlags: [],
        overdueTests: []
      };

    }

    // Add medications
    if (structuredOCRData.medications && structuredOCRData.medications.length > 0) {

      patient.medications = [
        ...new Set([...patient.medications, ...structuredOCRData.medications])
      ];

    }

    // Add vitals
    if (structuredOCRData.vitals && structuredOCRData.vitals.length > 0) {

      patient.visits.push({
        date: new Date().toISOString(),
        chiefComplaint: structuredOCRData.symptoms?.join(", ") || "Follow-up",
        doctor: "OCR Import",
        department: "General Medicine",
        clinicalNote: structuredOCRData.clinical_summary || "",
        plan: structuredOCRData.tests_recommended?.join(", ") || ""
      });

    }

    // Add symptoms as flags
    if (structuredOCRData.symptoms) {

      structuredOCRData.symptoms.forEach(symptom => {

        patient.clinicalFlags.push({
          type: "HIGH",
          flag: `Reported symptom: ${symptom}`
        });

      });

    }

    // Add recommended tests
    if (structuredOCRData.tests_recommended) {

      patient.overdueTests = [
        ...new Set([...patient.overdueTests, ...structuredOCRData.tests_recommended])
      ];

    }

    // Save updated patient record
    savePatient(patientId, patient);

    return {

      success: true,
      patient_id: patientId,
      message: "Patient data successfully ingested",
      updated_medications: patient.medications,
      total_visits: patient.visits.length

    };

  } catch (error) {

    return {

      success: false,
      error: "Ingestion Agent failed",
      message: error.message

    };

  }

}

module.exports = {
  runIngestionAgent
};
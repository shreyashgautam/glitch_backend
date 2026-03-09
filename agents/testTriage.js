require("dotenv").config({ path: "../.env" });

const { runTriageAgent } = require("./triageAgent");

const patientId = process.argv[2] || "P001";

/* ───────── Helpers ───────── */

function printHeader(title) {
  const line = "═".repeat(70);
  console.log("\n" + line);
  console.log("🏥  " + title);
  console.log(line + "\n");
}

function printJSON(data) {
  console.log(JSON.stringify(data, null, 2));
}

/* ───────── Test Runner ───────── */

async function runTest() {

  printHeader("KATHIR MEMORIAL TRIAGE AGENT TEST");

  console.log("Patient ID:", patientId);
  console.log("Model: llama-3.3-70b-versatile\n");

  try {

    const result = await runTriageAgent(patientId);

    console.log("TRIAGE RESULT\n");
    printJSON(result);

    console.log("\nSummary:");
    console.log(result.summary);

  } catch (err) {

    console.error("\nTest failed:");
    console.error(err);

  }
}

runTest();
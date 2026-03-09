const { runAnalysisAgent } = require('./analysisAgent');

async function test() {

  const result = await runAnalysisAgent(
    "Perform full clinical analysis of this patient",
    "P001"
  );

  console.log(result.response);

}

test();
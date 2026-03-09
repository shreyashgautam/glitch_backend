/**
 * WHATSAPP BOT — Add to backend
 * 
 * Setup Steps (do this once):
 * 1. npm install twilio
 * 2. Add to .env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM
 * 3. Install ngrok: npm install -g ngrok
 * 4. Run: ngrok http 4000
 * 5. Copy the https URL (e.g. https://abc123.ngrok-free.app)
 * 6. Go to Twilio Console → Messaging → Try it out → WhatsApp
 * 7. In "When a message comes in" → paste: https://abc123.ngrok-free.app/api/whatsapp/incoming
 * 8. Save
 * 9. To join sandbox: Send "join <your-sandbox-code>" to +14155238886 on WhatsApp
 *    (Twilio shows your code in the console)
 * 
 * DOCTOR COMMANDS:
 *   brief P001          → 60-second pre-consultation brief
 *   labs P001 HbA1c     → lab trend for a specific test
 *   flags P001          → all clinical flags
 *   drugs P001          → drug interactions
 *   ask P001 <question> → natural language query
 *   help                → show all commands
 */

const express = require('express');
const router = express.Router();
const twilio = require('twilio');
const tools = require('../tools/patientTools');
const { runAnalysisAgent } = require('../agents/analysisAgent');
const blockchain = require('../blockchain/logger');

const MessagingResponse = twilio.twiml.MessagingResponse;

// Format a brief into a compact WhatsApp message (60 seconds to read)
function formatBrief(brief, flags) {
  const critical = flags.filter(f => f.type === 'CRITICAL');
  const high = flags.filter(f => f.type === 'HIGH');

  let msg = `🏥 *Kathir Memorial — Patient Brief*\n`;
  msg += `*${brief.patientName}*, ${brief.age}M/F\n`;
  msg += `${brief.primaryDiagnosis?.join(' · ')}\n\n`;

  // Red flags first
  if (critical.length > 0) {
    msg += `🔴 *CRITICAL FLAGS*\n`;
    critical.forEach(f => { msg += `⚠️ ${f.flag}\n   _${f.evidence}_\n`; });
    msg += `\n`;
  }

  if (high.length > 0) {
    msg += `🟠 *HIGH PRIORITY*\n`;
    high.forEach(f => { msg += `• ${f.flag}\n`; });
    msg += `\n`;
  }

  // Medications
  msg += `💊 *Medications*\n`;
  brief.currentMedications?.forEach(m => {
    msg += `• ${m.name} ${m.dose} — ${m.frequency}\n`;
  });

  // Allergies
  if (brief.allergies?.length > 0) {
    msg += `\n🚫 *Allergies*: ${brief.allergies.join(', ')}\n`;
  }

  // Last labs
  msg += `\n🧪 *Recent Labs*\n`;
  Object.entries(brief.last3LabResults || {}).forEach(([test, values]) => {
    if (values.length > 0) {
      const latest = values[values.length - 1];
      const val = latest.value || `${latest.systolic}/${latest.diastolic}`;
      const status = latest.status?.toUpperCase();
      const emoji = status === 'CRITICAL' ? '🔴' : status === 'HIGH' ? '🟠' : status === 'NORMAL' ? '🟢' : '🟡';
      msg += `${emoji} ${test}: ${val} ${latest.unit || ''} (${latest.date})\n`;
    }
  });

  // Overdue tests
  if (brief.overdueTests?.length > 0) {
    msg += `\n📋 *Overdue Tests*\n`;
    brief.overdueTests.forEach(t => {
      msg += `• ${t.test}${t.overdueDays > 0 ? ` — ${t.overdueDays}d overdue` : ''}\n`;
    });
  }

  msg += `\n_All findings are insights for physician review_`;
  return msg;
}

function formatFlags(flags) {
  if (!flags.length) return '✅ No critical flags for this patient.';
  let msg = `🚩 *Clinical Flags*\n\n`;
  flags.forEach(f => {
    const emoji = f.type === 'CRITICAL' ? '🔴' : f.type === 'HIGH' ? '🟠' : f.type === 'MEDIUM' ? '🟡' : '🟢';
    msg += `${emoji} *${f.type}* — ${f.flag}\n`;
    msg += `   ${f.evidence}\n`;
    msg += `   _${f.recommendation}_\n\n`;
  });
  return msg;
}

function formatLabs(labData, testName) {
  if (labData.error) return `❌ ${labData.error}`;
  let msg = `🧪 *${testName} Trend*\n`;
  msg += `Trend: ${labData.trend === 'WORSENING' ? '📈 WORSENING ⚠️' : labData.trend === 'IMPROVING' ? '📉 IMPROVING ✅' : '➡️ STABLE'}\n\n`;
  labData.data?.slice(-5).forEach(d => {
    const status = d.status?.toUpperCase();
    const emoji = status === 'CRITICAL' ? '🔴' : status === 'HIGH' ? '🟠' : status === 'NORMAL' ? '🟢' : '🟡';
    const val = d.value || `${d.systolic}/${d.diastolic}`;
    msg += `${emoji} ${d.date}: *${val}* ${d.unit || ''}\n`;
  });
  msg += `\nRef: ${labData.data?.[0]?.referenceRange || 'N/A'}`;
  return msg;
}

function formatDrugs(result) {
  if (!result.interactions?.length) return '✅ No drug interactions detected.';
  let msg = `💊 *Drug Interactions*\n`;
  if (result.hasCritical) msg += `🔴 CRITICAL INTERACTION DETECTED\n\n`;
  result.interactions.forEach(i => {
    const emoji = i.severity === 'CRITICAL' ? '🔴' : i.severity === 'HIGH' ? '🟠' : '🟡';
    msg += `${emoji} *${i.drug1} + ${i.drug2}*\n`;
    msg += `   Risk: ${i.risk}\n`;
    msg += `   Action: ${i.action}\n\n`;
  });
  return msg;
}

const HELP_MSG = `🏥 *Kathir Memorial — Doctor Bot*

*Commands:*
• \`brief P001\` — 60-sec pre-consultation brief
• \`labs P001 HbA1c\` — lab trend
• \`flags P001\` — clinical flags
• \`drugs P001\` — drug interactions
• \`ask P001 <question>\` — NL query
• \`help\` — show this menu

*Available tests:*
HbA1c, SerumCreatinine, eGFR, BloodPressure, TSH, Haemoglobin

*Example:*
ask P001 Has this patient ever had a reaction to penicillin?`;

// Main incoming webhook
router.post('/incoming', async (req, res) => {
  const twiml = new MessagingResponse();
  const incomingMsg = (req.body.Body || '').trim().toLowerCase();
  const from = req.body.From || 'UNKNOWN';
  const parts = incomingMsg.split(' ');
  const command = parts[0];

  blockchain.addBlock('WHATSAPP_MESSAGE', from, parts[1]?.toUpperCase() || null, `WhatsApp command: ${command}`);

  let reply = '';

  try {
    if (command === 'help' || !command) {
      reply = HELP_MSG;

    } else if (command === 'brief' && parts[1]) {
      const patientId = parts[1].toUpperCase();
      const brief = tools.generate_consultation_brief(patientId);
      const flags = tools.flag_clinical_pattern(patientId, null);
      if (brief.error) reply = `❌ Patient ${patientId} not found. Try P001 or P002.`;
      else reply = formatBrief(brief, flags);

    } else if (command === 'labs' && parts[1] && parts[2]) {
      const patientId = parts[1].toUpperCase();
      // Try to match test name case-insensitively
      const testMap = { 'hba1c': 'HbA1c', 'creatinine': 'SerumCreatinine', 'serumcreatinine': 'SerumCreatinine', 'egfr': 'eGFR', 'bp': 'BloodPressure', 'bloodpressure': 'BloodPressure', 'tsh': 'TSH', 'haemoglobin': 'Haemoglobin', 'hemoglobin': 'Haemoglobin', 'lipid': 'LipidProfile' };
      const testName = testMap[parts[2].toLowerCase()] || parts[2];
      const labData = tools.extract_lab_trends(patientId, testName, null);
      reply = formatLabs(labData, testName);

    } else if (command === 'flags' && parts[1]) {
      const patientId = parts[1].toUpperCase();
      const flags = tools.flag_clinical_pattern(patientId, null);
      if (!flags || flags.error) reply = `❌ Patient ${parts[1].toUpperCase()} not found.`;
      else reply = formatFlags(Array.isArray(flags) ? flags : []);

    } else if (command === 'drugs' && parts[1]) {
      const patientId = parts[1].toUpperCase();
      const patient = tools.get_patient_case_sheet(patientId);
      if (patient.error) reply = `❌ Patient ${patientId} not found.`;
      else {
        const meds = patient.medications.map(m => m.name);
        const result = tools.check_drug_interactions(meds);
        reply = formatDrugs(result);
      }

    } else if (command === 'ask' && parts[1] && parts.length > 2) {
      const patientId = parts[1].toUpperCase();
      const query = parts.slice(2).join(' ');
      reply = `🤔 Querying agent for ${patientId}...\n_This may take a few seconds_`;
      twiml.message(reply);
      res.type('text/xml').send(twiml.toString());

      // Run agent asynchronously and send follow-up
      try {
        const result = await runAnalysisAgent(query, patientId, null, null, null);
        // Send follow-up message via Twilio REST
        const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        const answer = result.response?.substring(0, 1500) + (result.response?.length > 1500 ? '\n...(truncated)' : '');
        await client.messages.create({
          from: `whatsapp:${process.env.TWILIO_WHATSAPP_FROM || '+14155238886'}`,
          to: from,
          body: `💡 *Clinical Insight*\n\n${answer}\n\n_For physician review only_`
        });
        blockchain.addBlock('WHATSAPP_NL_QUERY', from, patientId, `Query: "${query.substring(0, 60)}"`);
      } catch (e) {
        const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        await client.messages.create({ from: `whatsapp:${process.env.TWILIO_WHATSAPP_FROM || '+14155238886'}`, to: from, body: `❌ Query failed: ${e.message}` });
      }
      return;

    } else {
      reply = `❓ Unknown command. Send *help* to see available commands.\n\nExample: _brief P001_`;
    }

  } catch (e) {
    reply = `❌ Error: ${e.message}\n\nSend *help* for usage.`;
  }

  // Truncate to WhatsApp limit
  if (reply.length > 1600) reply = reply.substring(0, 1580) + '\n...(truncated)';

  twiml.message(reply);
  res.type('text/xml').send(twiml.toString());
});

module.exports = router;

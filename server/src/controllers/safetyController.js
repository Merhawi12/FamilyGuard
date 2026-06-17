const { analyzeParent } = require('../utils/safetyAnalyzer');

// POST /api/safety/analyze  — manually trigger analysis for the authenticated parent
const runAnalysis = async (req, res) => {
  try {
    const io = req.app.get('io');
    const findings = await analyzeParent(io, req.user.id);
    res.json({ analyzed: true, alertsCreated: findings.length, alerts: findings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = { runAnalysis };

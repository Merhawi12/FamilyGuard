const { analyzeParent } = require('../utils/safetyAnalyzer');

// POST /api/safety/analyze  — manually trigger analysis for the authenticated parent
const runAnalysis = async (req, res, next) => {
  try {
    const io = req.app.get('io');
    const findings = await analyzeParent(io, req.user.id);
    res.json({ analyzed: true, alertsCreated: findings.length, alerts: findings });
  } catch (err) {
    next(err);
  }
};

module.exports = { runAnalysis };

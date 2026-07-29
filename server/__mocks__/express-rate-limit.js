// Auto-applied manual mock (adjacent to node_modules): rate limiting is disabled
// under test so repeated auth calls don't trip 429s. Returns a pass-through factory.
module.exports = () => (req, res, next) => next();

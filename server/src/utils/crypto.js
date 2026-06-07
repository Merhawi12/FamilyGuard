const crypto = require('crypto');

const generateLinkingCode = () => crypto.randomBytes(4).toString('hex').toUpperCase();

const generateInviteToken = () => crypto.randomBytes(20).toString('hex');

module.exports = { generateLinkingCode, generateInviteToken };

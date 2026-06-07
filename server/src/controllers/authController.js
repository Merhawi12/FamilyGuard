const jwt = require('jsonwebtoken');
const { User } = require('../models');
const { sendWelcomeEmail, sendAdminRegistrationNotification } = require('../utils/email');

const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });

const serializeUser = (user) => {
  const trialEndsAt = user.trialEndsAt ? new Date(user.trialEndsAt).toISOString() : null;
  const trialExpired = trialEndsAt && new Date() > new Date(trialEndsAt);
  return { id: user.id, name: user.name, email: user.email, role: user.role, plan: user.plan, trialEndsAt, trialExpired };
};

const register = async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });

    const existing = await User.findOne({ where: { email } });
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const user = await User.create({ name, email, passwordHash: password, trialEndsAt });
    const token = signToken(user.id);
    sendWelcomeEmail({ name, email }).catch((err) =>
      console.error('Welcome email failed:', err.message)
    );
    sendAdminRegistrationNotification({ name, email }).catch((err) =>
      console.error('Admin notification email failed:', err.message)
    );
    res.status(201).json({ token, user: serializeUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = await User.findOne({ where: { email } });
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = signToken(user.id);
    res.json({ token, user: serializeUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const me = async (req, res) => {
  res.json(serializeUser(req.user));
};

module.exports = { register, login, me };

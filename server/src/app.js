require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { sequelize } = require('./config/db');
const { User, Child, Device, ActivityLog, ScreenTimeRule, AppRule, WebsiteRule, Alert } = require('./models');
const initSocketHandlers = require('./sockets/deviceEvents');
const { analyzeParent } = require('./utils/safetyAnalyzer');

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: process.env.CLIENT_URL || 'http://localhost:3000', credentials: true },
});

app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:3000', credentials: true }));

// Stripe webhook must receive raw body — register before express.json()
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));

app.use(express.json());

app.use('/api/auth', require('./routes/auth'));
app.use('/api/auth/mfa', require('./routes/mfa'));
app.use('/api/children', require('./routes/children'));
app.use('/api/devices', require('./routes/devices'));
app.use('/api/screen-time', require('./routes/screenTime'));
app.use('/api/blocking', require('./routes/blocking'));
app.use('/api/activity', require('./routes/activity'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/alerts', require('./routes/alerts'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/locations', require('./routes/locations'));
app.use('/api/safe-zones', require('./routes/safeZones'));
app.use('/api/chats', require('./routes/chats'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/safety', require('./routes/safety'));
app.use('/api/contacts', require('./routes/contacts'));
app.use('/api/notifications', require('./routes/notifications'));

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.set('io', io);
initSocketHandlers(io);

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    await sequelize.sync();

    // Safely add any new columns that don't yet exist in the SQLite schema
    const qi = sequelize.getQueryInterface();
    const addIfMissing = async (table, col, def) => {
      try { await qi.addColumn(table, col, def); } catch { /* already exists */ }
    };
    await addIfMissing('users', 'notification_prefs', { type: require('sequelize').DataTypes.TEXT, defaultValue: '{}' });
    await addIfMissing('users', 'permissions', { type: require('sequelize').DataTypes.JSON, defaultValue: [] });
    await addIfMissing('users', 'last_login_at', { type: require('sequelize').DataTypes.DATE });
    await addIfMissing('users', 'failed_login_attempts', { type: require('sequelize').DataTypes.INTEGER, defaultValue: 0 });
    await addIfMissing('users', 'locked_until', { type: require('sequelize').DataTypes.DATE });
    await addIfMissing('contacts', 'id', null).catch(() => {}); // triggers table creation via sync

    const addIndexIfMissing = async (table, fields) => {
      try { await qi.addIndex(table, fields); } catch { /* already exists */ }
    };
    await addIndexIfMissing('activity_logs', ['device_id']);
    await addIndexIfMissing('activity_logs', ['child_id', 'start_time']);
    await addIndexIfMissing('locations', ['device_id']);
    await addIndexIfMissing('locations', ['child_id', 'recorded_at']);
    await addIndexIfMissing('alerts', ['parent_id']);
    await addIndexIfMissing('alerts', ['child_id']);

    httpServer.listen(PORT, () => console.log(`FamilyGuard server running on port ${PORT}`));

    // Hourly safety pattern analysis for all parents
    setInterval(async () => {
      try {
        const parents = await User.findAll({ where: { role: 'parent', isActive: true }, attributes: ['id'] });
        for (const parent of parents) {
          await analyzeParent(io, parent.id).catch((err) =>
            console.error(`[safety] analysis failed for ${parent.id}:`, err.message)
          );
        }
      } catch (err) {
        console.error('[safety] scheduler error:', err.message);
      }
    }, 60 * 60 * 1000);
  } catch (err) {
    console.error('DB connection failed:', err);
    process.exit(1);
  }
};

startServer();

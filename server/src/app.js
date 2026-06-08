require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { sequelize } = require('./config/db');
const { User, Child, Device, ActivityLog, ScreenTimeRule, AppRule, WebsiteRule, Alert } = require('./models');
const initSocketHandlers = require('./sockets/deviceEvents');

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: process.env.CLIENT_URL || 'http://localhost:3000', credentials: true },
});

app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:3000', credentials: true }));
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

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.set('io', io);
initSocketHandlers(io);

const PORT = process.env.PORT || 5000;

sequelize
  .sync({ alter: process.env.NODE_ENV === 'development' })
  .then(() => {
    httpServer.listen(PORT, () => console.log(`FamilyGuard server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('DB connection failed:', err);
    process.exit(1);
  });

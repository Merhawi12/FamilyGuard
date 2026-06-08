const User = require('./User');
const Child = require('./Child');
const Device = require('./Device');
const ActivityLog = require('./ActivityLog');
const ScreenTimeRule = require('./ScreenTimeRule');
const AppRule = require('./AppRule');
const WebsiteRule = require('./WebsiteRule');
const Alert = require('./Alert');
const AuditLog = require('./AuditLog');
const Location = require('./Location');
const SafeZone = require('./SafeZone');
const Message = require('./Message');

// Associations
User.hasMany(Child, { foreignKey: 'parentId', as: 'children' });
Child.belongsTo(User, { foreignKey: 'parentId', as: 'parent' });

Child.hasMany(Device, { foreignKey: 'childId', as: 'devices' });
Device.belongsTo(Child, { foreignKey: 'childId', as: 'child' });

Child.hasMany(ActivityLog, { foreignKey: 'childId', as: 'activities' });
ActivityLog.belongsTo(Child, { foreignKey: 'childId', as: 'child' });
ActivityLog.belongsTo(Device, { foreignKey: 'deviceId', as: 'device' });

Child.hasOne(ScreenTimeRule, { foreignKey: 'childId', as: 'screenTimeRule' });
ScreenTimeRule.belongsTo(Child, { foreignKey: 'childId', as: 'child' });

Child.hasMany(AppRule, { foreignKey: 'childId', as: 'appRules' });
AppRule.belongsTo(Child, { foreignKey: 'childId', as: 'child' });

Child.hasMany(WebsiteRule, { foreignKey: 'childId', as: 'websiteRules' });
WebsiteRule.belongsTo(Child, { foreignKey: 'childId', as: 'child' });

User.hasMany(Alert, { foreignKey: 'parentId', as: 'alerts' });
Alert.belongsTo(User, { foreignKey: 'parentId', as: 'parent' });

User.hasMany(AuditLog, { foreignKey: 'userId', as: 'auditLogs' });
AuditLog.belongsTo(User, { foreignKey: 'userId', as: 'user' });

Child.hasMany(Location, { foreignKey: 'childId', as: 'locations' });
Location.belongsTo(Child, { foreignKey: 'childId', as: 'child' });
Location.belongsTo(Device, { foreignKey: 'deviceId', as: 'device' });

User.hasMany(SafeZone, { foreignKey: 'parentId', as: 'safeZones' });
SafeZone.belongsTo(User, { foreignKey: 'parentId', as: 'parent' });
SafeZone.belongsTo(Child, { foreignKey: 'childId', as: 'child' });

User.hasMany(Message, { foreignKey: 'parentId', as: 'sentMessages' });
Child.hasMany(Message, { foreignKey: 'childId', as: 'messages' });
Message.belongsTo(User, { foreignKey: 'parentId', as: 'parent' });
Message.belongsTo(Child, { foreignKey: 'childId', as: 'child' });

module.exports = {
  User, Child, Device, ActivityLog, ScreenTimeRule, AppRule, WebsiteRule, Alert, AuditLog,
  Location, SafeZone, Message,
};

#!/usr/bin/env node
/**
 * Migration CLI — run locally or through the Cloud SQL Auth Proxy. Deployed
 * instances migrate themselves at boot; this is for inspecting and reverting.
 *
 *   npm run migrate           apply everything pending
 *   npm run migrate:down      roll back the most recent migration
 *   npm run migrate:status    list applied and pending migrations
 */
const { sequelize } = require('../src/config/db');
const { migrator } = require('../src/db/migrator');

require('../src/models'); // define models so sync-created tables exist first

const commands = {
  async up() {
    await sequelize.sync();
    const applied = await migrator.up();
    console.log(applied.length ? `Applied: ${applied.map((m) => m.name).join(', ')}` : 'Nothing to apply');
  },

  async down() {
    const reverted = await migrator.down();
    console.log(reverted.length ? `Reverted: ${reverted.map((m) => m.name).join(', ')}` : 'Nothing to revert');
  },

  async status() {
    const [executed, pending] = await Promise.all([migrator.executed(), migrator.pending()]);
    console.log('Applied:', executed.map((m) => m.name).join(', ') || '(none)');
    console.log('Pending:', pending.map((m) => m.name).join(', ') || '(none)');
  },
};

const run = async () => {
  const command = commands[process.argv[2] || 'up'];
  if (!command) {
    console.error(`Unknown command. Use one of: ${Object.keys(commands).join(', ')}`);
    process.exit(2);
  }

  try {
    await command();
    await sequelize.close();
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  }
};

run();

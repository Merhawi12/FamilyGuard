const { Sequelize } = require('sequelize');
require('dotenv').config();

const isPostgres = process.env.DATABASE_URL?.startsWith('postgresql') || process.env.DATABASE_URL?.startsWith('postgres');

const sequelize = isPostgres
  ? new Sequelize(process.env.DATABASE_URL, {
      dialect: 'postgres',
      logging: false,
      pool: { max: 10, min: 0, acquire: 30000, idle: 10000 },
    })
  : new Sequelize({
      dialect: 'sqlite',
      storage: process.env.DB_PATH || './familyguard.sqlite',
      logging: false,
    });

module.exports = { sequelize };

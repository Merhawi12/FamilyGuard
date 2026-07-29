// Creates a fresh in-memory schema before each test file and tears it down after.
const { sequelize } = require('../src/config/db');
require('../src/models'); // define models + associations

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

afterAll(async () => {
  await sequelize.close();
});

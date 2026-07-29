const { SystemSetting } = require('../models');

const getSetting = async (key, fallback = null) => {
  const row = await SystemSetting.findByPk(key);
  return row ? row.value : fallback;
};

const setSetting = async (key, value) => {
  await SystemSetting.upsert({ key, value });
  return value;
};

module.exports = { getSetting, setSetting };

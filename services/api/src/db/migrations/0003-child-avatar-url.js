const { DataTypes } = require('sequelize');

/** Adds the S3/CloudFront URL of an uploaded child profile photo. */
module.exports = {
  async up(queryInterface) {
    const columns = await queryInterface.describeTable('children');
    if (!columns.avatar_url) {
      await queryInterface.addColumn('children', 'avatar_url', { type: DataTypes.STRING });
    }
  },

  async down(queryInterface) {
    const columns = await queryInterface.describeTable('children');
    if (columns.avatar_url) await queryInterface.removeColumn('children', 'avatar_url');
  },
};

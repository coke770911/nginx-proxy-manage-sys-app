'use strict';
const { Sequelize } = require('sequelize');
const config = require('../config');

const sequelize = new Sequelize(config.db.name, config.db.user, config.db.password, {
  host: config.db.host,
  port: config.db.port,
  dialect: 'mssql',
  logging: false,
  timezone: '+00:00', // DATETIME2 一律以 UTC 讀寫
  dialectOptions: {
    options: {
      encrypt: config.db.encrypt,
      trustServerCertificate: config.db.trustServerCertificate,
      useUTC: true,
    },
  },
  pool: { max: 10, min: 0, idle: 10000 },
});

module.exports = sequelize;

'use strict';
const { DataTypes } = require('sequelize');
const sequelize = require('../db');

const stamps = { freezeTableName: true, createdAt: 'CreatedAt', updatedAt: 'UpdatedAt' };
const pk = (type = DataTypes.INTEGER) => ({ type, primaryKey: true, autoIncrement: true });

const ProxyNode = sequelize.define('ProxyNode', {
  Id: pk(),
  NodeName: { type: DataTypes.STRING(100), allowNull: false },
  IpAddress: { type: DataTypes.STRING(255), allowNull: false },
  SshPort: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 22 },
  SshUser: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'deployer' },
  SshKeyPath: { type: DataTypes.STRING(260) },
  HostKeySha256: { type: DataTypes.STRING(100) },
  IsActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  HealthStatus: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'UNKNOWN' },
  HealthMessage: { type: DataTypes.STRING(500) },
  LastHealthCheckAt: { type: DataTypes.DATE },
  LastSyncAt: { type: DataTypes.DATE },
}, { tableName: 'ProxyNodes', ...stamps });

const SslCertificate = sequelize.define('SslCertificate', {
  Id: pk(),
  Alias: { type: DataTypes.STRING(200), allowNull: false },
  SanDomains: { type: DataTypes.TEXT, allowNull: false },
  CertPem: { type: DataTypes.TEXT, allowNull: false },
  KeyPem: { type: DataTypes.TEXT, allowNull: false },
  Issuer: { type: DataTypes.STRING(500) },
  Subject: { type: DataTypes.STRING(500) },
  Fingerprint: { type: DataTypes.STRING(100), allowNull: false },
  ValidFrom: { type: DataTypes.DATE, allowNull: false },
  ValidTo: { type: DataTypes.DATE, allowNull: false },
}, { tableName: 'SslCertificates', ...stamps });

const DomainRule = sequelize.define('DomainRule', {
  Id: pk(),
  DomainName: { type: DataTypes.STRING(253), allowNull: false },
  TargetIp: { type: DataTypes.STRING(255), allowNull: false },
  TargetPort: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 80 },
  CertificateId: { type: DataTypes.INTEGER, allowNull: false },
  ForceHttps: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  EnableWebSocket: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  ClientMaxBodySize: { type: DataTypes.STRING(16), allowNull: false, defaultValue: '50M' },
  IsActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  IsMaintenance: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  CustomNginxSnippet: { type: DataTypes.TEXT },
  Remark: { type: DataTypes.STRING(500) },
}, { tableName: 'DomainRules', ...stamps });

const DeployLog = sequelize.define('DeployLog', {
  Id: pk(DataTypes.BIGINT),
  TriggeredBy: { type: DataTypes.STRING(100), allowNull: false, defaultValue: 'admin' },
  TriggerIp: { type: DataTypes.STRING(64) },
  StartedAt: { type: DataTypes.DATE, allowNull: false },
  FinishedAt: { type: DataTypes.DATE },
  Status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'RUNNING' },
  RuleCount: { type: DataTypes.INTEGER },
  ErrorDetail: { type: DataTypes.TEXT },
  NodeResults: { type: DataTypes.TEXT },
  LogText: { type: DataTypes.TEXT },
}, { tableName: 'DeployLogs', freezeTableName: true, timestamps: false });

DomainRule.belongsTo(SslCertificate, { foreignKey: 'CertificateId', as: 'certificate' });
SslCertificate.hasMany(DomainRule, { foreignKey: 'CertificateId', as: 'rules' });

module.exports = { sequelize, ProxyNode, SslCertificate, DomainRule, DeployLog };

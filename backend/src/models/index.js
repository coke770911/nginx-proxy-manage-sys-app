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
  ClientMaxBodySize: { type: DataTypes.STRING(16), allowNull: false, defaultValue: '2M' },
  IsActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  IsMaintenance: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  CustomNginxSnippet: { type: DataTypes.TEXT },
  Remark: { type: DataTypes.STRING(500) },
  LbMethod: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'round_robin' },
  LbCookieName: { type: DataTypes.STRING(64) },
}, { tableName: 'DomainRules', ...stamps });

const RuleUpstream = sequelize.define('RuleUpstream', {
  Id: pk(),
  RuleId: { type: DataTypes.INTEGER, allowNull: false },
  Host: { type: DataTypes.STRING(255), allowNull: false },
  Port: { type: DataTypes.INTEGER, allowNull: false },
  Weight: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  IsBackup: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  IsActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  SortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
}, { tableName: 'RuleUpstreams', freezeTableName: true, timestamps: false });

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

const AuditLog = sequelize.define('AuditLog', {
  Id: pk(DataTypes.BIGINT),
  CreatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  Username: { type: DataTypes.STRING(100), allowNull: false },
  ClientIp: { type: DataTypes.STRING(64) },
  Action: { type: DataTypes.STRING(20), allowNull: false },
  TargetType: { type: DataTypes.STRING(20), allowNull: false },
  TargetId: { type: DataTypes.STRING(50) },
  TargetName: { type: DataTypes.STRING(300) },
  Success: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  Detail: { type: DataTypes.TEXT },
}, { tableName: 'AuditLogs', freezeTableName: true, timestamps: false });

const AdminAccount = sequelize.define('AdminAccount', {
  Id: pk(),
  Username: { type: DataTypes.STRING(100), allowNull: false, unique: true },
  DisplayName: { type: DataTypes.STRING(100) },
  IsActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  Remark: { type: DataTypes.STRING(300) },
  CreatedBy: { type: DataTypes.STRING(100) },
  LastLoginAt: { type: DataTypes.DATE },
}, { tableName: 'AdminAccounts', ...stamps });

DomainRule.belongsTo(SslCertificate, { foreignKey: 'CertificateId', as: 'certificate' });
SslCertificate.hasMany(DomainRule, { foreignKey: 'CertificateId', as: 'rules' });
DomainRule.hasMany(RuleUpstream, { foreignKey: 'RuleId', as: 'Upstreams', onDelete: 'CASCADE' });
RuleUpstream.belongsTo(DomainRule, { foreignKey: 'RuleId' });

module.exports = { sequelize, ProxyNode, SslCertificate, DomainRule, RuleUpstream, DeployLog, AuditLog, AdminAccount };

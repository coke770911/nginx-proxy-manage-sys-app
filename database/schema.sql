/* ============================================================================
   校園網域反向代理與 SSL 憑證集中管理系統（Nginx HA Proxy Manager）
   SQL Server (T-SQL) DDL + 初始資料
   - 可重複執行（idempotent）：資料表已存在則略過
   - 所有時間欄位一律存 UTC（SYSUTCDATETIME）
   ========================================================================== */
IF DB_ID(N'NginxProxyManager') IS NULL
    CREATE DATABASE NginxProxyManager COLLATE Chinese_Taiwan_Stroke_CI_AS;
GO
USE NginxProxyManager;
GO

/* ---------------------------------------------------------------------------
   1. ProxyNodes — Nginx 資料轉發節點（兩台 Ubuntu 24.04）
   --------------------------------------------------------------------------- */
IF OBJECT_ID(N'dbo.ProxyNodes', N'U') IS NULL
CREATE TABLE dbo.ProxyNodes (
    Id                INT IDENTITY(1,1)  NOT NULL CONSTRAINT PK_ProxyNodes PRIMARY KEY,
    NodeName          NVARCHAR(100)      NOT NULL,                       -- 例如 nginx-node1
    IpAddress         NVARCHAR(255)      NOT NULL,                       -- SSH 連線位址
    SshPort           INT                NOT NULL CONSTRAINT DF_ProxyNodes_SshPort DEFAULT (22),
    SshUser           NVARCHAR(64)       NOT NULL CONSTRAINT DF_ProxyNodes_SshUser DEFAULT (N'deployer'),
    SshKeyPath        NVARCHAR(260)      NULL,                           -- NULL = 使用 .env 的 SSH_KEY_PATH
    HostKeySha256     NVARCHAR(100)      NULL,                           -- 主機金鑰指紋 (SHA256:xxxx)，NULL = 不驗證
    IsActive          BIT                NOT NULL CONSTRAINT DF_ProxyNodes_IsActive DEFAULT (1),
    HealthStatus      NVARCHAR(16)       NOT NULL CONSTRAINT DF_ProxyNodes_Health DEFAULT (N'UNKNOWN'),
    HealthMessage     NVARCHAR(500)      NULL,
    LastHealthCheckAt DATETIME2(3)       NULL,
    LastSyncAt        DATETIME2(3)       NULL,
    CreatedAt         DATETIME2(3)       NOT NULL CONSTRAINT DF_ProxyNodes_CreatedAt DEFAULT (SYSUTCDATETIME()),
    UpdatedAt         DATETIME2(3)       NOT NULL CONSTRAINT DF_ProxyNodes_UpdatedAt DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT UQ_ProxyNodes_NodeName UNIQUE (NodeName),
    CONSTRAINT CK_ProxyNodes_SshPort  CHECK (SshPort BETWEEN 1 AND 65535),
    CONSTRAINT CK_ProxyNodes_Health   CHECK (HealthStatus IN (N'UNKNOWN', N'ONLINE', N'DEGRADED', N'OFFLINE'))
);
GO

/* ---------------------------------------------------------------------------
   2. SslCertificates — SSL 憑證庫
   --------------------------------------------------------------------------- */
IF OBJECT_ID(N'dbo.SslCertificates', N'U') IS NULL
CREATE TABLE dbo.SslCertificates (
    Id          INT IDENTITY(1,1)  NOT NULL CONSTRAINT PK_SslCertificates PRIMARY KEY,
    Alias       NVARCHAR(200)      NOT NULL,                             -- 例如「*.aeust.edu.tw 萬用字元憑證」
    SanDomains  NVARCHAR(MAX)      NOT NULL,                             -- 涵蓋網域 (SAN)，逗號分隔
    CertPem     NVARCHAR(MAX)      NOT NULL,                             -- Fullchain PEM（葉憑證 + 中繼憑證）
    KeyPem      NVARCHAR(MAX)      NOT NULL,                             -- 無密碼私鑰 PEM（PKCS#8）
    Issuer      NVARCHAR(500)      NULL,
    Subject     NVARCHAR(500)      NULL,
    Fingerprint NVARCHAR(100)      NOT NULL,                             -- SHA-256 指紋，避免重複匯入
    ValidFrom   DATETIME2(3)       NOT NULL,
    ValidTo     DATETIME2(3)       NOT NULL,
    CreatedAt   DATETIME2(3)       NOT NULL CONSTRAINT DF_SslCertificates_CreatedAt DEFAULT (SYSUTCDATETIME()),
    UpdatedAt   DATETIME2(3)       NOT NULL CONSTRAINT DF_SslCertificates_UpdatedAt DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT UQ_SslCertificates_Fingerprint UNIQUE (Fingerprint)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_SslCertificates_ValidTo')
    CREATE INDEX IX_SslCertificates_ValidTo ON dbo.SslCertificates (ValidTo);
GO

/* ---------------------------------------------------------------------------
   3. DomainRules — 網域反向代理規則
   --------------------------------------------------------------------------- */
IF OBJECT_ID(N'dbo.DomainRules', N'U') IS NULL
CREATE TABLE dbo.DomainRules (
    Id                 INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_DomainRules PRIMARY KEY,
    DomainName         NVARCHAR(253)     NOT NULL,                       -- 來源網域，例如 portal.aeust.edu.tw
    TargetIp           NVARCHAR(255)     NOT NULL,                       -- 後端 IP（亦接受內網主機名稱）
    TargetPort         INT               NOT NULL CONSTRAINT DF_DomainRules_TargetPort DEFAULT (80),
    CertificateId      INT               NOT NULL,
    ForceHttps         BIT               NOT NULL CONSTRAINT DF_DomainRules_ForceHttps DEFAULT (1),
    EnableWebSocket    BIT               NOT NULL CONSTRAINT DF_DomainRules_WebSocket DEFAULT (0),
    ClientMaxBodySize  NVARCHAR(16)      NOT NULL CONSTRAINT DF_DomainRules_BodySize DEFAULT (N'50M'),
    IsActive           BIT               NOT NULL CONSTRAINT DF_DomainRules_IsActive DEFAULT (1),
    IsMaintenance      BIT               NOT NULL CONSTRAINT DF_DomainRules_IsMaint DEFAULT (0),
    CustomNginxSnippet NVARCHAR(MAX)     NULL,                           -- 自訂 Nginx 語法（插入 443 server 區塊）
    Remark             NVARCHAR(500)     NULL,
    CreatedAt          DATETIME2(3)      NOT NULL CONSTRAINT DF_DomainRules_CreatedAt DEFAULT (SYSUTCDATETIME()),
    UpdatedAt          DATETIME2(3)      NOT NULL CONSTRAINT DF_DomainRules_UpdatedAt DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT UQ_DomainRules_DomainName UNIQUE (DomainName),
    CONSTRAINT FK_DomainRules_Certificate FOREIGN KEY (CertificateId) REFERENCES dbo.SslCertificates (Id),
    CONSTRAINT CK_DomainRules_TargetPort  CHECK (TargetPort BETWEEN 1 AND 65535)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_DomainRules_CertificateId')
    CREATE INDEX IX_DomainRules_CertificateId ON dbo.DomainRules (CertificateId);
GO

/* ---------------------------------------------------------------------------
   4. DeployLogs — 部署紀錄
      Status: RUNNING / SUCCESS / FAILED(未變更或回滾失敗) / ROLLED_BACK(已自動回滾) / PARTIAL(部分節點 reload 失敗)
      NodeResults: 各節點同步狀態 (JSON 陣列)
   --------------------------------------------------------------------------- */
IF OBJECT_ID(N'dbo.DeployLogs', N'U') IS NULL
CREATE TABLE dbo.DeployLogs (
    Id          BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_DeployLogs PRIMARY KEY,
    TriggeredBy NVARCHAR(100)        NOT NULL CONSTRAINT DF_DeployLogs_By DEFAULT (N'admin'),
    TriggerIp   NVARCHAR(64)         NULL,
    StartedAt   DATETIME2(3)         NOT NULL CONSTRAINT DF_DeployLogs_Started DEFAULT (SYSUTCDATETIME()),
    FinishedAt  DATETIME2(3)         NULL,
    Status      NVARCHAR(16)         NOT NULL CONSTRAINT DF_DeployLogs_Status DEFAULT (N'RUNNING'),
    RuleCount   INT                  NULL,
    ErrorDetail NVARCHAR(MAX)        NULL,                               -- nginx -t 原始 stderr 等
    NodeResults NVARCHAR(MAX)        NULL,                               -- JSON
    LogText     NVARCHAR(MAX)        NULL,                               -- 完整執行過程
    CONSTRAINT CK_DeployLogs_Status CHECK (Status IN (N'RUNNING', N'SUCCESS', N'FAILED', N'ROLLED_BACK', N'PARTIAL')),
    CONSTRAINT CK_DeployLogs_NodeResults CHECK (NodeResults IS NULL OR ISJSON(NodeResults) = 1)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_DeployLogs_StartedAt')
    CREATE INDEX IX_DeployLogs_StartedAt ON dbo.DeployLogs (StartedAt DESC);
GO

/* ---------------------------------------------------------------------------
   5. AuditLogs — 系統操作紀錄
      Action: LOGIN / LOGIN_FAILED / CREATE / UPDATE / DELETE / RENEW / DEPLOY
      TargetType: AUTH / RULE / CERT / NODE / DEPLOY
      Detail: 變更內容 (JSON)，不含密碼、私鑰與憑證內容
   --------------------------------------------------------------------------- */
IF OBJECT_ID(N'dbo.AuditLogs', N'U') IS NULL
CREATE TABLE dbo.AuditLogs (
    Id          BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_AuditLogs PRIMARY KEY,
    CreatedAt   DATETIME2(3)         NOT NULL CONSTRAINT DF_AuditLogs_Created DEFAULT (SYSUTCDATETIME()),
    Username    NVARCHAR(100)        NOT NULL,
    ClientIp    NVARCHAR(64)         NULL,
    Action      NVARCHAR(20)         NOT NULL,
    TargetType  NVARCHAR(20)         NOT NULL,
    TargetId    NVARCHAR(50)         NULL,
    TargetName  NVARCHAR(300)        NULL,
    Success     BIT                  NOT NULL CONSTRAINT DF_AuditLogs_Success DEFAULT (1),
    Detail      NVARCHAR(MAX)        NULL,
    CONSTRAINT CK_AuditLogs_Detail CHECK (Detail IS NULL OR ISJSON(Detail) = 1)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_AuditLogs_CreatedAt')
    CREATE INDEX IX_AuditLogs_CreatedAt ON dbo.AuditLogs (CreatedAt DESC);
GO

/* ---------------------------------------------------------------------------
   6. AdminAccounts — 可登入帳號（介面「帳號管理」維護）
      可登入名單 = 此表 IsActive = 1 的帳號 ∪ .env ADMIN_ACCOUNTS；密碼一律由 SOAP 驗證，不存密碼
   --------------------------------------------------------------------------- */
IF OBJECT_ID(N'dbo.AdminAccounts', N'U') IS NULL
CREATE TABLE dbo.AdminAccounts (
    Id          INT IDENTITY(1,1)    NOT NULL CONSTRAINT PK_AdminAccounts PRIMARY KEY,
    Username    NVARCHAR(100)        NOT NULL CONSTRAINT UQ_AdminAccounts_Username UNIQUE,
    DisplayName NVARCHAR(100)        NULL,
    IsActive    BIT                  NOT NULL CONSTRAINT DF_AdminAccounts_Active DEFAULT (1),
    Remark      NVARCHAR(300)        NULL,
    CreatedBy   NVARCHAR(100)        NULL,
    LastLoginAt DATETIME2(3)         NULL,
    CreatedAt   DATETIME2(3)         NOT NULL CONSTRAINT DF_AdminAccounts_Created DEFAULT (SYSUTCDATETIME()),
    UpdatedAt   DATETIME2(3)         NOT NULL CONSTRAINT DF_AdminAccounts_Updated DEFAULT (SYSUTCDATETIME())
);
GO

/* ---------------------------------------------------------------------------
   初始資料：兩台 Ubuntu 24.04 節點範例（請依實際 IP 修改）
   憑證需透過系統「上傳憑證」功能匯入（需解析 PEM），故不在此預先建立。
   --------------------------------------------------------------------------- */
IF NOT EXISTS (SELECT 1 FROM dbo.ProxyNodes WHERE NodeName = N'nginx-node1')
    INSERT INTO dbo.ProxyNodes (NodeName, IpAddress, SshPort, SshUser, IsActive, HealthStatus)
    VALUES (N'nginx-node1', N'192.168.10.11', 22, N'deployer', 1, N'UNKNOWN');

IF NOT EXISTS (SELECT 1 FROM dbo.ProxyNodes WHERE NodeName = N'nginx-node2')
    INSERT INTO dbo.ProxyNodes (NodeName, IpAddress, SshPort, SshUser, IsActive, HealthStatus)
    VALUES (N'nginx-node2', N'192.168.10.12', 22, N'deployer', 1, N'UNKNOWN');
GO

SELECT Id, NodeName, IpAddress, SshPort, SshUser, IsActive, HealthStatus FROM dbo.ProxyNodes;
GO

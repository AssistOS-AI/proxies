export const config = {
  port: parseInt(process.env.PORT || '8043', 10),

  // Dashboard auth
  dashboardPassword: process.env.DASHBOARD_PASSWORD || '',

  // PostgreSQL (uses pg defaults: PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE)
  pgSchema: 'search_gateway',

  // Encryption
  encryptionKey: process.env.ENCRYPTION_KEY || '',

  // Rate limiting defaults
  defaultRpmLimit: 60,

  // Log retention
  retentionDays: 90,

  // Soul Gateway (for deep-research LLM calls)
  soulGatewayUrl: process.env.SOUL_GATEWAY_URL || 'http://10.0.2.2:8042/v1/chat/completions',
  soulGatewayApiKey: process.env.SOUL_GATEWAY_API_KEY || '',
};

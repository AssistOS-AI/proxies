const accountType = process.env.COPILOT_ACCOUNT_TYPE || 'individual';

function computeCopilotBaseUrl(type) {
  if (type === 'individual') {
    return 'https://api.githubcopilot.com';
  }
  return `https://api.${type}.githubcopilot.com`;
}

export const config = {
  port: parseInt(process.env.PORT || '4141', 10),
  accountType,
  verbose: process.env.COPILOT_VERBOSE === 'true',
  githubToken: process.env.COPILOT_GITHUB_TOKEN || '',
  dataDir: '/shared/copilot-gateway/data',
  tokenPath: '/shared/copilot-gateway/data/github_token',

  // Constants
  clientId: 'Iv1.b507a08c87ecfe98',
  copilotVersion: '0.26.7',
  apiVersion: '2025-04-01',
  vsCodeVersionFallback: '1.104.3',

  copilotBaseUrl: computeCopilotBaseUrl(accountType),
};

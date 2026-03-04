/**
 * ワークスペース別の設定を管理
 */

const WORKSPACES = {
  foresma: {
    name: 'foresma',
    getBotToken: () => process.env.SLACK_BOT_TOKEN_FORESMA || process.env.SLACK_BOT_TOKEN,
    getSigningSecret: () => process.env.SLACK_SIGNING_SECRET_FORESMA || process.env.SLACK_SIGNING_SECRET,
    getNotificationChannel: () => process.env.SLACK_NOTIFICATION_CHANNEL_FORESMA || process.env.SLACK_NOTIFICATION_CHANNEL,
  },
  winova: {
    name: 'winova',
    getBotToken: () => process.env.SLACK_BOT_TOKEN_WINOVA,
    getSigningSecret: () => process.env.SLACK_SIGNING_SECRET_WINOVA,
    getNotificationChannel: () => process.env.SLACK_NOTIFICATION_CHANNEL_WINOVA,
  }
};

/**
 * ワークスペース設定を取得
 * @param {string} workspaceId - 'foresma' または 'winova'
 * @returns {object} ワークスペース設定
 */
function getWorkspaceConfig(workspaceId) {
  const config = WORKSPACES[workspaceId];
  if (!config) {
    throw new Error(`Unknown workspace: ${workspaceId}`);
  }
  return config;
}

/**
 * ワークスペースのBot Tokenを取得
 */
function getBotToken(workspaceId) {
  return getWorkspaceConfig(workspaceId).getBotToken();
}

/**
 * ワークスペースの署名シークレットを取得
 */
function getSigningSecret(workspaceId) {
  return getWorkspaceConfig(workspaceId).getSigningSecret();
}

/**
 * ワークスペースの通知チャンネルを取得
 */
function getNotificationChannel(workspaceId) {
  return getWorkspaceConfig(workspaceId).getNotificationChannel();
}

module.exports = {
  getWorkspaceConfig,
  getBotToken,
  getSigningSecret,
  getNotificationChannel,
  WORKSPACES
};

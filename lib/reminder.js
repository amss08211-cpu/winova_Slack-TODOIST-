/**
 * リマインダー共通ロジック
 */

const { getOverdueOrTodayTasks, getTodoistUserEmail } = require('./todoist');
const { postMessage, findSlackUserByEmail } = require('./slack');
const { getBotToken, getNotificationChannel, WORKSPACES } = require('./workspaces');

/**
 * Todoist User ID から Slack User ID を取得（メールアドレスで自動マッチング）
 * @param {string} todoistUserId - Todoist のユーザーID
 * @param {string} botToken - Slack Bot Token
 * @returns {Promise<string|null>} Slack のユーザーID
 */
async function getSlackIdByTodoistId(todoistUserId, botToken) {
  if (!todoistUserId || !botToken) return null;

  // Todoist User ID → メールアドレス
  const email = await getTodoistUserEmail(todoistUserId);
  if (!email) {
    console.log(`[reminder] No email found for Todoist user ${todoistUserId}`);
    return null;
  }

  // メールアドレス → Slack User ID
  const slackId = await findSlackUserByEmail(email, botToken);
  if (!slackId) {
    console.log(`[reminder] No Slack user found for email ${email}`);
  }

  return slackId;
}

/**
 * 期日超過の日数を計算
 * @param {string} dueDate - YYYY-MM-DD 形式の期日
 * @returns {number} 超過日数（0以上）
 */
function getOverdueDays(dueDate) {
  if (!dueDate) return 0;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);

  const diffTime = today.getTime() - due.getTime();
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

  return Math.max(0, diffDays);
}

/**
 * 期日までの日数を計算
 * @param {string} dueDate - YYYY-MM-DD 形式の期日
 * @returns {number} 残り日数（1以上）
 */
function getDaysUntilDue(dueDate) {
  if (!dueDate) return 0;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);

  const diffTime = due.getTime() - today.getTime();
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

  return Math.max(0, diffDays);
}

/**
 * タスク1行分のテキストを生成
 * @param {Object} task - タスク
 * @param {string} projectName - プロジェクト名
 * @param {string} slackUserId - Slack User ID
 * @param {Object} options - オプション
 * @param {number} options.overdueDays - 超過日数
 * @param {number} options.daysUntilDue - 残り日数
 */
function buildTaskLine(task, projectName, slackUserId, options = {}) {
  const taskUrl = task.url || `https://app.todoist.com/app/task/${task.id}`;
  const mention = slackUserId ? `<@${slackUserId}> ` : '';

  return `・${mention}${projectName} - *${task.content}* <${taskUrl}|開く>`;
}

/**
 * まとめてリマインダーメッセージを生成
 */
function buildConsolidatedMessage(type, taskLines) {
  const count = taskLines.length;

  if (type === 'today') {
    return `⏰ *今日が期日のタスク（${count}件）*\n\n${taskLines.join('\n')}`;
  } else if (type === 'upcoming') {
    return `📅 *期日が近いタスク（${count}件）*\n\n${taskLines.join('\n')}`;
  } else {
    return `🚨 *期日を過ぎているタスク（${count}件）*\n\n${taskLines.join('\n')}`;
  }
}

/**
 * リマインダーを送信（両ワークスペースに通知）
 * @param {string} type - 'today' または 'overdue'
 * @returns {Promise<object>} 結果
 */
async function sendReminders(type) {
  const results = { sent: 0, skipped: 0, errors: [] };

  try {
    // 全プロジェクトからタスクを取得（フィルターなしで自前フィルタリング）
    const tasks = await getOverdueOrTodayTasks(type);

    console.log(`[reminder-${type}] Found ${tasks.length} tasks`);

    if (tasks.length === 0) {
      return results;
    }

    // foresmaワークスペースのみに通知（共通チャンネルのため）
    const targetWorkspaces = ['foresma'];
    for (const workspaceId of targetWorkspaces) {
      const botToken = getBotToken(workspaceId);
      const channel = getNotificationChannel(workspaceId);

      if (!botToken || !channel) {
        console.log(`[reminder-${type}] Skip ${workspaceId}: no token or channel`);
        continue;
      }

      try {
        // 全タスクの行を生成
        const taskLines = [];
        for (const task of tasks) {
          const projectName = task._projectName || '不明なプロジェクト';
          const slackUserId = await getSlackIdByTodoistId(task.responsible_uid, botToken);

          const options = {};
          if (type === 'overdue') {
            // due.date と deadline の両方をチェックし、より超過が大きい方を使用
            const dueDays = getOverdueDays(task.due?.date);
            const deadlineDays = getOverdueDays(task.deadline?.date);
            options.overdueDays = Math.max(dueDays, deadlineDays);
          } else if (type === 'upcoming') {
            // upcoming は deadline フィールドを使用
            options.daysUntilDue = getDaysUntilDue(task.deadline?.date);
          }

          const line = buildTaskLine(task, projectName, slackUserId, options);
          taskLines.push(line);
        }

        // まとめて1メッセージ送信
        const message = buildConsolidatedMessage(type, taskLines);
        await postMessage(channel, message, botToken);
        results.sent += tasks.length;

      } catch (err) {
        console.error(`[reminder-${type}] Error sending to ${workspaceId}:`, err.message);
        results.errors.push({ workspaceId, error: err.message });
      }
    }

  } catch (err) {
    console.error(`[reminder-${type}] Error:`, err.message);
    results.errors.push({ error: err.message });
  }

  return results;
}

module.exports = {
  getSlackIdByTodoistId,
  getOverdueDays,
  buildTaskLine,
  buildConsolidatedMessage,
  sendReminders
};

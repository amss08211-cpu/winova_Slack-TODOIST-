/**
 * 期日間近リマインダー Cron エンドポイント
 * 1〜3日後に期日のタスクを通知
 */

const { sendReminders } = require('../../lib/reminder');

module.exports = async (req, res) => {
  // Vercel Cron からの呼び出しを検証
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    if (process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  console.log(`[reminder-upcoming] Started at ${new Date().toISOString()}`);

  try {
    const results = await sendReminders('upcoming');

    console.log(`[reminder-upcoming] Completed: sent=${results.sent}, errors=${results.errors.length}`);

    return res.status(200).json({
      success: true,
      ...results
    });
  } catch (error) {
    console.error(`[reminder-upcoming] Error: ${error.message}`);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * 当日リマインダー Cron エンドポイント
 * スケジュール: 毎日 11:00 JST (UTC 02:00)
 */

const { sendReminders } = require('../../lib/reminder');

module.exports = async (req, res) => {
  // Vercel Cron からの呼び出しを検証
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    // CRON_SECRET が設定されていない場合はスキップ
    if (process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  console.log(`[reminder-today] Started at ${new Date().toISOString()}`);

  try {
    const results = await sendReminders('today');

    console.log(`[reminder-today] Completed: sent=${results.sent}, errors=${results.errors.length}`);

    return res.status(200).json({
      success: true,
      ...results
    });
  } catch (error) {
    console.error(`[reminder-today] Error: ${error.message}`);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

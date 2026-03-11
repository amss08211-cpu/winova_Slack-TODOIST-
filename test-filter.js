require('dotenv').config();
const { getOverdueOrTodayTasks } = require('./lib/todoist');

(async () => {
  console.log('=== リマインダー件数テスト ===\n');

  // 当日
  const todayTasks = await getOverdueOrTodayTasks('today');
  console.log('【today】当日期日:', todayTasks.length, '件');
  todayTasks.forEach(t => console.log('  -', t.content.substring(0, 35), `(${t._projectName})`));
  console.log('');

  // 期日超過
  const overdueTasks = await getOverdueOrTodayTasks('overdue');
  console.log('【overdue】期日超過:', overdueTasks.length, '件');
  overdueTasks.forEach(t => console.log('  -', t.content.substring(0, 35), `(${t._projectName})`));
  console.log('');

  // 1〜3日前
  const upcomingTasks = await getOverdueOrTodayTasks('upcoming');
  console.log('【upcoming】1〜3日前:', upcomingTasks.length, '件');
  upcomingTasks.forEach(t => console.log('  -', t.content.substring(0, 35), `(${t._projectName})`));
})();

require('dotenv').config();
const { getOverdueOrTodayTasks } = require('./lib/todoist');

(async () => {
  console.log('=== 期日超過タスク（due.date + deadline 両方）テスト ===\n');

  // 期日超過タスク取得
  const overdueTasks = await getOverdueOrTodayTasks('overdue');
  console.log('期日超過タスク数:', overdueTasks.length);
  console.log('');

  overdueTasks.forEach(t => {
    console.log('-', t.content.substring(0, 40));
    console.log('  due.date:', t.due?.date || 'なし');
    console.log('  deadline:', t.deadline?.date || 'なし');
    console.log('  PJ:', t._projectName);
    console.log('');
  });
})();

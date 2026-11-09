import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSchedule, withDefaultSchedule, validateDraft } from '../src/draft.js';
import { listProjectUsers, resolveProjectUser } from '../src/backlog.js';

test('默认日期按本地日历计算今天和严格晚于今天的周五，覆盖周末、月底与跨年', () => {
  for (const [startDate, dueDate] of [['2026-11-02', '2026-11-06'], ['2026-11-05', '2026-11-06'], ['2026-11-06', '2026-11-13'], ['2026-11-07', '2026-11-13'], ['2026-11-08', '2026-11-13'], ['2026-12-31', '2027-01-01'], ['2027-01-01', '2027-01-08']]) {
    assert.deepEqual(defaultSchedule(new Date(`${startDate}T23:50:00`)), { startDate, dueDate });
  }
  const saved = { startDate: '2026-10-01', dueDate: '2026-10-09', assignee: 'QA', notifiedUsers: ['Dev'] };
  assert.deepEqual(withDefaultSchedule(saved, new Date('2026-11-06T09:00:00')), saved);
  assert.deepEqual(withDefaultSchedule({}, new Date('2026-11-06T09:00:00')), { startDate: '2026-11-06', dueDate: '2026-11-13' });
});

test('项目成员查询仅返回ID与姓名，负责人和通知对象不允许猜测同名或不存在的人员', async () => {
  const config = { backlog: { origin: 'https://fixture.backlog.com', project: 'DEMO' } };
  const users = await listProjectUsers(config, { env: { BACKLOG_API_KEY: 'SECRET' }, fetchImpl: async (url, options) => {
    assert.equal(url.pathname, '/api/v2/projects/DEMO/users'); assert.equal(options.method, 'GET');
    return { ok: true, json: async () => [{ id: 18, name: 'QA', mailAddress: 'private@example.test' }] };
  } });
  assert.deepEqual(users, [{ id: 18, name: 'QA' }]); assert.equal(resolveProjectUser(users, 'QA').id, 18);
  assert.throws(() => resolveProjectUser([...users, { id: 20, name: 'QA' }], 'QA'), /不唯一/);
  assert.throws(() => resolveProjectUser(users, 'Other'), /不存在/);
  for (const notifiedUsers of ['QA', [3], [''], ['bad\nname']]) assert.throws(() => validateDraft({ version: 1, summary: '标题', description: '正文', attachments: [], unknowns: [], notifiedUsers }), /通知对象/);
});

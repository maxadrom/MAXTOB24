// Smoke scripts/audit-bindings.js (M21): read-only аудит привязок. Реальный pg (привязки,
// message_log, installation), фейковый MAX-клиент: getChat отдаёт группу, личку, канал и
// ошибку 404. runScript({ argv, deps }) — без process.exit. DB-gated.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runScript } from '../../scripts/audit-bindings.js';
import { BindingsRepository } from '../../src/modules/bindings/bindingsRepository.js';
import { MessageLogRepository } from '../../src/modules/messaging/messageLogRepository.js';
import { MaxApiError } from '../../src/modules/max/maxApiError.js';
import { closeTestPool, getTestPool, shouldSkipDb, truncateAll } from '../helpers/db.js';

function silentLogger() {
  const make = () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: () => make(),
  });
  return make();
}

const CONFIG = {
  env: 'test',
  db: {},
  log: { level: 'silent' },
  max: { botToken: 'test-bot-token', apiBaseUrl: 'https://platform-api2.max.ru' },
  b24: { portal: 'audit.bitrix24.test' },
  optional: {},
};

const CHATS = {
  '-1': { chat_id: -1, type: 'chat', title: 'Группа' },
  '5': { chat_id: 5, type: 'dialog', title: null },
  '-2': { chat_id: -2, type: 'channel', title: 'Канал' },
};

function fakeMaxClient({ hasToken = true } = {}) {
  return {
    hasToken: () => hasToken,
    getChat: vi.fn(async (id) => {
      if (CHATS[id]) return CHATS[id];
      throw new MaxApiError('not found', { httpStatus: 404, maxCode: 'chat.not.found' });
    }),
  };
}

describe.skipIf(shouldSkipDb())('audit-bindings smoke (M21)', () => {
  let pool;
  let stdout;
  let ids;

  beforeEach(async () => {
    pool = getTestPool();
    await truncateAll(pool);
    const { rows: [inst] } = await pool.query(
      `INSERT INTO installations (b24_portal) VALUES ('audit.bitrix24.test') RETURNING id`,
    );
    const bindings = new BindingsRepository(pool, null);
    const log = new MessageLogRepository(pool, null);
    ids = {};
    for (const chatId of ['-1', '5', '-2', '-3']) {
      // eslint-disable-next-line no-await-in-loop
      const { binding } = await bindings.upsertForMaxChat({ installationId: inst.id, maxChatId: chatId });
      ids[chatId] = binding.id;
    }
    await log.recordInbound({ bindingId: ids['-1'], maxMid: 'mid.1' });
    await log.recordInbound({ bindingId: ids['-1'], maxMid: 'mid.2' });
    await log.recordOutbound({ bindingId: ids['-1'], b24MsgId: '100' });
    await log.recordInbound({ bindingId: ids['5'], maxMid: 'mid.d' });
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  function deps(overrides = {}) {
    return { config: CONFIG, logger: silentLogger(), pool, maxClient: fakeMaxClient(), ...overrides };
  }

  it('1) вердикты по типу из MAX, счётчики журнала, кандидаты — личка и канал', async () => {
    const result = await runScript({ argv: ['node', 'audit-bindings'], deps: deps() });

    expect(result.ok).toBe(true);
    const byChat = Object.fromEntries(result.rows.map((r) => [r.maxChatId, r]));
    expect(byChat['-1']).toMatchObject({ type: 'chat', verdict: 'group', inbound: 2, outbound: 1, hasTitle: true });
    expect(byChat['5']).toMatchObject({ type: 'dialog', verdict: 'not-group', inbound: 1, outbound: 0 });
    expect(byChat['-2']).toMatchObject({ type: 'channel', verdict: 'not-group', inbound: 0, lastAt: null });
    expect(byChat['-3']).toMatchObject({ type: null, verdict: 'unknown', error: '404 chat.not.found' });
    expect(result.candidates).toEqual([ids['5'], ids['-2']]);

    const printed = stdout.mock.calls.map((c) => c[0]).join('');
    expect(printed).toContain(`DELETE FROM chat_bindings WHERE id IN (${ids['5']}, ${ids['-2']});`);
    expect(printed).toContain(`Тип не определён (проверить вручную): ${ids['-3']}`);
  });

  it('2) скрипт ничего не меняет в БД', async () => {
    const before = await pool.query('SELECT count(*)::int AS n FROM chat_bindings');

    await runScript({ argv: ['node', 'audit-bindings'], deps: deps() });

    const after = await pool.query('SELECT count(*)::int AS n FROM chat_bindings');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('3) --json → JSON с rows и candidates на stdout', async () => {
    await runScript({ argv: ['node', 'audit-bindings', '--json'], deps: deps() });

    const parsed = JSON.parse(stdout.mock.calls.map((c) => c[0]).join(''));
    expect(parsed.rows).toHaveLength(4);
    expect(parsed.candidates).toEqual([ids['5'], ids['-2']]);
  });

  it('4) без MAX_BOT_TOKEN → ошибка до запросов в MAX', async () => {
    const maxClient = fakeMaxClient({ hasToken: false });

    await expect(runScript({ argv: ['node', 'audit-bindings'], deps: deps({ maxClient }) }))
      .rejects.toThrow(/MAX_BOT_TOKEN/);
    expect(maxClient.getChat).not.toHaveBeenCalled();
  });
});

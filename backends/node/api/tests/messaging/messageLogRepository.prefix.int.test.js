// DB-тест M27: MessageLogRepository.hasInboundKeyPrefix — поиск входящей записи привязки по
// префиксу ключа (group-link:<chatId>:<hash>). Скипается без Postgres.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { BindingsRepository } from '../../src/modules/bindings/bindingsRepository.js';
import { MessageLogRepository } from '../../src/modules/messaging/messageLogRepository.js';
import { closeTestPool, getTestPool, shouldSkipDb, truncateAll } from '../helpers/db.js';

const CHAT = '-70000000000954';
const PREFIX = `group-link:${CHAT}:`;

describe.skipIf(shouldSkipDb())('MessageLogRepository.hasInboundKeyPrefix (M27)', () => {
  let pool;
  let repo;
  let bindingId;
  let otherBindingId;

  beforeEach(async () => {
    pool = getTestPool();
    await truncateAll(pool);
    repo = new MessageLogRepository(pool, null);
    const bindings = new BindingsRepository(pool, null);
    const { rows: [inst] } = await pool.query(
      `INSERT INTO installations (b24_portal) VALUES ('m27.bitrix24.test') RETURNING id`,
    );
    ({ binding: { id: bindingId } } = await bindings.upsertForMaxChat({ installationId: inst.id, maxChatId: CHAT }));
    ({ binding: { id: otherBindingId } } = await bindings.upsertForMaxChat({ installationId: inst.id, maxChatId: '-1' }));
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('находит group-link:<chatId>:<hash> своей привязки', async () => {
    expect(await repo.hasInboundKeyPrefix(bindingId, PREFIX)).toBe(false);

    await repo.recordInbound({ bindingId, maxMid: `${PREFIX}0123456789abcdef`, payloadMeta: { kind: 'group-link' } });

    expect(await repo.hasInboundKeyPrefix(bindingId, PREFIX)).toBe(true);
  });

  it('не находит запись чужой привязки, outbound с тем же max_mid и соседние ключи (group-intro:, mid)', async () => {
    await repo.recordInbound({ bindingId: otherBindingId, maxMid: `${PREFIX}0123456789abcdef` });
    // Outbound-строка с заполненным max_mid: recordOutbound пишет ключ в b24_msg_id, а max_mid
    // оставляет NULL — такая строка под префикс не попала бы и без фильтра по direction.
    await pool.query(
      `INSERT INTO message_log (binding_id, direction, max_mid) VALUES ($1, 'outbound', $2)`,
      [bindingId, `${PREFIX}0123456789abcdef`],
    );
    await repo.recordInbound({ bindingId, maxMid: `group-intro:${CHAT}` });
    await repo.recordInbound({ bindingId, maxMid: 'mid.ABC' });
    await repo.recordInbound({ bindingId, maxMid: `group-link:${CHAT}0:ffff` });

    expect(await repo.hasInboundKeyPrefix(bindingId, PREFIX)).toBe(false);
    expect(await repo.hasInboundKeyPrefix(otherBindingId, PREFIX)).toBe(true);
  });

  it('символы шаблонов LIKE в префиксе — литералы (starts_with)', async () => {
    await repo.recordInbound({ bindingId, maxMid: 'group-link:-70000000000954:abc' });

    expect(await repo.hasInboundKeyPrefix(bindingId, 'group-link:%')).toBe(false);
    expect(await repo.hasInboundKeyPrefix(bindingId, 'group_link:')).toBe(false);
  });

  it.each([[''], [null], [undefined]])('пустой префикс %j → TypeError', async (prefix) => {
    await expect(repo.hasInboundKeyPrefix(bindingId, prefix)).rejects.toThrow(TypeError);
  });
});

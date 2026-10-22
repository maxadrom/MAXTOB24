// DB-тест M26: deleteAllByInstallation — очистка данных моста при удалении приложения Б24
// с CLEAN=1. Привязки установки удаляются, participant_map и message_log уходят по FK
// ON DELETE CASCADE (0004, 0005); чужая установка не тронута. Скипается без Postgres.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { BindingsRepository } from '../../src/modules/bindings/bindingsRepository.js';
import { ParticipantMapRepository } from '../../src/modules/bindings/participantMapRepository.js';
import { MessageLogRepository } from '../../src/modules/messaging/messageLogRepository.js';
import { closeTestPool, getTestPool, shouldSkipDb, truncateAll } from '../helpers/db.js';

describe.skipIf(shouldSkipDb())('BindingsRepository.deleteAllByInstallation (M26)', () => {
  let pool;
  let repo;
  let ours;
  let foreign;

  // Привязка с одним участником и двумя записями журнала (входящая и исходящая).
  async function seedBinding(installationId, chatId) {
    const { binding } = await repo.upsertForMaxChat({ installationId, maxChatId: chatId });
    await new ParticipantMapRepository(pool, null)
      .upsert({ bindingId: binding.id, maxUserId: 1000001, maxDisplayName: 'Олег' });
    const log = new MessageLogRepository(pool, null);
    await log.recordInbound({ bindingId: binding.id, maxMid: `mid.${chatId}`, payloadMeta: { text: 'привет' } });
    await log.recordOutbound({ bindingId: binding.id, b24MsgId: `b24.${chatId}` });
  }

  async function seedInstallation(portal, chatIds) {
    const { rows: [inst] } = await pool.query(
      'INSERT INTO installations (b24_portal) VALUES ($1) RETURNING id',
      [portal],
    );
    for (const chatId of chatIds) {
      // eslint-disable-next-line no-await-in-loop
      await seedBinding(inst.id, chatId);
    }
    return inst.id;
  }

  // Счётчики по установке: привязки, участники и журнал (через привязки установки).
  async function counts(installationId) {
    const { rows: [row] } = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM chat_bindings WHERE installation_id = $1) AS bindings,
         (SELECT count(*)::int FROM participant_map p
            JOIN chat_bindings b ON b.id = p.binding_id WHERE b.installation_id = $1) AS participants,
         (SELECT count(*)::int FROM message_log l
            JOIN chat_bindings b ON b.id = l.binding_id WHERE b.installation_id = $1) AS log`,
      [installationId],
    );
    return row;
  }

  async function totals() {
    const { rows: [row] } = await pool.query(
      `SELECT (SELECT count(*)::int FROM chat_bindings) AS bindings,
              (SELECT count(*)::int FROM participant_map) AS participants,
              (SELECT count(*)::int FROM message_log) AS log,
              (SELECT count(*)::int FROM installations) AS installations`,
    );
    return row;
  }

  beforeEach(async () => {
    pool = getTestPool();
    await truncateAll(pool);
    repo = new BindingsRepository(pool, null);
    ours = await seedInstallation('m26-purge.bitrix24.test', ['-1', '-2']);
    foreign = await seedInstallation('m26-other.bitrix24.test', ['-3']);
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('удаляет привязки установки (2), участники и журнал — каскадом; чужая установка цела', async () => {
    expect(await counts(ours)).toEqual({ bindings: 2, participants: 2, log: 4 });

    await expect(repo.deleteAllByInstallation(ours)).resolves.toBe(2);

    expect(await counts(foreign)).toEqual({ bindings: 1, participants: 1, log: 2 });
    // Без JOIN: строки участников и журнала нашей установки не осиротели, а удалены.
    expect(await totals()).toEqual({ bindings: 1, participants: 1, log: 2, installations: 2 });
  });

  it('повтор → 0, ничего не меняется', async () => {
    await repo.deleteAllByInstallation(ours);

    await expect(repo.deleteAllByInstallation(ours)).resolves.toBe(0);
    expect(await totals()).toEqual({ bindings: 1, participants: 1, log: 2, installations: 2 });
  });

  it('установка без привязок → 0', async () => {
    const { rows: [inst] } = await pool.query(
      `INSERT INTO installations (b24_portal) VALUES ('m26-empty.bitrix24.test') RETURNING id`,
    );
    await expect(repo.deleteAllByInstallation(inst.id)).resolves.toBe(0);
  });
});

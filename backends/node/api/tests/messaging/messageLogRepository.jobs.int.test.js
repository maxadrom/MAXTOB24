// DB-тест M29: строки заданий очереди исходящих в message_log (ключ job:<ключ операции>,
// status 'in_progress') — claim/release/find на настоящем Postgres. Скипается без Postgres.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { BindingsRepository } from '../../src/modules/bindings/bindingsRepository.js';
import { MessageLogRepository } from '../../src/modules/messaging/messageLogRepository.js';
import { closeTestPool, getTestPool, shouldSkipDb, truncateAll } from '../helpers/db.js';

const META = Object.freeze({
  kind: 'job',
  op: 'add',
  opKey: '42',
  connectorChatId: 'max:-1001',
  b24ChatId: '777',
  b24MsgId: '42',
  textPrefix: 'Договор',
  hasText: true,
  filesCount: 1,
  fileNames: ['Договор.pdf'],
});

describe.skipIf(shouldSkipDb())('MessageLogRepository — задания очереди исходящих (M29)', () => {
  let pool;
  let repo;
  let bindingId;
  let otherBindingId;

  // Отодвинуть created_at строки в прошлое: отметка старта в тестах — «минуту назад» с
  // запасом, расхождение часов Node и Postgres на результат не влияет.
  async function age(id, interval = '2 minutes') {
    await pool.query(`UPDATE message_log SET created_at = now() - $2::interval WHERE id = $1`, [id, interval]);
  }

  beforeEach(async () => {
    pool = getTestPool();
    await truncateAll(pool);
    repo = new MessageLogRepository(pool, null);
    const bindings = new BindingsRepository(pool, null);
    const { rows: [inst] } = await pool.query(
      `INSERT INTO installations (b24_portal) VALUES ('m29.bitrix24.test') RETURNING id`,
    );
    ({ binding: { id: bindingId } } = await bindings.upsertForMaxChat({ installationId: inst.id, maxChatId: '-1001' }));
    ({ binding: { id: otherBindingId } } = await bindings.upsertForMaxChat({ installationId: inst.id, maxChatId: '-1002' }));
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('claim → строка outbound in_progress с payload_meta; повторный claim → null', async () => {
    const job = await repo.claimOutboundJob({ bindingId, jobKey: 'job:42', payloadMeta: META });

    expect(job).not.toBeNull();
    expect(job.status).toBe('in_progress');
    expect(job.direction).toBe('outbound');
    expect(job.b24MsgId).toBe('job:42');
    expect(job.payloadMeta).toEqual(META);

    expect(await repo.claimOutboundJob({ bindingId, jobKey: 'job:42', payloadMeta: META })).toBeNull();
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM message_log WHERE b24_msg_id = 'job:42'`);
    expect(rows[0].n).toBe(1);
  });

  it('параллельный claim того же ключа: ровно один выигрывает', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => repo.claimOutboundJob({ bindingId, jobKey: 'job:edit:42:abc', payloadMeta: META })),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(4);
  });

  it('тот же ключ у другой привязки — своё задание', async () => {
    expect(await repo.claimOutboundJob({ bindingId, jobKey: 'job:42' })).not.toBeNull();
    expect(await repo.claimOutboundJob({ bindingId: otherBindingId, jobKey: 'job:42' })).not.toBeNull();
  });

  it('release → строка удалена, повторный release → 0; после release ключ снова свободен', async () => {
    const job = await repo.claimOutboundJob({ bindingId, jobKey: 'job:42', payloadMeta: META });

    expect(await repo.releaseOutboundJob(job.id)).toBe(1);
    expect(await repo.findOutbound(bindingId, 'job:42')).toBeNull();
    expect(await repo.releaseOutboundJob(job.id)).toBe(0);

    expect(await repo.claimOutboundJob({ bindingId, jobKey: 'job:42', payloadMeta: META })).not.toBeNull();
  });

  it('release обычной записи (received) → 0, запись на месте', async () => {
    const entry = await repo.recordOutbound({ bindingId, b24MsgId: '42', payloadMeta: { maxMid: 'mid.1' } });

    expect(await repo.releaseOutboundJob(entry.id)).toBe(0);
    expect(await repo.findOutbound(bindingId, '42')).not.toBeNull();
  });

  it('строка job:42 не мешает recordOutbound(42) и findOutbound(42)', async () => {
    await repo.claimOutboundJob({ bindingId, jobKey: 'job:42', payloadMeta: META });

    expect(await repo.findOutbound(bindingId, '42')).toBeNull();
    const recorded = await repo.recordOutbound({ bindingId, b24MsgId: '42', payloadMeta: { maxMid: 'mid.1' } });
    expect(recorded).not.toBeNull();
    expect(recorded.status).toBe('received');
    expect((await repo.findOutbound(bindingId, '42')).id).toBe(recorded.id);
    // И наоборот: запись операции не занимает ключ задания.
    expect(await repo.claimOutboundJob({ bindingId, jobKey: 'job:delete:42' })).not.toBeNull();
  });

  it('findOutboundJobs: только in_progress, только created_at < createdBefore, по id', async () => {
    const oldA = await repo.claimOutboundJob({ bindingId, jobKey: 'job:1', payloadMeta: { ...META, opKey: '1' } });
    const oldB = await repo.claimOutboundJob({ bindingId: otherBindingId, jobKey: 'job:delete:2', payloadMeta: { op: 'delete' } });
    await age(oldA.id);
    await age(oldB.id);
    // Свой новый claim (после отметки старта) — не попадает.
    await repo.claimOutboundJob({ bindingId, jobKey: 'job:3' });
    // Обычные записи журнала (outbound received, inbound) — тоже, даже старые.
    const done = await repo.recordOutbound({ bindingId, b24MsgId: '4' });
    const inbound = await repo.recordInbound({ bindingId, maxMid: 'mid.5' });
    await age(done.id);
    await age(inbound.id);

    const createdBefore = new Date(Date.now() - 60_000);
    const jobs = await repo.findOutboundJobs({ createdBefore });

    expect(jobs.map((j) => j.id)).toEqual([oldA.id, oldB.id]);
    expect(jobs.every((j) => j.status === 'in_progress')).toBe(true);
    expect(jobs[0].payloadMeta.fileNames).toEqual(['Договор.pdf']);
    expect(jobs[0].createdAt).toBeInstanceOf(Date);

    expect(await repo.findOutboundJobs({ createdBefore, limit: 1 })).toHaveLength(1);
  });

  it('findOutboundJobs без createdBefore → TypeError', async () => {
    await expect(repo.findOutboundJobs({})).rejects.toThrow(TypeError);
    await expect(repo.findOutboundJobs()).rejects.toThrow(TypeError);
  });

  it('строки заданий уходят каскадом с привязкой', async () => {
    const job = await repo.claimOutboundJob({ bindingId, jobKey: 'job:42' });
    await pool.query('DELETE FROM chat_bindings WHERE id = $1', [bindingId]);

    expect(await repo.releaseOutboundJob(job.id)).toBe(0);
  });
});

// Unit-тесты M21: MessageLogRepository не пишет запись без ключа дедупа — NULL обошёл бы
// частичный уникальный индекс, и ретраи молча дублировали бы сообщение. M29: строки
// заданий очереди исходящих (claim/release/find). Фейковый pool.

import { describe, expect, it, vi } from 'vitest';

import { MessageLogRepository } from '../../src/modules/messaging/messageLogRepository.js';
import { MessageLogEntry } from '../../src/modules/messaging/models/MessageLogEntry.js';

function fakePool() {
  return { query: vi.fn(async () => ({ rows: [{ id: 1, binding_id: 10, direction: 'inbound' }] })) };
}

describe('MessageLogRepository — ключ дедупа обязателен (M21)', () => {
  it.each([null, undefined, ''])('recordInbound(maxMid=%j) → TypeError, запроса нет', async (maxMid) => {
    const pool = fakePool();
    const repo = new MessageLogRepository(pool, null);

    await expect(repo.recordInbound({ bindingId: 10, maxMid })).rejects.toThrow(/recordInbound: dedup key required/);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it.each([null, undefined, ''])('recordOutbound(b24MsgId=%j) → TypeError, запроса нет', async (b24MsgId) => {
    const pool = fakePool();
    const repo = new MessageLogRepository(pool, null);

    await expect(repo.recordOutbound({ bindingId: 10, b24MsgId })).rejects.toThrow(/recordOutbound: dedup key required/);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('непустой ключ → INSERT с ключом', async () => {
    const pool = fakePool();
    const repo = new MessageLogRepository(pool, null);

    await repo.recordInbound({ bindingId: 10, maxMid: 'nomid:-1:5:1700000000000' });

    expect(pool.query).toHaveBeenCalledOnce();
    expect(pool.query.mock.calls[0][1]).toEqual([10, 'nomid:-1:5:1700000000000', null]);
  });
});

describe('MessageLogRepository — строки заданий очереди исходящих (M29)', () => {
  it.each([null, undefined, ''])('claimOutboundJob(jobKey=%j) → TypeError, запроса нет', async (jobKey) => {
    const pool = fakePool();
    const repo = new MessageLogRepository(pool, null);

    await expect(repo.claimOutboundJob({ bindingId: 10, jobKey })).rejects.toThrow(/claimOutboundJob: dedup key required/);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('claimOutboundJob → INSERT outbound со статусом in_progress и ON CONFLICT DO NOTHING', async () => {
    const pool = { query: vi.fn(async () => ({ rows: [{ id: 5, binding_id: 10, direction: 'outbound', b24_msg_id: 'job:42', status: 'in_progress' }] })) };
    const repo = new MessageLogRepository(pool, null);

    const entry = await repo.claimOutboundJob({ bindingId: 10, jobKey: 'job:42', payloadMeta: { kind: 'job', op: 'add' } });

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("'in_progress'");
    expect(sql).toContain("'outbound'");
    expect(sql).toMatch(/ON CONFLICT[\s\S]*DO NOTHING/);
    expect(params).toEqual([10, 'job:42', JSON.stringify({ kind: 'job', op: 'add' })]);
    expect(entry.status).toBe('in_progress');
    expect(entry.b24MsgId).toBe('job:42');
  });

  it('claimOutboundJob: конфликт (пустой RETURNING) → null', async () => {
    const pool = { query: vi.fn(async () => ({ rows: [] })) };
    const repo = new MessageLogRepository(pool, null);

    expect(await repo.claimOutboundJob({ bindingId: 10, jobKey: 'job:42' })).toBeNull();
  });

  it.each([null, undefined, ''])('releaseOutboundJob(%j) → TypeError, запроса нет', async (id) => {
    const pool = fakePool();
    const repo = new MessageLogRepository(pool, null);

    await expect(repo.releaseOutboundJob(id)).rejects.toThrow(TypeError);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('releaseOutboundJob удаляет только in_progress и отдаёт rowCount', async () => {
    const pool = { query: vi.fn(async () => ({ rowCount: 1 })) };
    const repo = new MessageLogRepository(pool, null);

    expect(await repo.releaseOutboundJob(5)).toBe(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM message_log WHERE id = \$1 AND status = 'in_progress'/);
    expect(params).toEqual([5]);
  });

  it.each([
    [{}],
    [{ createdBefore: null }],
    [{ createdBefore: '2026-10-08T10:00:00Z' }],
    [{ createdBefore: new Date('nope') }],
    [{ createdBefore: new Date(), limit: 0 }],
  ])('findOutboundJobs(%j) → TypeError, запроса нет', async (args) => {
    const pool = fakePool();
    const repo = new MessageLogRepository(pool, null);

    await expect(repo.findOutboundJobs(args)).rejects.toThrow(TypeError);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('findOutboundJobs → SELECT in_progress раньше отметки, по id, с лимитом', async () => {
    const pool = { query: vi.fn(async () => ({ rows: [{ id: 5, binding_id: 10, direction: 'outbound', b24_msg_id: 'job:42', status: 'in_progress' }] })) };
    const repo = new MessageLogRepository(pool, null);
    const createdBefore = new Date('2026-10-08T10:00:00Z');

    const jobs = await repo.findOutboundJobs({ createdBefore });

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("status = 'in_progress'");
    expect(sql).toContain('created_at < $1');
    expect(sql).toContain('ORDER BY id');
    expect(params).toEqual([createdBefore, 500]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('in_progress');
  });

  it("MessageLogEntry.fromRow со status 'in_progress' не бросает, неизвестный статус — бросает", () => {
    expect(MessageLogEntry.fromRow({ id: 1, binding_id: 10, direction: 'outbound', status: 'in_progress' }).status)
      .toBe('in_progress');
    expect(() => MessageLogEntry.fromRow({ id: 1, binding_id: 10, direction: 'outbound', status: 'queued' }))
      .toThrow(/status must be one of/);
  });
});

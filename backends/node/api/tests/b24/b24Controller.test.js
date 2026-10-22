// Unit-тесты B24Controller.handleWebhook — ветка верификации application_token (M9).
// Покрывают приоритет источников ожидаемого токена: db > env > none.
//   (a)  токен в БД задан        → используется БД (env игнорируется)
//   (a2) токен в БД задан        → совпадение с env-значением (но не с БД) → 401
//   (b)  БД NULL + env задан      → используется env, совпадение → 200
//   (b2) installation отсутствует (getCurrent бросает) + env задан → env, не 503
//   (c)  оба пусты                → 503 B24_WEBHOOK_DISABLED
//   (d)  токен задан, событие не совпадает → 401 B24_AUTH_INVALID
//   (e)  тело без event           → ValidationError через next
//
// Контроллер конструируется напрямую (без supertest): fakeService + fakeInstallations
// + лёгкие fakeReq/fakeRes. Тест чисто unit (моки) → не зависит от Postgres.

import { describe, expect, it, vi } from 'vitest';

import { B24Controller } from '../../src/modules/b24/b24Controller.js';
import { Installation } from '../../src/modules/installations/models/Installation.js';
import { NotFoundError, ValidationError } from '../../src/shared/http/domainErrors.js';

function fakeRes() {
  const res = {
    statusCode: 200,
    body: null,
    headersSent: false,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      res.headersSent = true;
      return res;
    },
  };
  return res;
}

function fakeReq(body) {
  return {
    id: 'req-b24-1',
    body,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      child: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
    },
  };
}

// Каждое тело — валидное событие OnImConnectorMessageAdd: контроллер сперва зовёт
// OpenLineEvent.fromWebhookBody и только потом проверяет токен. Тело без `event`
// упало бы в ValidationError ДО проверки токена.
function eventBody(applicationToken) {
  return {
    event: 'ONIMCONNECTORMESSAGEADD',
    auth: { application_token: applicationToken },
    data: { LINE: 42, MESSAGES: [] },
  };
}

function makeInstallations(getCurrentImpl) {
  return { getCurrent: vi.fn(getCurrentImpl) };
}

function makeService() {
  return { handleOpenLineMessageAdd: vi.fn().mockResolvedValue({ routed: true }) };
}

// tokenSource из debug-лога 'b24 webhook expected token resolved'.
function tokenSourceFromLog(req) {
  const call = req.log.debug.mock.calls.find((c) => c[1] === 'b24 webhook expected token resolved');
  return call ? call[0].tokenSource : undefined;
}

describe('B24Controller.handleWebhook — верификация application_token (M9)', () => {
  it('(a) токен в БД задан → используется БД, env игнорируется; совпадение → 200, service вызван', async () => {
    const service = makeService();
    const installations = makeInstallations(async () => ({ b24ApplicationToken: 'db-token' }));
    const controller = new B24Controller({
      service,
      installationsService: installations,
      applicationToken: 'env-token',
    });
    const req = fakeReq(eventBody('db-token'));
    const res = fakeRes();
    const next = vi.fn();

    await controller.handleWebhook(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, result: { routed: true } });
    expect(service.handleOpenLineMessageAdd).toHaveBeenCalledOnce();
    expect(tokenSourceFromLog(req)).toBe('db');
  });

  it('(a2) токен в БД задан → событие совпадает с env (но не с БД) → 401 (БД имеет приоритет)', async () => {
    const service = makeService();
    const installations = makeInstallations(async () => ({ b24ApplicationToken: 'db-token' }));
    const controller = new B24Controller({
      service,
      installationsService: installations,
      applicationToken: 'env-token',
    });
    const req = fakeReq(eventBody('env-token'));
    const res = fakeRes();
    const next = vi.fn();

    await controller.handleWebhook(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('B24_AUTH_INVALID');
    expect(service.handleOpenLineMessageAdd).not.toHaveBeenCalled();
    expect(tokenSourceFromLog(req)).toBe('db');
  });

  it('(b) БД NULL + env задан → используется env; совпадение → 200, service вызван', async () => {
    const service = makeService();
    const installations = makeInstallations(async () => ({ b24ApplicationToken: null }));
    const controller = new B24Controller({
      service,
      installationsService: installations,
      applicationToken: 'env-token',
    });
    const req = fakeReq(eventBody('env-token'));
    const res = fakeRes();
    const next = vi.fn();

    await controller.handleWebhook(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, result: { routed: true } });
    expect(service.handleOpenLineMessageAdd).toHaveBeenCalledOnce();
    expect(tokenSourceFromLog(req)).toBe('env');
  });

  it('(b2) installation отсутствует (getCurrent бросает NotFoundError) + env задан → env, НЕ 503', async () => {
    const service = makeService();
    const installations = makeInstallations(async () => {
      throw new NotFoundError('installation not found');
    });
    const controller = new B24Controller({
      service,
      installationsService: installations,
      applicationToken: 'env-token',
    });
    const req = fakeReq(eventBody('env-token'));
    const res = fakeRes();
    const next = vi.fn();

    await controller.handleWebhook(req, res, next);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, result: { routed: true } });
    expect(service.handleOpenLineMessageAdd).toHaveBeenCalledOnce();
    expect(tokenSourceFromLog(req)).toBe('env');
  });

  it('(c) оба источника пусты (БД NULL + env null) → 503 B24_WEBHOOK_DISABLED, service не вызван', async () => {
    const service = makeService();
    const installations = makeInstallations(async () => ({ b24ApplicationToken: null }));
    const controller = new B24Controller({
      service,
      installationsService: installations,
      applicationToken: null,
    });
    const req = fakeReq(eventBody('whatever'));
    const res = fakeRes();
    const next = vi.fn();

    await controller.handleWebhook(req, res, next);

    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('B24_WEBHOOK_DISABLED');
    expect(service.handleOpenLineMessageAdd).not.toHaveBeenCalled();
    expect(req.log.warn).toHaveBeenCalled();
    expect(tokenSourceFromLog(req)).toBe('none');
  });

  it('(d0) токен другой ДЛИНЫ не совпадает → 401 (timingSafeEqual не падает на разной длине)', async () => {
    const service = makeService();
    const installations = makeInstallations(async () => ({ b24ApplicationToken: 'db-token-1234' }));
    const controller = new B24Controller({
      service,
      installationsService: installations,
      applicationToken: null,
    });
    const req = fakeReq(eventBody('short')); // другая длина
    const res = fakeRes();
    const next = vi.fn();

    await controller.handleWebhook(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('B24_AUTH_INVALID');
    expect(service.handleOpenLineMessageAdd).not.toHaveBeenCalled();
  });

  it('(d) ожидаемый токен задан, но application_token события не совпадает → 401 B24_AUTH_INVALID', async () => {
    const service = makeService();
    const installations = makeInstallations(async () => ({ b24ApplicationToken: 'db-token' }));
    const controller = new B24Controller({
      service,
      installationsService: installations,
      applicationToken: null,
    });
    const req = fakeReq(eventBody('wrong-token'));
    const res = fakeRes();
    const next = vi.fn();

    await controller.handleWebhook(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('B24_AUTH_INVALID');
    expect(service.handleOpenLineMessageAdd).not.toHaveBeenCalled();
    expect(req.log.warn).toHaveBeenCalled();
  });

  it('(e) тело без event → ValidationError через next, ответ не отправлен', async () => {
    const service = makeService();
    const installations = makeInstallations(async () => ({ b24ApplicationToken: 'db-token' }));
    const controller = new B24Controller({
      service,
      installationsService: installations,
      applicationToken: null,
    });
    const req = fakeReq({});
    const res = fakeRes();
    const next = vi.fn();

    await controller.handleWebhook(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next.mock.calls[0][0]).toBeInstanceOf(ValidationError);
    expect(res.headersSent).toBe(false);
    expect(service.handleOpenLineMessageAdd).not.toHaveBeenCalled();
  });
});

// M19: после application_token — сверка auth.member_id с сохранённым b24_member_id.
describe('B24Controller.handleWebhook — сверка member_id (M19)', () => {
  const STORED_MEMBER = 'memberid000000000000000000000001';

  function bodyWithMember(memberId) {
    const body = eventBody('db-token');
    if (memberId !== undefined) body.auth.member_id = memberId;
    return body;
  }

  async function run({ installation, memberId, envToken = null }) {
    const service = makeService();
    const installations = makeInstallations(async () => {
      if (!installation) throw new NotFoundError('no installation');
      return installation;
    });
    const controller = new B24Controller({
      service,
      installationsService: installations,
      applicationToken: envToken,
    });
    const req = fakeReq(bodyWithMember(memberId));
    const res = fakeRes();
    const next = vi.fn();
    await controller.handleWebhook(req, res, next);
    return { service, req, res, next };
  }

  it('совпал с сохранённым → 200, service вызван', async () => {
    const { res, service } = await run({
      installation: { b24ApplicationToken: 'db-token', b24MemberId: STORED_MEMBER },
      memberId: STORED_MEMBER,
    });
    expect(res.statusCode).toBe(200);
    expect(service.handleOpenLineMessageAdd).toHaveBeenCalledOnce();
  });

  it('другой member_id → 401 B24_MEMBER_MISMATCH, service не вызван', async () => {
    const { res, service, req } = await run({
      installation: { b24ApplicationToken: 'db-token', b24MemberId: STORED_MEMBER },
      memberId: 'othermember00000',
    });
    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('B24_MEMBER_MISMATCH');
    expect(service.handleOpenLineMessageAdd).not.toHaveBeenCalled();
    expect(req.log.warn).toHaveBeenCalledWith(expect.anything(), 'b24 webhook rejected: member_id mismatch');
  });

  it('member_id-массив (дубли ключа) при сохранённом → считается отсутствующим: warn и пропуск', async () => {
    const { res, req } = await run({
      installation: { b24ApplicationToken: 'db-token', b24MemberId: STORED_MEMBER },
      memberId: [STORED_MEMBER, 'x'],
    });
    expect(res.statusCode).toBe(200);
    expect(req.log.warn).toHaveBeenCalledWith(
      expect.anything(),
      'b24 webhook: auth.member_id absent — check skipped',
    );
  });

  it('в событии нет member_id → warn и пропуск (мост не роняем)', async () => {
    const { res, service, req } = await run({
      installation: { b24ApplicationToken: 'db-token', b24MemberId: STORED_MEMBER },
      memberId: undefined,
    });
    expect(res.statusCode).toBe(200);
    expect(service.handleOpenLineMessageAdd).toHaveBeenCalledOnce();
    expect(req.log.warn).toHaveBeenCalledWith(
      expect.anything(),
      'b24 webhook: auth.member_id absent — check skipped',
    );
  });

  it('в БД member_id ещё NULL → сверка пропускается', async () => {
    const { res } = await run({
      installation: { b24ApplicationToken: 'db-token', b24MemberId: null },
      memberId: 'othermember00000',
    });
    expect(res.statusCode).toBe(200);
  });

  it('env-fallback без строки installations → сверка пропускается', async () => {
    const { res } = await run({ installation: null, memberId: 'othermember00000', envToken: 'db-token' });
    expect(res.statusCode).toBe(200);
  });
});

describe('B24Controller.handleWebhook — закрытие диалога (M25)', () => {
  function finishBody(token) {
    return {
      event: 'ONIMCONNECTORDIALOGFINISH',
      auth: { application_token: token },
      data: { CONNECTOR: 'max_b24', LINE: '42', DATA: [] },
    };
  }

  function build() {
    const service = {
      handleOpenLineMessageAdd: vi.fn(),
      handleOpenLineDialogFinish: vi.fn().mockResolvedValue({ ok: true, results: [] }),
    };
    const controller = new B24Controller({
      service,
      installationsService: makeInstallations(async () => ({ b24ApplicationToken: 'db-token' })),
    });
    return { service, controller };
  }

  it('ONIMCONNECTORDIALOGFINISH → handleOpenLineDialogFinish, не routeOutbound', async () => {
    const { service, controller } = build();
    const res = fakeRes();
    const next = vi.fn();

    await controller.handleWebhook(fakeReq(finishBody('db-token')), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, result: { ok: true, results: [] } });
    expect(service.handleOpenLineDialogFinish).toHaveBeenCalledOnce();
    expect(service.handleOpenLineDialogFinish.mock.calls[0][0].isDialogFinish()).toBe(true);
    expect(service.handleOpenLineMessageAdd).not.toHaveBeenCalled();
  });

  it('чужой application_token → 401, сервис не вызван', async () => {
    const { service, controller } = build();
    const res = fakeRes();

    await controller.handleWebhook(fakeReq(finishBody('wrong')), res, vi.fn());

    expect(res.statusCode).toBe(401);
    expect(service.handleOpenLineDialogFinish).not.toHaveBeenCalled();
  });
});

// M26: ONAPPUNINSTALL — тот же auth-конверт (application_token, затем member_id), своя
// ветка в сервисе. После удаления строка помечена uninstalled_at: гейт отвечает 503 на
// любое событие ещё до проверки токена, env-fallback не действует.
describe('B24Controller.handleWebhook — удаление приложения (M26)', () => {
  const MEMBER = 'memberid000000000000000000000001';

  function uninstallBody(token, memberId = MEMBER) {
    return {
      event: 'ONAPPUNINSTALL',
      auth: { application_token: token, member_id: memberId, domain: 'example.bitrix24.ru' },
      data: { LANGUAGE_ID: 'ru', CLEAN: '1' },
    };
  }

  function installed() {
    return new Installation({
      id: 1,
      b24Portal: 'example.bitrix24.ru',
      b24AccessToken: 'access',
      b24ApplicationToken: 'db-token',
      b24MemberId: MEMBER,
    });
  }

  // Как после markUninstalled: токены NULL, member_id и портал на месте.
  function uninstalled() {
    return new Installation({
      id: 1,
      b24Portal: 'example.bitrix24.ru',
      b24MemberId: MEMBER,
      uninstalledAt: new Date('2026-10-08T10:00:00Z'),
    });
  }

  function build(installation, { envToken = null } = {}) {
    const service = {
      handleAppUninstall: vi.fn().mockResolvedValue({ ok: true, clean: true, installationId: 1, purged: { bindings: 2 } }),
      handleOpenLineMessageAdd: vi.fn().mockResolvedValue({ routed: true }),
      handleOpenLineDialogFinish: vi.fn(),
    };
    const controller = new B24Controller({
      service,
      installationsService: makeInstallations(async () => installation),
      applicationToken: envToken,
    });
    return { service, controller };
  }

  async function run(controller, body) {
    const req = fakeReq(body);
    const res = fakeRes();
    const next = vi.fn();
    await controller.handleWebhook(req, res, next);
    return { req, res, next };
  }

  it('верный токен и member_id → handleAppUninstall (событие, scoped-логгер), 200 с итогом', async () => {
    const { service, controller } = build(installed());

    const { res, next } = await run(controller, uninstallBody('db-token'));

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, result: { ok: true, clean: true, installationId: 1, purged: { bindings: 2 } } });
    expect(service.handleAppUninstall).toHaveBeenCalledOnce();
    const [event, opts] = service.handleAppUninstall.mock.calls[0];
    expect(event.isAppUninstall()).toBe(true);
    expect(event.cleanRequested).toBe(true);
    expect(opts).toHaveProperty('logger');
    expect(service.handleOpenLineMessageAdd).not.toHaveBeenCalled();
  });

  it('чужой application_token (другое приложение портала подписало событие на наш URL) → 401, сервис не вызван', async () => {
    const { service, controller } = build(installed());

    const { res } = await run(controller, uninstallBody('foreign-app-token'));

    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('B24_AUTH_INVALID');
    expect(service.handleAppUninstall).not.toHaveBeenCalled();
  });

  it('чужой member_id → 401 B24_MEMBER_MISMATCH, сервис не вызван', async () => {
    const { service, controller } = build(installed());

    const { res } = await run(controller, uninstallBody('db-token', 'othermember00000'));

    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('B24_MEMBER_MISMATCH');
    expect(service.handleAppUninstall).not.toHaveBeenCalled();
  });

  it('после удаления: событие с совпавшим env-fallback → 503 B24_APP_UNINSTALLED, сервис не вызван', async () => {
    const { service, controller } = build(uninstalled(), { envToken: 'env-token' });

    const { req, res } = await run(controller, eventBody('env-token'));

    expect(res.statusCode).toBe(503);
    expect(res.body.error).toEqual({
      code: 'B24_APP_UNINSTALLED',
      message: 'app uninstalled — reinstall required',
      requestId: 'req-b24-1',
    });
    expect(service.handleOpenLineMessageAdd).not.toHaveBeenCalled();
    expect(req.log.warn).toHaveBeenCalledWith(
      { event: 'ONIMCONNECTORMESSAGEADD' },
      'b24 webhook rejected: app uninstalled — reinstall the Bitrix24 app',
    );
  });

  it('после удаления: ONIMCONNECTORMESSAGEADD со старым токеном → 503, handleOpenLineMessageAdd не вызван', async () => {
    const { service, controller } = build(uninstalled());

    const { res } = await run(controller, eventBody('db-token'));

    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('B24_APP_UNINSTALLED');
    expect(service.handleOpenLineMessageAdd).not.toHaveBeenCalled();
  });

  it('после удаления: повторный ONAPPUNINSTALL → 503, сервис не вызван (ничего не меняется)', async () => {
    const { service, controller } = build(uninstalled());

    const { res } = await run(controller, uninstallBody('db-token'));

    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('B24_APP_UNINSTALLED');
    expect(service.handleAppUninstall).not.toHaveBeenCalled();
  });

  it('после удаления: гейт стоит до проверки токена — событие без токена тоже 503, не 401', async () => {
    const { controller } = build(uninstalled());

    const { res } = await run(controller, { event: 'ONIMCONNECTORMESSAGEADD', data: {} });

    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('B24_APP_UNINSTALLED');
  });

  it('ошибка handleAppUninstall → next(err), ответ не отправлен', async () => {
    const { service, controller } = build(installed());
    const boom = new Error('deadlock detected');
    service.handleAppUninstall.mockRejectedValueOnce(boom);

    const { res, next } = await run(controller, uninstallBody('db-token'));

    expect(next).toHaveBeenCalledWith(boom);
    expect(res.headersSent).toBe(false);
  });
});

// Unit-тесты OpenLineEvent DTO (M5.2 — починены пути data.LINE / data.MESSAGES).
// Фикстура — verified-payload из M5.1 (все значения строки — form-encoded).

import { describe, expect, it } from 'vitest';
import {
  OpenLineEvent,
  OPENLINE_MESSAGE_ADD_EVENT,
  OPENLINE_MESSAGE_UPDATE_EVENT,
  OPENLINE_MESSAGE_DELETE_EVENT,
  OPENLINE_DIALOG_FINISH_EVENT,
  APP_UNINSTALL_EVENT,
} from '../../src/modules/b24/models/OpenLineEvent.js';

// Verified payload M5.1 (форма как приходит из express.urlencoded)
function verifiedBody() {
  return {
    event: 'ONIMCONNECTORMESSAGEADD',
    auth: {
      application_token: 'test-app-token',
      domain: 'example.bitrix24.ru',
      user_id: '1',
    },
    data: {
      CONNECTOR: 'max_b24',
      LINE: '42',
      MESSAGES: [
        {
          im: { chat_id: '21186', message_id: '1459190' },
          message: { user_id: '1', text: '[b]Олег Смирнов:[/b] [br]Тык из Б24' },
          chat: { id: 'max:-70000000000954' },
        },
      ],
    },
  };
}

describe('OpenLineEvent', () => {
  describe('геттеры на verified-payload', () => {
    it('lineId === "42"', () => {
      const event = OpenLineEvent.fromWebhookBody(verifiedBody());
      expect(event.lineId).toBe('42');
    });

    it('connectorId === "max_b24"', () => {
      const event = OpenLineEvent.fromWebhookBody(verifiedBody());
      expect(event.connectorId).toBe('max_b24');
    });

    it('messages.length === 1', () => {
      const event = OpenLineEvent.fromWebhookBody(verifiedBody());
      expect(event.messages).toHaveLength(1);
    });

    it('applicationToken', () => {
      const event = OpenLineEvent.fromWebhookBody(verifiedBody());
      expect(event.applicationToken).toBe('test-app-token');
    });
  });

  describe('normalizedMessages()', () => {
    it('на verified-payload возвращает корректный плоский объект (без файлов → files:[])', () => {
      const event = OpenLineEvent.fromWebhookBody(verifiedBody());
      expect(event.normalizedMessages()[0]).toEqual({
        connectorChatId: 'max:-70000000000954',
        b24MsgId: '1459190',
        b24ChatId: '21186',
        userId: '1',
        text: '[b]Олег Смирнов:[/b] [br]Тык из Б24',
        externalIds: [],
        editTs: null,
        files: [],
      });
    });

    // M11.2: разбор message.files[] оператора.
    it('извлекает message.files[] (image + file shape) с downloadLink/mime/size', () => {
      const body = {
        event: 'ONIMCONNECTORMESSAGEADD',
        data: {
          CONNECTOR: 'max_b24',
          LINE: '42',
          MESSAGES: [
            {
              im: { chat_id: '21186', message_id: '1459191' },
              message: {
                user_id: '1',
                text: '[b]Имя:[/b] [br]photo.jpg',
                files: [
                  {
                    name: 'photo.jpg',
                    type: 'image',
                    mime: 'image/jpeg',
                    link: 'https://portal/disk/photo.jpg',
                    downloadLink: 'https://portal/pub/im.file.php?FILE_ID=1&SIGN=x&img=y',
                    size: 2048,
                    sizef: '2 KB',
                  },
                  {
                    name: 'doc.pdf',
                    type: 'file',
                    mime: 'application/pdf',
                    link: 'https://portal/disk/doc.pdf',
                    downloadLink: 'https://portal/pub/im.file.php?FILE_ID=2&SIGN=y',
                    size: 4096,
                    sizef: '4 KB',
                  },
                ],
              },
              chat: { id: 'max:-70000000000954' },
            },
          ],
        },
      };
      const event = OpenLineEvent.fromWebhookBody(body);
      const files = event.normalizedMessages()[0].files;
      expect(files).toEqual([
        {
          name: 'photo.jpg',
          mime: 'image/jpeg',
          type: 'image',
          downloadLink: 'https://portal/pub/im.file.php?FILE_ID=1&SIGN=x&img=y',
          size: 2048,
          width: null,
          height: null,
        },
        {
          name: 'doc.pdf',
          mime: 'application/pdf',
          type: 'file',
          downloadLink: 'https://portal/pub/im.file.php?FILE_ID=2&SIGN=y',
          size: 4096,
          width: null,
          height: null,
        },
      ]);
    });

    // M28: width/height картинки (px) — по ним картинка больше лимита стороны MAX уходит
    // файлом. form-urlencoded приносит строки, JSON — числа; нет или мусор → null.
    it.each([
      ['строки (form-urlencoded)', { width: '8000', height: '300' }, { width: 8000, height: 300 }],
      ['числа', { width: 1920, height: 1080 }, { width: 1920, height: 1080 }],
      ['нет полей', {}, { width: null, height: null }],
      ['мусор / ноль / дробь', { width: 'abc', height: '0' }, { width: null, height: null }],
      ['отрицательное и дробное', { width: -5, height: '12.5' }, { width: null, height: null }],
    ])('M28: width/height файла — %s', (_label, dims, expected) => {
      const body = {
        event: 'ONIMCONNECTORMESSAGEADD',
        data: {
          MESSAGES: [
            {
              im: { chat_id: '1', message_id: '2' },
              message: {
                user_id: '1',
                text: '',
                files: [{ name: 'big.png', type: 'image', mime: 'image/png', downloadLink: 'https://portal/pub/x', ...dims }],
              },
              chat: { id: 'max:-1' },
            },
          ],
        },
      };
      const [file] = OpenLineEvent.fromWebhookBody(body).normalizedMessages()[0].files;
      expect({ width: file.width, height: file.height }).toEqual(expected);
    });

    it('сообщение без файлов → files:[]', () => {
      const event = OpenLineEvent.fromWebhookBody(verifiedBody());
      expect(event.normalizedMessages()[0].files).toEqual([]);
    });

    it('файл без downloadLink/link → отбрасывается', () => {
      const body = {
        event: 'ONIMCONNECTORMESSAGEADD',
        data: {
          MESSAGES: [
            {
              im: { chat_id: '1', message_id: '2' },
              message: { user_id: '1', text: '', files: [{ name: 'x', mime: 'image/png' }] },
              chat: { id: 'max:-1' },
            },
          ],
        },
      };
      const event = OpenLineEvent.fromWebhookBody(body);
      expect(event.normalizedMessages()[0].files).toEqual([]);
    });
  });

  describe('isMessageAdd()', () => {
    it('true для ВЕРХНЕГО регистра ONIMCONNECTORMESSAGEADD', () => {
      const event = new OpenLineEvent({ event: 'ONIMCONNECTORMESSAGEADD' });
      expect(event.isMessageAdd()).toBe(true);
    });

    it('true для смешанного регистра OnImConnectorMessageAdd', () => {
      const event = new OpenLineEvent({ event: 'OnImConnectorMessageAdd' });
      expect(event.isMessageAdd()).toBe(true);
    });

    it('false для другого события', () => {
      const event = new OpenLineEvent({ event: 'OnImBotMessageAdd' });
      expect(event.isMessageAdd()).toBe(false);
    });

    it('константа OPENLINE_MESSAGE_ADD_EVENT совпадает с ВЕРХНИМ регистром', () => {
      expect(OPENLINE_MESSAGE_ADD_EVENT).toBe('ONIMCONNECTORMESSAGEADD');
    });
  });

  describe('isMessageUpdate() + правка payload', () => {
    it('true для ВЕРХНЕГО регистра ONIMCONNECTORMESSAGEUPDATE', () => {
      const event = new OpenLineEvent({ event: 'ONIMCONNECTORMESSAGEUPDATE' });
      expect(event.isMessageUpdate()).toBe(true);
    });

    it('true для смешанного регистра OnImConnectorMessageUpdate', () => {
      const event = new OpenLineEvent({ event: 'OnImConnectorMessageUpdate' });
      expect(event.isMessageUpdate()).toBe(true);
    });

    it('false для MessageAdd; и isMessageAdd false для Update (взаимоисключающи)', () => {
      const add = new OpenLineEvent({ event: 'ONIMCONNECTORMESSAGEADD' });
      const upd = new OpenLineEvent({ event: 'ONIMCONNECTORMESSAGEUPDATE' });
      expect(add.isMessageUpdate()).toBe(false);
      expect(upd.isMessageAdd()).toBe(false);
    });

    it('константа OPENLINE_MESSAGE_UPDATE_EVENT === ВЕРХНИЙ регистр', () => {
      expect(OPENLINE_MESSAGE_UPDATE_EVENT).toBe('ONIMCONNECTORMESSAGEUPDATE');
    });

    it('normalizedMessages() извлекает externalIds (message.id[]) и editTs (message.date)', () => {
      const event = OpenLineEvent.fromWebhookBody({
        event: 'ONIMCONNECTORMESSAGEUPDATE',
        auth: { application_token: 'tok' },
        data: {
          CONNECTOR: 'max_b24',
          LINE: '42',
          MESSAGES: [
            {
              im: { chat_id: '21186', message_id: '1459190' },
              message: {
                id: ['mid.MAX777'],
                user_id: '1',
                text: '[b]Имя:[/b] [br]правка',
                date: 1700000123,
              },
              chat: { id: 'max:-70000000000954' },
            },
          ],
        },
      });
      const n = event.normalizedMessages()[0];
      expect(n.externalIds).toEqual(['mid.MAX777']);
      expect(n.editTs).toBe(1700000123);
      expect(n.b24MsgId).toBe('1459190');
      expect(n.connectorChatId).toBe('max:-70000000000954');
    });

    it('normalizedMessages(): externalIds=[] и editTs=null когда message.id/date отсутствуют', () => {
      const event = OpenLineEvent.fromWebhookBody({
        event: 'ONIMCONNECTORMESSAGEUPDATE',
        data: {
          MESSAGES: [
            { im: { chat_id: '1', message_id: '2' }, message: { text: 'x' }, chat: { id: 'max:-1' } },
          ],
        },
      });
      const n = event.normalizedMessages()[0];
      expect(n.externalIds).toEqual([]);
      expect(n.editTs).toBeNull();
    });
  });

  describe('isMessageDelete() + delete payload (строковый message.id)', () => {
    it('true для ВЕРХНЕГО регистра ONIMCONNECTORMESSAGEDELETE', () => {
      const event = new OpenLineEvent({ event: 'ONIMCONNECTORMESSAGEDELETE' });
      expect(event.isMessageDelete()).toBe(true);
    });

    it('true для смешанного регистра OnImConnectorMessageDelete', () => {
      const event = new OpenLineEvent({ event: 'OnImConnectorMessageDelete' });
      expect(event.isMessageDelete()).toBe(true);
    });

    it('взаимоисключающи: delete-событие не считается add/update', () => {
      const del = new OpenLineEvent({ event: 'ONIMCONNECTORMESSAGEDELETE' });
      expect(del.isMessageAdd()).toBe(false);
      expect(del.isMessageUpdate()).toBe(false);
      const add = new OpenLineEvent({ event: 'ONIMCONNECTORMESSAGEADD' });
      expect(add.isMessageDelete()).toBe(false);
    });

    it('константа OPENLINE_MESSAGE_DELETE_EVENT === ВЕРХНИЙ регистр', () => {
      expect(OPENLINE_MESSAGE_DELETE_EVENT).toBe('ONIMCONNECTORMESSAGEDELETE');
    });

    // ⚠️ Ключевое отличие delete-payload: message.id приходит СТРОКОЙ, а не массивом.
    it('normalizedMessages(): строковый message.id → externalIds=[String(id)]', () => {
      const event = OpenLineEvent.fromWebhookBody({
        event: 'ONIMCONNECTORMESSAGEDELETE',
        auth: { application_token: 'tok' },
        data: {
          CONNECTOR: 'max_b24',
          LINE: '42',
          MESSAGES: [
            {
              im: { chat_id: '21186', message_id: '1459190' },
              message: { id: 'max:mid:mid.MAX777' },
              chat: { id: 'max:-70000000000954' },
            },
          ],
        },
      });
      const n = event.normalizedMessages()[0];
      expect(n.externalIds).toEqual(['max:mid:mid.MAX777']);
      expect(n.b24MsgId).toBe('1459190');
      expect(n.connectorChatId).toBe('max:-70000000000954');
    });

    it('normalizedMessages(): числовой message.id → externalIds=[String(id)]', () => {
      const event = OpenLineEvent.fromWebhookBody({
        event: 'ONIMCONNECTORMESSAGEDELETE',
        data: {
          MESSAGES: [
            { im: { chat_id: '1', message_id: '2' }, message: { id: 12345 }, chat: { id: 'max:-1' } },
          ],
        },
      });
      expect(event.normalizedMessages()[0].externalIds).toEqual(['12345']);
    });

    // Регресс: update-payload по-прежнему отдаёт message.id как массив (backward-compatible).
    it('регресс: массив message.id (update) остаётся массивом', () => {
      const event = OpenLineEvent.fromWebhookBody({
        event: 'ONIMCONNECTORMESSAGEUPDATE',
        data: {
          MESSAGES: [
            {
              im: { chat_id: '1', message_id: '2' },
              message: { id: ['mid.A', 'mid.B'], text: 'x' },
              chat: { id: 'max:-1' },
            },
          ],
        },
      });
      expect(event.normalizedMessages()[0].externalIds).toEqual(['mid.A', 'mid.B']);
    });

    it('normalizedMessages(): message.id отсутствует → externalIds=[]', () => {
      const event = OpenLineEvent.fromWebhookBody({
        event: 'ONIMCONNECTORMESSAGEDELETE',
        data: {
          MESSAGES: [{ im: { chat_id: '1', message_id: '2' }, message: {}, chat: { id: 'max:-1' } }],
        },
      });
      expect(event.normalizedMessages()[0].externalIds).toEqual([]);
    });
  });

  describe('isDialogFinish() + normalizedDialogs() (M25)', () => {
    // Live (2026-10-08): connector.chat_id и chat.id — оба внешний id чата коннектора.
    const dialogItem = {
      connector: { connector_id: 'max_b24', line_id: '42', chat_id: 'max:-70000000000954', user_id: '0' },
      session: { id: '16340', closed: 'Y', parent_id: '16338', close_term: '10' },
      chat: { id: 'max:-70000000000954' },
      user: { id: '0' },
    };

    it('true для ВЕРХНЕГО и смешанного регистра; не пересекается с Add/Update/Delete', () => {
      const upper = new OpenLineEvent({ event: 'ONIMCONNECTORDIALOGFINISH' });
      const mixed = new OpenLineEvent({ event: 'OnImConnectorDialogFinish' });
      expect(upper.isDialogFinish()).toBe(true);
      expect(mixed.isDialogFinish()).toBe(true);
      expect(upper.isMessageAdd() || upper.isMessageUpdate() || upper.isMessageDelete()).toBe(false);
      expect(new OpenLineEvent({ event: 'ONIMCONNECTORMESSAGEADD' }).isDialogFinish()).toBe(false);
      expect(OPENLINE_DIALOG_FINISH_EVENT).toBe('ONIMCONNECTORDIALOGFINISH');
    });

    it('form-urlencoded (строки) → числа сессий, строки id чатов', () => {
      const event = OpenLineEvent.fromWebhookBody({
        event: 'ONIMCONNECTORDIALOGFINISH',
        data: { CONNECTOR: 'max_b24', LINE: '42', DATA: [dialogItem] },
      });
      expect(event.normalizedDialogs()).toEqual([{
        connectorId: 'max_b24',
        lineId: '42',
        connectorChatId: 'max:-70000000000954',
        sessionId: 16340,
        parentSessionId: 16338,
        closed: 'Y',
      }]);
    });

    it('JSON (числа), DATA объектом с ключами 0,1; нет connector.chat_id → chat.id; пропуски → верхний уровень/null', () => {
      const event = OpenLineEvent.fromWebhookBody({
        event: 'ONIMCONNECTORDIALOGFINISH',
        data: {
          CONNECTOR: 'max_b24',
          LINE: 42,
          DATA: {
            0: { session: { id: 3282, closed: 'Y', parent_id: 0 }, chat: { id: 8 } },
            1: {},
          },
        },
      });
      expect(event.normalizedDialogs()).toEqual([
        {
          connectorId: 'max_b24',
          lineId: '42',
          connectorChatId: '8',
          sessionId: 3282,
          parentSessionId: null,
          closed: 'Y',
        },
        {
          connectorId: 'max_b24',
          lineId: '42',
          connectorChatId: null,
          sessionId: null,
          parentSessionId: null,
          closed: null,
        },
      ]);
    });

    it('нет DATA → []', () => {
      expect(new OpenLineEvent({ event: 'ONIMCONNECTORDIALOGFINISH', data: {} }).normalizedDialogs()).toEqual([]);
    });
  });

  describe('isAppUninstall() + cleanRequested (M26)', () => {
    // b24-dev-mcp on-app-uninstall: data{LANGUAGE_ID, CLEAN}, CLEAN — integer 1|0, в примере "1".
    function uninstall(data) {
      return OpenLineEvent.fromWebhookBody({
        event: 'ONAPPUNINSTALL',
        auth: { application_token: 't', member_id: 'm' },
        data,
      });
    }

    it('true для ВЕРХНЕГО и смешанного регистра; не пересекается с событиями ОЛ', () => {
      const upper = new OpenLineEvent({ event: 'ONAPPUNINSTALL' });
      expect(upper.isAppUninstall()).toBe(true);
      expect(new OpenLineEvent({ event: 'OnAppUninstall' }).isAppUninstall()).toBe(true);
      expect(
        upper.isMessageAdd() || upper.isMessageUpdate() || upper.isMessageDelete() || upper.isDialogFinish(),
      ).toBe(false);
      expect(new OpenLineEvent({ event: 'ONAPPINSTALL' }).isAppUninstall()).toBe(false);
      expect(APP_UNINSTALL_EVENT).toBe('ONAPPUNINSTALL');
    });

    it.each([
      ['строка "1" (form-urlencoded, пример доки)', { LANGUAGE_ID: 'ru', CLEAN: '1' }, true],
      ['число 1 (JSON, тип по доке)', { CLEAN: 1 }, true],
      ['строка "0"', { CLEAN: '0' }, false],
      ['число 0', { CLEAN: 0 }, false],
      ['поля нет', { LANGUAGE_ID: 'ru' }, false],
      ['data нет', undefined, false],
      ['массив (дубли ключа CLEAN)', { CLEAN: ['1', '1'] }, false],
      ['объект', { CLEAN: { 0: '1' } }, false],
      ['мусор', { CLEAN: 'yes' }, false],
    ])('cleanRequested: %s → %s', (_label, data, expected) => {
      expect(uninstall(data).cleanRequested).toBe(expected);
    });
  });

  describe('edge cases', () => {
    it('messages === [] при отсутствующем data', () => {
      const event = new OpenLineEvent({ event: 'ONIMCONNECTORMESSAGEADD', data: null });
      expect(event.messages).toEqual([]);
    });

    it('messages === [] при пустом data.MESSAGES', () => {
      const event = new OpenLineEvent({ event: 'ONIMCONNECTORMESSAGEADD', data: { MESSAGES: [] } });
      expect(event.messages).toEqual([]);
    });

    it('lineId === null при отсутствующем data', () => {
      const event = new OpenLineEvent({ event: 'ONIMCONNECTORMESSAGEADD', data: null });
      expect(event.lineId).toBeNull();
    });

    it('connectorId === null при отсутствующем data', () => {
      const event = new OpenLineEvent({ event: 'ONIMCONNECTORMESSAGEADD', data: null });
      expect(event.connectorId).toBeNull();
    });

    it('normalizedMessages() при пустых messages — возвращает []', () => {
      const event = new OpenLineEvent({ event: 'ONIMCONNECTORMESSAGEADD', data: null });
      expect(event.normalizedMessages()).toEqual([]);
    });

    it('fromWebhookBody: бросает если нет event', () => {
      expect(() => OpenLineEvent.fromWebhookBody({ data: {} })).toThrow(TypeError);
    });

    it('fromWebhookBody: бросает если body не объект', () => {
      expect(() => OpenLineEvent.fromWebhookBody('string')).toThrow(TypeError);
    });
  });
});

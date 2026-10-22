// DTO для imconnector.send.messages (inbound MAX → Open Lines).
//
// Отражает Verified schema (M4.1, live-probe example.bitrix24.ru):
//   chat:    {id}                   — поле type НЕ шлём (в схеме отсутствует); name
//                                       imopenlines не читает (M24) — его ставит chat.name.set
//   user:    {id, name, last_name?, picture?}  — пол на inbound не нужен
//   message: {id, text, date}       — date в СЕКУНДАХ (unix-ts)
//
// ⚠️ date — unix-ts в СЕКУНДАХ (10 цифр), не миллисекунды. Конверсию из MAX
// update.timestamp (мс) делает messagingService.routeInbound.
//
// M11.2: files[] — медиа inbound (MAX → Open Lines). Б24 качает файлы сам по
// message.files[].url. Инвариант Б24: у сообщения должен
// быть text ЛИБО непустой files — пустое и без файлов слать нечего (hasContent()).
export class ConnectorMessage {
  constructor({ connectorChatId, externalMessageId, text, date, author, files = [] }) {
    if (!connectorChatId) throw new TypeError('ConnectorMessage: connectorChatId required');
    if (!externalMessageId) throw new TypeError('ConnectorMessage: externalMessageId required');
    if (!author?.id) throw new TypeError('ConnectorMessage: author.id required');
    if (typeof text !== 'string') throw new TypeError('ConnectorMessage: text must be string');
    if (typeof date !== 'number' || !Number.isFinite(date)) {
      throw new TypeError('ConnectorMessage: date must be number (unix-ts seconds)');
    }
    if (!Array.isArray(files)) throw new TypeError('ConnectorMessage: files must be array');
    this.connectorChatId = connectorChatId;
    this.externalMessageId = externalMessageId;
    this.text = text;
    this.date = date;
    // author: {id, name, lastName?, picture?, fallbackName?}
    this.author = author;
    // files: [{ url, name }] — дефолт пустой массив (текст-только сообщение).
    this.files = files;
  }

  // M11.2: есть ли что слать в Б24 (текст ЛИБО хотя бы один файл).
  hasContent() {
    return Boolean(this.text) || this.files.length > 0;
  }
}

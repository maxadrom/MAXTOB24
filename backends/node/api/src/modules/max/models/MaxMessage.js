// DTO для исходящего сообщения в MAX-чат.
// M11.2: attachments — массив элементов { type, payload } для POST /messages
// (медиа оператора OL → MAX). payload приходит из upload-флоу
// (maxClient.buildAttachmentPayload): для file — { token }, для image — { photos }.
// Reply/цитирование: link — опциональная связь { type:'reply', mid } для нативного
// кликабельного reply OL→MAX (контракт MAX Bot API, снят live 2026-06-10).
export class MaxMessage {
  constructor({ chatId, text, format = null, attachments = null, link = null }) {
    if (!chatId) throw new TypeError('MaxMessage: chatId required');
    if (typeof text !== 'string') throw new TypeError('MaxMessage: text must be string');
    // Reply: если link задан — mid обязателен (без него MAX не найдёт родителя).
    if (link != null && !link.mid) {
      throw new TypeError('MaxMessage: link.mid required when link is set');
    }
    this.chatId = chatId;
    this.text = text;
    this.format = format;
    this.attachments = attachments;
    this.link = link;
  }

  // M11.2: собрать один элемент attachments[] под POST /messages.
  // type — image|video|audio|file; payload — результат upload-флоу (см. выше).
  static attachment(type, payload) {
    if (!type) throw new TypeError('MaxMessage.attachment: type required');
    if (!payload || typeof payload !== 'object') {
      throw new TypeError('MaxMessage.attachment: payload object required');
    }
    return { type, payload };
  }
}

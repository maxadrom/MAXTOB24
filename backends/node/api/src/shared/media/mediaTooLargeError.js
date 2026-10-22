// M22: файл больше MEDIA_MAX_BYTES — по заявленному размеру, Content-Length или счётчику
// байт посреди скачивания. Не сбой апстрима: координатор пропускает файл и сообщает
// оператору, ретраить нечего.

export class MediaTooLargeError extends Error {
  constructor(message, { size = null, limit = null } = {}) {
    super(message);
    this.name = 'MediaTooLargeError';
    this.size = size;
    this.limit = limit;
  }
}

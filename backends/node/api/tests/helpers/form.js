// Сериализация тела в application/x-www-form-urlencoded с КОРРЕКТНЫМИ индексами
// массивов (data[MESSAGES][0][im][message_id]=...). Нужно для smoke-тестов
// /webhook/b24: реальный Bitrix24 шлёт OnImConnectorMessageAdd именно так, а
// express.urlencoded({ extended:true }) разворачивает [0] в массив.
//
// Почему не supertest .type('form').send(obj): superagent сериализует
// массив-объектов БЕЗ индекса ([MESSAGES][im] вместо [MESSAGES][0][im]) →
// express парсит MESSAGES как объект, не массив → routeOutbound видит
// no-messages. Этот хелпер шлём строкой через .send(encodeForm(body)).

function encodePairs(value, keyPrefix, out) {
  if (value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => encodePairs(item, `${keyPrefix}[${i}]`, out));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      encodePairs(v, `${keyPrefix}[${k}]`, out);
    }
    return;
  }
  out.push(`${encodeURIComponent(keyPrefix)}=${encodeURIComponent(String(value))}`);
}

export function encodeForm(body) {
  const out = [];
  for (const [k, v] of Object.entries(body)) {
    encodePairs(v, k, out);
  }
  return out.join('&');
}

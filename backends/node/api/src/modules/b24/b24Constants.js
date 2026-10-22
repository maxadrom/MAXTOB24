// Дефолты для регистрации B24-коннектора: брендированная SVG-иконка КЦ + флаги
// CHAT_GROUP/NEED_SIGNATURE (оба обязательны архитектурно для
// группировки авторов в одной OL-сессии). Иконка — белый бабл на красном
// (#E33D32) фоне для активной плитки и бледно-красный (#F0A9A4) на белом для
// неактивной. SVG хранится уже percent-encoded (готовый DATA_IMAGE).
// Зелёную галочку «подключено» и подпись (NAME) рисует сам Битрикс.

// Активная плитка: белый бабл (#FFFFFF) на красном фоне (COLOR #E33D32).
const ICON_SVG =
  'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%3E%3Cpath%20fill%3D%22%23FFFFFF%22%20d%3D%22M8.2%202.8%20h7.6%20a6.2%206.2%200%200%201%206.2%206.2%20v3.8%20a6.2%206.2%200%200%201%20-6.2%206.2%20h-7.6%20a6.2%206.2%200%200%201%20-6.2%20-6.2%20v-3.8%20a6.2%206.2%200%200%201%206.2%20-6.2%20z%22%2F%3E%3Cpath%20fill%3D%22%23FFFFFF%22%20d%3D%22M5.0%2016.8%20L4.6%2022.4%20L10.0%2018.0%20Z%22%2F%3E%3C%2Fsvg%3E';

// Неактивная плитка: бледно-красный бабл (#F0A9A4) на белом фоне (COLOR #FFFFFF).
const ICON_DISABLED_SVG =
  'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%3E%3Cpath%20fill%3D%22%23F0A9A4%22%20d%3D%22M8.2%202.8%20h7.6%20a6.2%206.2%200%200%201%206.2%206.2%20v3.8%20a6.2%206.2%200%200%201%20-6.2%206.2%20h-7.6%20a6.2%206.2%200%200%201%20-6.2%20-6.2%20v-3.8%20a6.2%206.2%200%200%201%206.2%20-6.2%20z%22%2F%3E%3Cpath%20fill%3D%22%23F0A9A4%22%20d%3D%22M5.0%2016.8%20L4.6%2022.4%20L10.0%2018.0%20Z%22%2F%3E%3C%2Fsvg%3E';

export const B24_CONNECTOR_DEFAULTS = Object.freeze({
  ICON: Object.freeze({
    DATA_IMAGE: ICON_SVG,
    COLOR: '#E33D32',
    SIZE: '88%',
    POSITION: 'center',
  }),
  ICON_DISABLED: Object.freeze({
    DATA_IMAGE: ICON_DISABLED_SVG,
    COLOR: '#FFFFFF',
    SIZE: '88%',
    POSITION: 'center',
  }),
  CHAT_GROUP: true,
  NEED_SIGNATURE: true,
});

// Unit-тесты конвертеров BB-кодов (M5.3).
// bbcodeToPlainText удалён — кейсы мигрированы в bbcodeToMarkdown.
// markdownToBbcode заменён на markupToBbcode (MAX шлёт body.markup, не markdown-маркеры).

import { describe, expect, it } from 'vitest';
import {
  bbcodeToMarkdown,
  buildReplyQuoteBbcode,
  escapeBbcode,
  markupToBbcode,
  resolveMediaCaption,
} from '../../src/modules/b24/bbcode.js';

// Security M13: нейтрализация литеральных BB-скобок пользователя (ZWSP после '[').
const ZWSP = '​';

describe('escapeBbcode + markupToBbcode escaping (security M13)', () => {
  it('escapeBbcode вставляет ZWSP после каждой [', () => {
    expect(escapeBbcode('[b]x[/b]')).toBe(`[${ZWSP}b]x[${ZWSP}/b]`);
    expect(escapeBbcode('no brackets')).toBe('no brackets');
    expect(escapeBbcode(null)).toBe('');
  });

  it('markupToBbcode pass-through (без markup) экранирует user-теги', () => {
    // Литеральный [b] без markup НЕ должен стать форматированием в OL.
    expect(markupToBbcode('[b]hack[/b]', [])).toBe(`[${ZWSP}b]hack[${ZWSP}/b]`);
    expect(markupToBbcode('[b]hack[/b]', undefined)).toBe(`[${ZWSP}b]hack[${ZWSP}/b]`);
  });

  it('markupToBbcode: наши теги — реальные, user-скобки внутри span экранированы', () => {
    // 'x[y' жирным: наш [b]…[/b] настоящий, а пользовательская '[' внутри — с ZWSP.
    const out = markupToBbcode('x[y', [{ from: 0, length: 3, type: 'strong' }]);
    expect(out).toBe(`[b]x[${ZWSP}y[/b]`);
  });

  it('buildReplyQuoteBbcode экранирует [ в тексте и имени родителя', () => {
    const out = buildReplyQuoteBbcode({
      type: 'reply',
      parentSenderName: '[admin]',
      parentText: 'see [url=javascript:x]',
    });
    expect(out).not.toContain('[url=');
    expect(out).toContain(`[${ZWSP}url=`);
    expect(out).toContain(`[${ZWSP}admin]`);
    expect(out.startsWith('>>')).toBe(true);
  });
});

describe('bbcodeToMarkdown (outbound BB → markdown)', () => {
  it('verified-payload подпись: [b]Имя:[/b] [br]Тык → "**Имя:**\\nТык"', () => {
    expect(bbcodeToMarkdown('[b]Олег Смирнов:[/b] [br]Тык из Б24')).toBe(
      '**Олег Смирнов:**\nТык из Б24',
    );
  });

  it('[b]…[/b] → **…**', () => {
    expect(bbcodeToMarkdown('[b]жирный[/b]')).toBe('**жирный**');
  });

  it('[B]…[/B] (верхний регистр) → **…**', () => {
    expect(bbcodeToMarkdown('[B]жирный[/B]')).toBe('**жирный**');
  });

  it('[i]…[/i] → _…_', () => {
    expect(bbcodeToMarkdown('[i]курсив[/i]')).toBe('_курсив_');
  });

  it('[I]…[/I] (верхний регистр) → _…_', () => {
    expect(bbcodeToMarkdown('[I]курсив[/I]')).toBe('_курсив_');
  });

  it('[br] → \\n', () => {
    expect(bbcodeToMarkdown('текст[br]продолжение')).toBe('текст\nпродолжение');
  });

  it('[br/] (самозакрывающийся) → \\n', () => {
    expect(bbcodeToMarkdown('текст[br/]продолжение')).toBe('текст\nпродолжение');
  });

  it('[BR] (верхний регистр) → \\n', () => {
    expect(bbcodeToMarkdown('текст[BR]продолжение')).toBe('текст\nпродолжение');
  });

  it('[url=http://x]ссылка[/url] → "ссылка" (тег вырезается)', () => {
    expect(bbcodeToMarkdown('[url=http://x]ссылка[/url]')).toBe('ссылка');
  });

  it('чистый текст без BB-кодов — без изменений', () => {
    expect(bbcodeToMarkdown('просто текст')).toBe('просто текст');
  });

  it('пробелы перед \\n убираются', () => {
    expect(bbcodeToMarkdown('слово   \nновая строка')).toBe('слово\nновая строка');
  });

  it('trim: лидирующие и хвостовые пробелы убираются', () => {
    expect(bbcodeToMarkdown('  текст  ')).toBe('текст');
  });

  it('null → ""', () => {
    expect(bbcodeToMarkdown(null)).toBe('');
  });

  it('undefined → ""', () => {
    expect(bbcodeToMarkdown(undefined)).toBe('');
  });

  it('число → ""', () => {
    expect(bbcodeToMarkdown(123)).toBe('');
  });

  it('пустая строка → ""', () => {
    expect(bbcodeToMarkdown('')).toBe('');
  });

  it('только [br] → "" (после trim)', () => {
    expect(bbcodeToMarkdown('[br]')).toBe('');
  });

  it('неизвестный тег вырезается gracefully', () => {
    expect(bbcodeToMarkdown('[quote]привет[/quote]')).toBe('привет');
  });

  it('[b] и [i] вместе', () => {
    expect(bbcodeToMarkdown('[b]жир[/b] [i]кур[/i]')).toBe('**жир** _кур_');
  });
});

describe('markupToBbcode (inbound MAX markup → BB)', () => {
  it('verified-payload: "Жирный и Курсив" с markup → [b]Жирный[/b] и [i]Курсив[/i]', () => {
    expect(
      markupToBbcode('Жирный и Курсив', [
        { from: 0, length: 6, type: 'strong' },
        { from: 9, length: 6, type: 'emphasized' },
      ]),
    ).toBe('[b]Жирный[/b] и [i]Курсив[/i]');
  });

  it('strong → [b]…[/b]', () => {
    expect(markupToBbcode('жирный', [{ from: 0, length: 6, type: 'strong' }])).toBe('[b]жирный[/b]');
  });

  it('emphasized → [i]…[/i]', () => {
    expect(markupToBbcode('курсив', [{ from: 0, length: 6, type: 'emphasized' }])).toBe('[i]курсив[/i]');
  });

  it('markup в середине текста', () => {
    expect(markupToBbcode('hello world end', [{ from: 6, length: 5, type: 'strong' }])).toBe(
      'hello [b]world[/b] end',
    );
  });

  it('plain текст без markup — без изменений (pass-through)', () => {
    expect(markupToBbcode('просто текст', [])).toBe('просто текст');
  });

  it('markup=undefined → pass-through', () => {
    expect(markupToBbcode('текст', undefined)).toBe('текст');
  });

  it('неизвестный type игнорируется', () => {
    expect(markupToBbcode('текст', [{ from: 0, length: 5, type: 'underline' }])).toBe('текст');
  });

  it('null text → ""', () => {
    expect(markupToBbcode(null, [])).toBe('');
  });

  it('undefined text → ""', () => {
    expect(markupToBbcode(undefined, [])).toBe('');
  });

  it('число text → ""', () => {
    expect(markupToBbcode(123, [])).toBe('');
  });
});

// Reply/цитирование: replyContext → цитата `>>` (тега [quote] в Б24 нет).
describe('buildReplyQuoteBbcode (inbound reply/forward → >>)', () => {
  it('reply с именем и текстом → ">>Имя: текст\\n"', () => {
    const out = buildReplyQuoteBbcode(
      { type: 'reply', parentText: 'текст родителя', parentSenderName: 'Пётр' },
      { maxLen: 200 },
    );
    expect(out).toBe('>>Пётр: текст родителя\n');
  });

  it('forward → помеченная цитата ">>↪ Переслано (Имя): текст"', () => {
    const out = buildReplyQuoteBbcode(
      { type: 'forward', parentText: 'переслано', parentSenderName: 'Анна' },
      { maxLen: 200 },
    );
    expect(out).toBe('>>↪ Переслано (Анна): переслано\n');
  });

  it('обрезка длинного текста по maxLen с многоточием', () => {
    const long = 'a'.repeat(50);
    const out = buildReplyQuoteBbcode(
      { type: 'reply', parentText: long, parentSenderName: 'И' },
      { maxLen: 10 },
    );
    // тело цитаты = ">>И: " + обрезанный текст с многоточием
    const inner = out.replace(/^>>/, '').replace(/\n$/, '');
    expect(inner.startsWith('И: ')).toBe(true);
    expect(inner.endsWith('…')).toBe(true);
    // длина выжимки текста = maxLen (9 символов + многоточие)
    const textPart = inner.slice('И: '.length);
    expect(textPart.length).toBe(10);
  });

  it('родитель-медиа (пустой текст), есть имя → цитата только с именем', () => {
    const out = buildReplyQuoteBbcode(
      { type: 'reply', parentText: '', parentSenderName: 'Мария' },
      { maxLen: 200 },
    );
    expect(out).toBe('>>Мария\n');
  });

  it('reply без имени, есть текст → ">>текст\\n"', () => {
    const out = buildReplyQuoteBbcode(
      { type: 'reply', parentText: 'только текст', parentSenderName: null },
      { maxLen: 200 },
    );
    expect(out).toBe('>>только текст\n');
  });

  it('ни имени, ни текста (reply) → "" (без префикса)', () => {
    const out = buildReplyQuoteBbcode(
      { type: 'reply', parentText: '', parentSenderName: null },
      { maxLen: 200 },
    );
    expect(out).toBe('');
  });

  it('переносы строк в тексте родителя схлопываются в один пробел (цитата — одна строка)', () => {
    const out = buildReplyQuoteBbcode(
      { type: 'reply', parentText: 'строка1\nстрока2', parentSenderName: 'А' },
      { maxLen: 200 },
    );
    expect(out).toBe('>>А: строка1 строка2\n');
  });

  it('null replyContext → ""', () => {
    expect(buildReplyQuoteBbcode(null, { maxLen: 200 })).toBe('');
  });
});

describe('roundtrip: bbcodeToMarkdown (outbound) стабилен без inbound-зависимости', () => {
  it('[b]x[/b] → **x** (outbound конвертация)', () => {
    expect(bbcodeToMarkdown('[b]x[/b]')).toBe('**x**');
  });

  it('[i]x[/i] → _x_ (outbound конвертация)', () => {
    expect(bbcodeToMarkdown('[i]x[/i]')).toBe('_x_');
  });

  it('[b]жир[/b] [i]кур[/i] → **жир** _кур_', () => {
    expect(bbcodeToMarkdown('[b]жир[/b] [i]кур[/i]')).toBe('**жир** _кур_');
  });
});

describe('resolveMediaCaption (подпись оператора к медиа OL → MAX)', () => {
  const files = [{ name: 'photo.jpg' }];

  it('пустой/отсутствующий текст → пустая подпись', () => {
    expect(resolveMediaCaption('', files)).toBe('');
    expect(resolveMediaCaption(null, files)).toBe('');
  });

  it('авто-подпись Б24 с именем файла (filename-ярлык) → подавляется', () => {
    expect(resolveMediaCaption('[b]Иван:[/b] [br]photo.jpg', files)).toBe('');
  });

  it('реальный комментарий после авто-подписи → markdown целиком', () => {
    expect(resolveMediaCaption('[b]Иван:[/b] [br]смотрите', files)).toBe('**Иван:**\nсмотрите');
  });

  it('текст без [br] сравнивается целиком', () => {
    expect(resolveMediaCaption('photo.jpg', files)).toBe('');
    expect(resolveMediaCaption('привет', files)).toBe('привет');
  });
});

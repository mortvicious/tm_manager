import type { ReportLanguage } from '@tm/shared';

/**
 * Everything about a report that is written in the document's own language
 * (docs/reports.md § Language).
 *
 * Both halves live here on purpose. The agent writes the bullets, but the
 * server assembles the headings around them — so if the prompt and the chrome
 * came from different places, a Russian document could end up under an English
 * "Repositories:" line. One record per language, and the pair moves together.
 */
export interface ReportStrings {
  /** `# <title> — отчёт о выполненных работах` */
  docSuffix: string;
  reposLabel: string;
  /** the sentence that tells the reader what the dates mean */
  datesNote: string;
  periodLabel: string;
  /** the whole document when the window delivered nothing */
  nothing: string;
  /** appended to the prompt: the rules the bullets must follow */
  rules: string;
  /** schema field descriptions, so the model is told the language twice */
  summaryDesc: string;
  dateDesc: string;
  bulletsDesc: string;
  /** prompt preamble */
  role: string;
  reposLine: string;
  periodLine: string;
  tasksLine: (n: number, dropped: number) => string;
  intro: string;
  entries: string;
  /** labels on the RAW records fed to the model — in the target language too,
   *  so an English report is not primed by a Russian input sheet */
  fTask: string;
  fRepo: string;
  fRepoUnknown: string;
  fCategory: string;
  fAsked: string;
  fDone: string;
  fReview: string;
}

const RU: ReportStrings = {
  docSuffix: 'отчёт о выполненных работах',
  reposLabel: 'Репозитории',
  datesNote: 'Даты — дата завершения задачи.',
  periodLabel: 'Период',
  nothing: 'За выбранный период завершённых задач нет.',
  role: 'Ты составляешь отчёт о выполненных работах для заказчика — человека, который платит за эту разработку и не читает код.',
  reposLine: 'Репозитории',
  periodLine: 'Период',
  tasksLine: (n, dropped) =>
    `Задач в работе: ${n}${dropped > 0 ? ` (ещё ${dropped} самых ранних не поместились в отчёт)` : ''}`,
  intro:
    'Ниже — сырые записи о задачах, сгруппированные по дате завершения. Преврати их в очень краткий, деловой отчёт ПО-РУССКИ.',
  entries: 'ЗАПИСИ',
  fTask: 'Задача',
  fRepo: 'Репозиторий',
  fRepoUnknown: 'неизвестен',
  fCategory: 'Категория',
  fAsked: 'Что просили',
  fDone: 'Что сделано',
  fReview: 'Проверка',
  summaryDesc: 'Одно-два предложения ПО-РУССКИ: что сделано за период. Без цифр токенов и без служебных деталей.',
  dateDesc: 'YYYY-MM-DD, ровно одна из дат, перечисленных во вводе',
  bulletsDesc: 'Пункты за этот день, ПО-РУССКИ, каждый — одна законченная мысль',
  rules: `ПРАВИЛА:
1. Пиши ПО-РУССКИ, на языке пользы, а не кода. Никаких имён файлов, функций, классов, коммитов, веток, номеров задач и внутреннего жаргона. Исходные записи могут быть на английском — всё равно пиши по-русски.
2. Один пункт — одна законченная мысль о том, что теперь работает или стало лучше. Одна строка, максимум две; без вложенных списков.
3. Несколько задач об одном и том же — объедини в один пункт. Одна большая задача, которая явно принесла несколько разных улучшений, — можно разбить.
4. Не выдумывай. Если по записи непонятно, что сделано, напиши коротко и обобщённо по её названию, но ничего не добавляй от себя.
5. Не пиши мета-фразы вроде «в этот день было сделано» или «команда работала над». Начинай сразу с сути: «Исправлен…», «Добавлен…», «Ускорена…», «Подключено…».
6. Даты бери РОВНО из заголовков ## ниже, в формате YYYY-MM-DD. Не придумывай дат, которых нет во вводе, и не объединяй дни.
7. Порядок дат — по возрастанию. Дни без содержания просто не включай.
8. summary — одно-два предложения о периоде в целом, тем же деловым языком.`,
};

const EN: ReportStrings = {
  docSuffix: 'work report',
  reposLabel: 'Repositories',
  datesNote: 'Dates are the date each task was completed.',
  periodLabel: 'Period',
  nothing: 'No tasks were completed in the selected period.',
  role: 'You are writing a report of completed work for the client — the person paying for this development, who does not read code.',
  reposLine: 'Repositories',
  periodLine: 'Period',
  tasksLine: (n, dropped) =>
    `Tasks in scope: ${n}${dropped > 0 ? ` (${dropped} more, the earliest, did not fit in this report)` : ''}`,
  intro:
    'Below are the raw task records, grouped by completion date. Turn them into a very concise, business-facing report IN ENGLISH.',
  entries: 'RECORDS',
  fTask: 'Task',
  fRepo: 'Repository',
  fRepoUnknown: 'unknown',
  fCategory: 'Category',
  fAsked: 'Asked for',
  fDone: 'Delivered',
  fReview: 'Review',
  summaryDesc: 'One or two sentences IN ENGLISH: what was delivered in the period. No token counts, no internal detail.',
  dateDesc: 'YYYY-MM-DD, exactly one of the dates listed in the input',
  bulletsDesc: 'The bullets for that day, IN ENGLISH, each one a single complete thought',
  rules: `RULES:
1. Write IN ENGLISH, in the language of value rather than of code. No file, function or class names, no commits, branches, task ids or internal jargon. The source records may be in Russian — write in English regardless.
2. One bullet is one complete thought about what now works or got better. One line, two at most; no nested lists.
3. Merge several tasks about the same thing into one bullet. One large task that clearly delivered several distinct improvements may be split.
4. Invent nothing. If a record does not make clear what was done, write a short general line based on its title and add nothing of your own.
5. No meta-phrases like "on this day the team" or "work continued on". Start with the substance: "Fixed…", "Added…", "Sped up…", "Connected…".
6. Take dates EXACTLY from the ## headings below, in YYYY-MM-DD form. Do not invent dates that are not in the input, and do not merge days.
7. Dates ascending. Simply omit days with nothing to say.
8. summary is one or two sentences about the period as a whole, in the same business language.`,
};

export function reportStrings(lang: ReportLanguage): ReportStrings {
  return lang === 'en' ? EN : RU;
}

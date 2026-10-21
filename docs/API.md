# API мок-бэкенда

```bash
npm run mock          # http://localhost:4010/api, ускорение ×3
MOCK_SPEED=1 npm run mock   # как на проде: 30–120 с на задание
```

Состояние живёт в памяти: перезапуск мока всё сбрасывает. Ошибки приходят как `{ code, message, ...extra }` с HTTP-статусом. CORS открыт, но можно ходить и через прокси Next.js.

## Каталог

`GET /api/catalog` → `{ exam, year, tasks: Task[] }`

```ts
type Task = { number: number; title: string; part: 1 | 2; points: number; types: TaskType[] };
type TaskType = {
  id: string; number: number; topic: string; title: string;
  experimental: boolean;          // требует подтверждения учителем перед выдачей
  frequency: "often" | "sometimes" | "rare";
};
```

Типов около 1500, у номеров 17–20 — сотни. Если `typeIds` при генерации не передан, мок выбирает случайный **неэкспериментальный** тип.

## Варианты

```ts
type Variant = {
  id: string; title: string; status: "draft" | "published";
  revision: number;               // растёт при ЛЮБОМ изменении, в том числе от фоновой генерации
  createdAt: string; updatedAt: string; tasks: VariantTask[];
};
type VariantTask = {
  number: number; typeId: string; typeTitle: string; experimental: boolean; points: number; hint: string | null;
  status: "queued" | "running" | "ready" | "failed" | "canceled";
  stage: "author" | "compute" | "judge" | "render" | null; stageTitle: string | null; progress: number; // 0..1
  taskRevision: number;           // растёт при каждой (пере)генерации этого задания
  jobId: string;
  content: null | { statement: string; answer: string; solution: string;   // Markdown + LaTeX ($…$, $$…$$)
                    image: null | { url: string; alt: string } };
  judgeNote?: string;
  failure: null | { code: string; message: string; retriable: boolean };
  confirmation: null | { confirmedAt: string; taskRevision: number };
  issues: { code: string; message: string }[];   // повторная проверка нашла проблему — нужна регенерация
};
```

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| GET | `/api/variants` | — | `{ variants: [...без tasks, с taskCount] }` |
| POST | `/api/variants` | `{ title? }` | `201 Variant` |
| GET | `/api/variants/:id` | — | `Variant`. **Перепроверяет готовые задания**: первое открытие после генерации медленнее, может добавить `issues` |
| PATCH | `/api/variants/:id` | `{ revision, title }` | `Variant` |
| POST | `/api/variants/:id/generate` | `{ revision, tasks: [{ number, typeIds?, hint? }] }` | `202 { jobId, variant }`. Уже существующие номера перегенерируются |
| DELETE | `/api/variants/:id/tasks/:number` | `{ revision }` | `Variant` |
| POST | `/api/variants/:id/tasks/:number/confirm` | `{ revision, taskRevision }` | `Variant`. Только для `experimental`. `409 task_changed`, если задание успели перегенерировать |
| POST | `/api/variants/:id/publish` | `{ revision }` | `Variant` или `422 { blockers: [{ number?, code, message }] }` |

Все записи требуют актуальный `revision`:
- **`409 revision_conflict`** — вариант изменился (другая вкладка, другое устройство, фоновая генерация). В ответе `current` — текущий вариант.
- **`423 published`** — вариант уже выдан и больше не меняется.

## Генерация

| Метод | Путь | Ответ |
|---|---|---|
| GET | `/api/jobs/:jobId` | `{ jobId, status: "running" \| "done" \| "canceled", lastEventId, variant }` — снимок для восстановления |
| GET | `/api/jobs/:jobId/events` | поток SSE, см. ниже |
| POST | `/api/jobs/:jobId/cancel` | `202`. Ожидающие задания отменяются сразу, идущие — на границе этапа |

Одновременно генерируются **не больше двух заданий** на весь мок, остальные ждут в очереди (`queued`).

**Поток `GET /api/jobs/:jobId/events`:**
- без `Last-Event-ID` первым приходит `event: snapshot` с `{ status, lastEventId, variant }`;
- затем события с `id`:
  - `event: task` → `{ jobId, variantRevision, task: VariantTask }`;
  - `event: job` → `{ jobId, status, variantRevision }`;
- с заголовком `Last-Event-ID: N` или `?lastEventId=N` сервер досылает пропущенные события после `N`;
- каждые 15 с приходит комментарий `: ping`;
- **поток может оборваться без закрывающего события** — как у балансировщика или мобильной сети.

## Чертежи

`GET /api/assets/:id.svg` — SVG, отвечает за 0,2–1 с. Иногда чертёж не найден (404).

## Управление моком для e2e-тестов

| Метод | Путь | Тело |
|---|---|---|
| GET/POST | `/api/_mock/faults` | `{ speed, failRate, failNext, dropRate, dropAfterEvents, imageMissingRate, issueRate }` — частичное обновление |
| POST | `/api/_mock/conflict/:variantId` | имитирует правку варианта в другой вкладке (ревизия растёт) |
| POST | `/api/_mock/reset` | сбросить всё |

Например, `failNext: 1` — следующее задание упадёт; `dropAfterEvents: 2` — следующий поток оборвётся после двух событий.

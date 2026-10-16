# Assist Project OS

Справочная структура для передачи контекста Assist между Codex, ChatGPT и Claude. Она не обязательна для работы приложения и не меняет его код. Папка `myproj` — имя документационной папки, а не требование переименовывать исходный проект.

## Что где лежит

```text
myproj/
├── PROJECT.md
├── ARCHITECTURE.md
├── DECISIONS.md
├── STATUS.md
├── README.md
├── TUTORIAL.md
├── Instructions/
│   ├── PROJECT-INSTRUCTIONS.md
│   ├── AI-RULES.md
│   └── APP-PROMPT.md
├── State and process/
│   ├── HISTORY-SUMMARY.md
│   ├── KNOWLEDGE-BASE-MAP.md
│   ├── WORKFLOW.md
│   ├── ARCHIVE-USAGE.md
│   ├── CODEX-TASK-TEMPLATE.md
│   ├── NEW-CHAT-TEMPLATES.md
│   ├── TEST-PLAN.md
│   ├── BACKLOG.md
│   ├── PERFORMANCE-NOTES.md
│   ├── LESSONS.md
│   └── GLOSSARY.md
├── Assist-Codex-Reference.zip    # полный технический комплект для Codex
└── Assist-Shared-Context.zip     # короткий общий комплект для ChatGPT и Claude
```

`PROJECT.md`, `ARCHITECTURE.md`, `DECISIONS.md`, `STATUS.md` и `Instructions/PROJECT-INSTRUCTIONS.md` — короткий общий контекст для ChatGPT и Claude. `Assist-Shared-Context.zip` содержит именно эти файлы. `Assist-Codex-Reference.zip` содержит полный технический набор. Остальные документы и шаблоны не обязательны; заполнять их все не нужно.

Экспорт базы `istok.json` использован только для составления карты тем, источников и размеров. Сам JSON, содержимое источников, история чатов и API-ключи в архив не включены.

## Быстрый старт

1. Открой `TUTORIAL.md`.
2. В ChatGPT или Claude создай Project для Assist и вставь `Instructions/PROJECT-INSTRUCTIONS.md` в инструкции.
3. Для общего контекста загрузи `Assist-Shared-Context.zip` или пять файлов по отдельности. Для Codex при необходимости используй полный `Assist-Codex-Reference.zip` как справку.
4. Создавай отдельный чат внутри этого Project для каждой крупной задачи.
5. Для работы с кодом открой именно текущую папку проекта в Codex/редакторе. Markdown-файлы сами по себе не предоставляют доступ к локальному коду.
6. После изменения кода обнови `STATUS.md`; долговременное решение добавь в `DECISIONS.md`.

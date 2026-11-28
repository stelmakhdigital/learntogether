-- Планировщику нужен последний просмотр: FSRS считаетelapsed days между повторами,
-- а due_at для этого не годится (провал возвращает элемент через 10 минут, и due_at
-- оказывается в тот же день). Состояние храним явно: 'learning' отличается от
-- 'review' не датой, а тем, что элемент ещё не выпускился.

ALTER TABLE repeat_item ADD COLUMN last_review_at TEXT;
ALTER TABLE repeat_item ADD COLUMN state TEXT NOT NULL DEFAULT 'new' CHECK (state IN ('new', 'learning', 'review'));

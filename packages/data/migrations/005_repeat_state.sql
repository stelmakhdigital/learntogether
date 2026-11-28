-- The scheduler needs the last review time: FSRS counts elapsed days between
-- reviews, and due_at cannot stand in for it (a lapse returns the item in ten
-- minutes, so due_at lands on the same day). State is stored explicitly: 'learning'
-- differs from 'review' by not having graduated yet, not by a date.

ALTER TABLE repeat_item ADD COLUMN last_review_at TEXT;
ALTER TABLE repeat_item ADD COLUMN state TEXT NOT NULL DEFAULT 'new' CHECK (state IN ('new', 'learning', 'review'));

# Add a note field to expenses

Each expense should be able to carry a short free-text note ("what was this for"), alongside the title, amount and category it already has.

## What should happen

- The add-expense form has a note input in addition to the existing fields.
- When an expense is added with a note, that note is visible on the expense in the list.
- The note is optional: adding an expense without one keeps working exactly as before.
- Everything that works today keeps working — adding, removing, and the summary totals.

## Acceptance criteria

These are checked automatically, so the exact names matter:

- The note input is reachable by its label, and the label text contains `Note`.
- In each list item, the note is rendered in its own element with `data-testid="expense-note"`.
- The note must not be merged into the title. The element with `data-testid="expense-title"` still contains only the title.

## Notes

The app is a small React + Vite project. `npm test` runs the test suite.
Do not add new dependencies.

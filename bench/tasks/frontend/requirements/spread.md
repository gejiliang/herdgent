# Filter expenses by category

Users want to look at one category at a time — "how much am I actually spending on food".

## What should happen

- There is a category filter control above the list.
- It offers every category, plus an option to show everything.
- Picking a category narrows the list to expenses in that category.
- **The summary reflects what is currently on screen.** If the list is filtered to Food, the item count and the total are the Food count and the Food total — not the totals for everything.
- Switching back to showing everything restores the full list and the full total.
- Adding and removing expenses keep working while a filter is active, and both the list and the summary stay consistent afterwards.

## Acceptance criteria

These are checked automatically, so the exact names matter:

- The filter control is reachable by its label, and the label text contains `Filter`.
- The option that shows everything has the value `All`, and it is the initial state.
- The other option values are exactly the existing category names: `Food`, `Transport`, `Housing`, `Entertainment`, `Other`.
- The existing category selector in the add-expense form keeps its own label, which is exactly `Category`.
- `data-testid="summary-count"` and `data-testid="summary-total"` keep their meaning, but now describe the filtered view.

## Notes

The app is a small React + Vite project. `npm test` runs the test suite.
Do not add new dependencies.

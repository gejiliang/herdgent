# Bug: the total is wrong after removing an expense

## What users see

Open the app. The summary reads 4 items, total 1290.50 — correct.

Remove "Rent" (1200.00). The item count drops to 3, which is right. **The total still says 1290.50.**

It should say 90.50.

Adding expenses updates the total correctly. Only removal is affected. Removing several expenses compounds the error; removing all of them leaves a total that is plainly wrong instead of 0.00.

## What is expected

Removing an expense updates the total the same way adding one does, and the summary always agrees with the list it is describing.

Fix the cause. A patch that recomputes the number at the point where it is displayed, while leaving the underlying state inconsistent, is not a fix — the next feature that reads that state hits the same bug.

Everything that works today must keep working: seeding, adding, removing, and the item count.

## Notes

The app is a small React + Vite project. `npm test` runs the test suite.
Do not add new dependencies.

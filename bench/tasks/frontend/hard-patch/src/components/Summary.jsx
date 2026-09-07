export default function Summary({ expenses, total }) {
  return (
    <section aria-label="Summary">
      <p>
        Items: <span data-testid="summary-count">{expenses.length}</span>
      </p>
      <p>
        Total: <span data-testid="summary-total">{total.toFixed(2)}</span>
      </p>
    </section>
  );
}

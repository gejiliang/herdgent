export default function ExpenseList({ expenses, onRemove }) {
  if (expenses.length === 0) {
    return <p>No expenses yet.</p>;
  }

  return (
    <ul aria-label="Expenses">
      {expenses.map((e) => (
        <li key={e.id} data-testid="expense-item">
          <span data-testid="expense-title">{e.title}</span>
          <span data-testid="expense-category">{e.category}</span>
          <span data-testid="expense-amount">{e.amount.toFixed(2)}</span>
          <button type="button" onClick={() => onRemove(e.id)}>
            Remove {e.title}
          </button>
        </li>
      ))}
    </ul>
  );
}

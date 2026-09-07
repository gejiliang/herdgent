import { useState } from "react";
import { CATEGORIES } from "../state/expenses.js";

export default function ExpenseForm({ onAdd }) {
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]);

  function handleSubmit(e) {
    e.preventDefault();
    if (!title.trim() || !amount) return;
    onAdd({ title: title.trim(), amount, category });
    setTitle("");
    setAmount("");
    setCategory(CATEGORIES[0]);
  }

  return (
    <form onSubmit={handleSubmit} aria-label="Add expense">
      <label>
        Title
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>

      <label>
        Amount
        <input
          type="number"
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>

      <label>
        Category
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>

      <button type="submit">Add expense</button>
    </form>
  );
}

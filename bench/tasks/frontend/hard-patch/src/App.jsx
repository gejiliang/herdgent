import { useReducer } from "react";
import ExpenseForm from "./components/ExpenseForm.jsx";
import ExpenseList from "./components/ExpenseList.jsx";
import Summary from "./components/Summary.jsx";
import { expensesReducer, initialState } from "./state/expenses.js";

export default function App() {
  const [state, dispatch] = useReducer(expensesReducer, initialState);

  return (
    <main>
      <h1>Expense Tracker</h1>
      <ExpenseForm onAdd={(payload) => dispatch({ type: "add", payload })} />
      <Summary expenses={state.expenses} total={state.total} />
      <ExpenseList
        expenses={state.expenses}
        onRemove={(id) => dispatch({ type: "remove", payload: { id } })}
      />
    </main>
  );
}

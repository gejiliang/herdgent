// 难题版本：这里埋着 bug。
//
// 【别把注释写成提示】——这个文件会原样进 fixture，agent 看得到。
// 所以下面只留正常的实现说明，不提任何「注意」「小心」之类的暗示。

export const CATEGORIES = ["Food", "Transport", "Housing", "Entertainment", "Other"];

export const initialExpenses = [
  { id: 1, title: "Groceries", amount: 42.5, category: "Food" },
  { id: 2, title: "Bus pass", amount: 30, category: "Transport" },
  { id: 3, title: "Rent", amount: 1200, category: "Housing" },
  { id: 4, title: "Cinema", amount: 18, category: "Entertainment" },
];

// 合计是热路径上的读取，所以在 state 里带一份，避免每次渲染都重算整表。
export const initialState = {
  expenses: initialExpenses,
  nextId: 5,
  total: initialExpenses.reduce((s, e) => s + e.amount, 0),
};

export function expensesReducer(state, action) {
  switch (action.type) {
    case "add": {
      const { title, amount, category } = action.payload;
      const value = Number(amount);
      return {
        ...state,
        expenses: [
          ...state.expenses,
          { id: state.nextId, title, amount: value, category },
        ],
        nextId: state.nextId + 1,
        total: state.total + value,
      };
    }
    case "remove":
      return {
        ...state,
        expenses: state.expenses.filter((e) => e.id !== action.payload.id),
      };
    default:
      return state;
  }
}

export function totalOf(expenses) {
  return expenses.reduce((sum, e) => sum + e.amount, 0);
}

// 费用记录的状态。刻意用 useReducer 而不是散落的 useState：
// 这样「加字段」「加筛选」这类需求必然要同时动 reducer 和组件，
// 才测得出 harness 能不能顺着数据流找全该改的地方。

export const CATEGORIES = ["Food", "Transport", "Housing", "Entertainment", "Other"];

export const initialExpenses = [
  { id: 1, title: "Groceries", amount: 42.5, category: "Food" },
  { id: 2, title: "Bus pass", amount: 30, category: "Transport" },
  { id: 3, title: "Rent", amount: 1200, category: "Housing" },
  { id: 4, title: "Cinema", amount: 18, category: "Entertainment" },
];

export const initialState = {
  expenses: initialExpenses,
  nextId: 5,
};

export function expensesReducer(state, action) {
  switch (action.type) {
    case "add": {
      const { title, amount, category } = action.payload;
      return {
        ...state,
        expenses: [
          ...state.expenses,
          { id: state.nextId, title, amount: Number(amount), category },
        ],
        nextId: state.nextId + 1,
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

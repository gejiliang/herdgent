// 难题：合计在删除后不对。
//
// 题面只给症状，不给位置 —— 真因是 state 里那份冗余的 total 只在 add 时维护、
// remove 时漏了。要修对得先看懂 reducer 与 Summary 之间的数据关系，
// 而不是在 Summary 里贴个补丁把数字算回来。
//
// 最后一条断言正是防补丁的：既然 total 已经和 expenses 冗余，
// 正确的修法要么让它们始终同步，要么干脆去掉冗余 —— 两种都能过。
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../src/App.jsx";
import { expensesReducer, initialState, totalOf } from "../src/state/expenses.js";

describe("总额在删除后应保持正确", () => {
  it("初始状态是对的", () => {
    render(<App />);
    expect(screen.getByTestId("summary-total").textContent).toBe("1290.50");
  });

  it("删掉一条之后总额要跟着降", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: /remove rent/i }));
    expect(screen.getByTestId("summary-count").textContent).toBe("3");
    expect(screen.getByTestId("summary-total").textContent).toBe("90.50");
  });

  it("连删两条", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: /remove rent/i }));
    await user.click(screen.getByRole("button", { name: /remove cinema/i }));
    expect(screen.getByTestId("summary-total").textContent).toBe("72.50");
  });

  it("先加后删，总额仍然对得上", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByLabelText(/title/i), "Book");
    await user.type(screen.getByLabelText(/amount/i), "15");
    await user.click(screen.getByRole("button", { name: /add expense/i }));
    expect(screen.getByTestId("summary-total").textContent).toBe("1305.50");

    await user.click(screen.getByRole("button", { name: /remove book/i }));
    expect(screen.getByTestId("summary-total").textContent).toBe("1290.50");
  });

  it("删光了是 0.00，不是负数也不是残留值", async () => {
    const user = userEvent.setup();
    render(<App />);
    for (const name of [/remove groceries/i, /remove bus pass/i, /remove rent/i, /remove cinema/i]) {
      await user.click(screen.getByRole("button", { name }));
    }
    expect(screen.getByTestId("summary-total").textContent).toBe("0.00");
  });

  it("reducer 层面：删除后 state 自身必须自洽", () => {
    const after = expensesReducer(initialState, { type: "remove", payload: { id: 3 } });
    // 要么维护好那份冗余的 total，要么把它去掉 —— 两种修法都能过这条
    const cached = after.total;
    const computed = totalOf(after.expenses);
    expect(cached === undefined || Math.abs(cached - computed) < 1e-9).toBe(true);
    expect(computed).toBeCloseTo(90.5, 2);
  });
});

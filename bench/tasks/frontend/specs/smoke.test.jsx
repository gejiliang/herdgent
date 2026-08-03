// 基线应用的自检：确认 fixture 本身是好的。
// 【这套测试必须在「未经改动的 app」上全绿】——否则题面一开始就是坏的，
// 后面测出来的全是 harness 在替我们修 fixture。
//
// 引用路径按【注入后】的位置写：判分时这个文件会被复制到 app/__bench__/ 下再跑。
// 放在 app 外面跑不了 —— vitest 的 root 在 app，外部文件会被 include 规则排除掉。
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../src/App.jsx";

describe("expense tracker baseline", () => {
  it("renders the seeded expenses", () => {
    render(<App />);
    expect(screen.getAllByTestId("expense-item")).toHaveLength(4);
    expect(screen.getByTestId("summary-count").textContent).toBe("4");
    expect(screen.getByTestId("summary-total").textContent).toBe("1290.50");
  });

  it("adds an expense through the form", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByLabelText(/title/i), "Coffee");
    await user.type(screen.getByLabelText(/amount/i), "4.5");
    await user.click(screen.getByRole("button", { name: /add expense/i }));

    expect(screen.getAllByTestId("expense-item")).toHaveLength(5);
    expect(screen.getByTestId("summary-total").textContent).toBe("1295.00");
  });

  it("removes an expense and updates the summary", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: /remove rent/i }));

    expect(screen.getAllByTestId("expense-item")).toHaveLength(3);
    expect(screen.getByTestId("summary-count").textContent).toBe("3");
    expect(screen.getByTestId("summary-total").textContent).toBe("90.50");
  });
});

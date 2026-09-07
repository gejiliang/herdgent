// 分化题：按分类筛选。
// 考点是【顺着数据流找全该改的地方】—— 筛选状态要提到 App，列表要过滤，
// 而合计也必须跟着筛选走。最后这条是分水岭：只改列表不改合计，看起来功能是好的，
// 但数字对不上。预期结果在这里分叉。
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../src/App.jsx";

async function selectCategory(user, value) {
  const filter = screen.getByLabelText(/filter/i);
  await user.selectOptions(filter, value);
}

describe("category filter", () => {
  it("renders a filter control", () => {
    render(<App />);
    expect(screen.getByLabelText(/filter/i)).toBeInTheDocument();
  });

  it("shows everything by default", () => {
    render(<App />);
    expect(screen.getAllByTestId("expense-item")).toHaveLength(4);
  });

  it("filters the list down to one category", async () => {
    const user = userEvent.setup();
    render(<App />);
    await selectCategory(user, "Food");
    const items = screen.getAllByTestId("expense-item");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("Groceries");
  });

  it("the summary follows the filter", async () => {
    const user = userEvent.setup();
    render(<App />);
    await selectCategory(user, "Food");
    expect(screen.getByTestId("summary-count").textContent).toBe("1");
    expect(screen.getByTestId("summary-total").textContent).toBe("42.50");
  });

  it("going back to all restores the full list and total", async () => {
    const user = userEvent.setup();
    render(<App />);
    await selectCategory(user, "Housing");
    expect(screen.getByTestId("summary-total").textContent).toBe("1200.00");
    await selectCategory(user, "All");
    expect(screen.getAllByTestId("expense-item")).toHaveLength(4);
    expect(screen.getByTestId("summary-total").textContent).toBe("1290.50");
  });

  it("a newly added expense respects the active filter", async () => {
    const user = userEvent.setup();
    render(<App />);
    await selectCategory(user, "Food");
    await user.type(screen.getByLabelText(/title/i), "Pizza");
    await user.type(screen.getByLabelText(/amount/i), "20");
    await user.selectOptions(screen.getByLabelText(/^category$/i), "Food");
    await user.click(screen.getByRole("button", { name: /add expense/i }));

    expect(screen.getAllByTestId("expense-item")).toHaveLength(2);
    expect(screen.getByTestId("summary-total").textContent).toBe("62.50");
  });

  it("removing while filtered keeps both views consistent", async () => {
    const user = userEvent.setup();
    render(<App />);
    await selectCategory(user, "Food");
    await user.click(screen.getByRole("button", { name: /remove groceries/i }));
    expect(screen.queryAllByTestId("expense-item")).toHaveLength(0);
    expect(screen.getByTestId("summary-total").textContent).toBe("0.00");

    await selectCategory(user, "All");
    expect(screen.getAllByTestId("expense-item")).toHaveLength(3);
    expect(screen.getByTestId("summary-total").textContent).toBe("1248.00");
  });
});

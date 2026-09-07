// 基线题：给费用加「备注」字段。
// 考点是最基本的跨文件改动 —— 表单收、reducer 存、列表显示，三处都得动。
// 预期五家都能做对；在这题上失手才说明真出了问题。
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../src/App.jsx";

describe("note field", () => {
  it("the form has a note input", () => {
    render(<App />);
    expect(screen.getByLabelText(/note/i)).toBeInTheDocument();
  });

  it("a note typed into the form shows up on the new item", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByLabelText(/title/i), "Taxi");
    await user.type(screen.getByLabelText(/amount/i), "25");
    await user.type(screen.getByLabelText(/note/i), "airport run");
    await user.click(screen.getByRole("button", { name: /add expense/i }));

    const items = screen.getAllByTestId("expense-item");
    const added = items[items.length - 1];
    expect(added).toHaveTextContent("airport run");
  });

  it("the note is exposed as its own field, not glued into the title", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByLabelText(/title/i), "Taxi");
    await user.type(screen.getByLabelText(/amount/i), "25");
    await user.type(screen.getByLabelText(/note/i), "airport run");
    await user.click(screen.getByRole("button", { name: /add expense/i }));

    const items = screen.getAllByTestId("expense-item");
    const added = items[items.length - 1];
    expect(added.querySelector('[data-testid="expense-note"]')).toHaveTextContent("airport run");
    expect(added.querySelector('[data-testid="expense-title"]')).toHaveTextContent("Taxi");
    expect(added.querySelector('[data-testid="expense-title"]')).not.toHaveTextContent("airport run");
  });

  it("an expense added without a note still works", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByLabelText(/title/i), "Water");
    await user.type(screen.getByLabelText(/amount/i), "3");
    await user.click(screen.getByRole("button", { name: /add expense/i }));

    expect(screen.getAllByTestId("expense-item")).toHaveLength(5);
    expect(screen.getByTestId("summary-total").textContent).toBe("1293.50");
  });

  it("existing behaviour is untouched", async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(screen.getAllByTestId("expense-item")).toHaveLength(4);
    expect(screen.getByTestId("summary-total").textContent).toBe("1290.50");
    await user.click(screen.getByRole("button", { name: /remove rent/i }));
    expect(screen.getByTestId("summary-total").textContent).toBe("90.50");
  });
});

import { describe, expect, it } from "vite-plus/test";
import { MAX_CELL_CHARS, MAX_RESULT_CHARS } from "../src/core/limits.ts";
import { fitRows, toCell, type CellBudget } from "../src/core/values.ts";

/** A cell and whether building it cut anything. */
function cell(value: unknown): { cell: unknown; cut: boolean } {
  const budget: CellBudget = { cut: false };
  return { cell: toCell(value, budget), cut: budget.cut };
}

describe("toCell", () => {
  it("keeps plain JSON values", () => {
    expect(cell("x")).toEqual({ cell: "x", cut: false });
    expect(cell(1.5)).toEqual({ cell: 1.5, cut: false });
    expect(cell(true).cell).toBe(true);
    expect(cell(null).cell).toBeNull();
    expect(cell(undefined).cell).toBeNull();
    expect(cell({ a: [1, "b"] }).cell).toEqual({ a: [1, "b"] });
  });

  it("turns a bigint into a number only while it stays exact", () => {
    expect(cell(2n).cell).toBe(2);
    expect(cell(9_007_199_254_740_993n).cell).toBe("9007199254740993");
    expect(cell(-9_007_199_254_740_993n).cell).toBe("-9007199254740993");
  });

  it("writes NaN, infinities and dates as text", () => {
    expect(cell(Number.NaN).cell).toBe("NaN");
    expect(cell(Number.POSITIVE_INFINITY).cell).toBe("Infinity");
    expect(cell(new Date("2026-01-02T03:04:05Z")).cell).toBe("2026-01-02T03:04:05.000Z");
  });

  it("shows bytes as hex with the full size", () => {
    expect(cell(new Uint8Array([0, 255]))).toEqual({
      cell: { $blob: "00ff", bytes: 2 },
      cut: false,
    });
    const big = cell(new Uint8Array(40).fill(1));
    expect(big.cell).toEqual({ $blob: "01".repeat(32), bytes: 40, cut: true });
    expect(big.cut).toBe(true);
  });

  it("cuts long text without splitting a surrogate pair", () => {
    const text = `${"a".repeat(MAX_CELL_CHARS - 1)}😀tail`;
    const { cell: value, cut } = cell(text);
    expect(cut).toBe(true);
    expect(value).toBe(`${"a".repeat(MAX_CELL_CHARS - 1)}… [+6 chars]`);
  });

  it("stops at a deep or wide structure", () => {
    let deep: unknown = 1;
    for (let index = 0; index < 20; index += 1) deep = [deep];
    expect(JSON.stringify(cell(deep).cell)).toContain("[nested too deep]");
    expect((cell(Array.from({ length: 150 }, (_, index) => index)).cell as unknown[]).length).toBe(
      100,
    );
  });
});

describe("fitRows", () => {
  it("drops rows past the size cap but keeps at least one", () => {
    const budget: CellBudget = { cut: false };
    const row = ["x".repeat(MAX_RESULT_CHARS / 4)];
    expect(fitRows([row, row, row, row, row, row], budget).length).toBeLessThan(6);
    expect(budget.cut).toBe(true);

    const one: CellBudget = { cut: false };
    expect(fitRows([["y".repeat(MAX_RESULT_CHARS * 2)]], one)).toHaveLength(1);
    expect(one.cut).toBe(false);
  });
});

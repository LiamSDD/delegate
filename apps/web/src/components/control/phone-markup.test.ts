import { describe, expect, it } from "vitest";

import { phoneWidthProblems } from "./phone-markup";

const TOKEN = "unbreakable".repeat(6);

describe("the phone-width markup check", () => {
  it("accepts ordinary wrapped text and short tokens", () => {
    expect(
      phoneWidthProblems(
        '<div class="flex flex-col"><p class="text-sm">Plain words wrap on their own.</p><span class="whitespace-nowrap">short-token</span></div>',
      ),
    ).toEqual([]);
  });

  it("flags a long token with nothing to break or contain it", () => {
    expect(phoneWidthProblems(`<p class="font-mono">${TOKEN}</p>`)).toEqual([
      expect.stringContaining("has no break-all, break-words or scroll container"),
    ]);
  });

  it("accepts a long token under break-all, inside a scroller or visually hidden", () => {
    expect(phoneWidthProblems(`<div class="flex"><p class="break-all">${TOKEN}</p></div>`)).toEqual(
      [],
    );
    expect(phoneWidthProblems(`<div class="overflow-x-auto"><p>${TOKEN}</p></div>`)).toEqual([]);
    expect(phoneWidthProblems(`<span class="sr-only">${TOKEN}</span>`)).toEqual([]);
  });

  it("flags break-words inside a flex row or a grid without columns unless the item can shrink", () => {
    const row = (item: string) =>
      `<div class="flex flex-wrap"><p class="${item} break-words">${TOKEN}</p></div>`;
    expect(phoneWidthProblems(row("text-sm"))).toEqual([
      expect.stringContaining("is a flex or grid item without min-w-0"),
    ]);
    expect(phoneWidthProblems(row("min-w-0"))).toEqual([]);
    expect(
      phoneWidthProblems(`<div class="grid gap-2"><p class="break-words">${TOKEN}</p></div>`),
    ).toHaveLength(1);
    expect(
      phoneWidthProblems(
        `<div class="grid grid-cols-2"><p class="break-words">${TOKEN}</p></div><div class="flex flex-col"><p class="break-words">${TOKEN}</p></div>`,
      ),
    ).toEqual([]);
  });

  it("flags a shrinkable item whose own flex-row ancestor cannot shrink", () => {
    expect(
      phoneWidthProblems(
        `<div class="flex"><div class="flex flex-col"><p class="min-w-0 break-words">${TOKEN}</p></div></div>`,
      ),
    ).toHaveLength(1);
  });

  it("flags tables and preformatted text that cannot scroll, and fixed widths wider than a phone", () => {
    expect(phoneWidthProblems("<table><tbody><tr><td>1</td></tr></tbody></table>")).toHaveLength(1);
    expect(
      phoneWidthProblems('<div class="overflow-x-auto"><table><tbody></tbody></table></div>'),
    ).toEqual([]);
    expect(phoneWidthProblems('<pre class="whitespace-pre-wrap">{}</pre>')).toHaveLength(1);
    expect(phoneWidthProblems('<pre class="overflow-auto">{}</pre>')).toEqual([]);
    expect(phoneWidthProblems('<div class="w-96"></div>')).toHaveLength(1);
    expect(phoneWidthProblems('<div class="min-w-[24rem]"></div>')).toHaveLength(1);
    expect(phoneWidthProblems('<div class="grid grid-cols-[14rem_minmax(0,1fr)]"></div>')).toEqual(
      [],
    );
    expect(phoneWidthProblems('<div class="grid grid-cols-[14rem_8rem]"></div>')).toHaveLength(1);
    expect(phoneWidthProblems('<ul class="w-max"></ul>')).toHaveLength(1);
    expect(phoneWidthProblems('<div class="w-72 sm:w-96 max-w-3xl"></div>')).toEqual([]);
  });
});

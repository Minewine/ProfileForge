import { describe, expect, it } from "vitest";
import { normalizeDate } from "@/lib/dates/normalize";

describe("date normalization (EN/FR → YYYY-MM, never guessed)", () => {
  const cases: Array<[string | null | undefined, string | null, string | null, "en" | "fr"]> = [
    // [input, expected value, expected flag, language]
    ["Jan 2021", "2021-01", null, "en"],
    ["March 2023", "2023-03", null, "en"],
    ["sept. 2021", "2021-09", null, "fr"],
    ["janv. 2021", "2021-01", null, "fr"],
    ["août 2020", "2020-08", null, "fr"],
    ["04/2023", "2023-04", null, "en"],
    ["2023-01", "2023-01", null, "en"],
    ["2021", "2021-01", "ambiguous_date", "en"], // year-only: January assumed, flagged
    ["23/04/2020", "2020-04", null, "en"], // day > 12 ⇒ unambiguous
    ["04/23/2020", "2020-04", null, "en"], // en hint: MM/DD/YYYY
    ["23/04/2020", "2020-04", null, "fr"], // fr hint: DD/MM/YYYY
    ["04/05/2020", null, "ambiguous_date", "en"], // both ≤ 12 ⇒ genuinely ambiguous, flagged
    ["depuis sept. 2023", "2023-09", null, "fr"],
    ["Since 2020", "2020-01", "ambiguous_date", "en"],
    [null, null, null, "en"],
    ["", null, null, "en"],
    ["spring 2021 maybe", null, "ambiguous_date", "en"], // unparseable ⇒ null + flag, never a guess
  ];

  for (const [input, value, flag, lang] of cases) {
    it(`${JSON.stringify(input)} (${lang}) → ${value ?? "null"}${flag ? ` [${flag}]` : ""}`, () => {
      const result = normalizeDate(input, lang);
      expect(result.value).toBe(value);
      expect(result.flag).toBe(flag);
    });
  }

  it("maps present-equivalents in both languages", () => {
    for (const raw of ["present", "Present", "présent", "aujourd'hui", "Aujourd'hui", "current"]) {
      expect(normalizeDate(raw, "fr").value).toBe("present");
    }
  });
});

import { describe, expect, it } from "vitest";
import { checkGrounding } from "@/lib/generation/grounding";

const SRC = [
  "Built the data ingestion platform serving 200M events per day at Dassault Systèmes (2019-2023)",
  "Led a team of 5 engineers using AWS and Kubernetes",
];

describe("checkGrounding", () => {
  it("accepts grounded rewording — synonyms, reordering, new phrasing", () => {
    expect(
      checkGrounding("Spearheaded the data ingestion platform handling 200M events/day at Dassault Systèmes", SRC),
    ).toEqual([]);
  });

  it("accepts case and accent differences (same normalization as ingestion)", () => {
    expect(checkGrounding("Led équipe of 5 engineers using AWS and KUBERNETES", [
      "Led une équipe de 5 ingenieurs using AWS and Kubernetes",
    ])).toEqual([]);
  });

  it("flags an invented number", () => {
    expect(checkGrounding("Built the platform serving 300M events per day", SRC)).toContainEqual({
      kind: "number",
      token: "300M",
    });
  });

  it("flags an invented all-caps acronym, even at sentence start", () => {
    expect(checkGrounding("Migrated the stack to GCP", SRC)).toContainEqual({ kind: "acronym", token: "GCP" });
  });

  it("does not flag translated capitalized phrases (feature 005 title rewrites, fields of study)", () => {
    // regression: a dictionary-less entity rule cannot separate legit
    // cross-language rewrites from invented names — capitalized phrases are
    // exempt by design
    expect(checkGrounding("BSc · Computer Science · Université de Montréal", [
      "BSc · Informatique · Université de Montréal",
    ])).toEqual([]);
    expect(checkGrounding("Platform Engineer at a global firm", ["Ingénieur Plateforme"])).toEqual([]);
  });

  it("flags an invented date", () => {
    const violations = checkGrounding("Built the platform from 2019 to 2024", SRC);
    expect(violations.some((v) => v.kind === "number" && v.token === "2024")).toBe(true);
  });

  it("does not flag sentence-opening words or re-titled grounded phrases", () => {
    expect(checkGrounding("Built the Data Platform serving 200M events per day", SRC)).toEqual([]);
  });

  it("does not flag single capitalized words (cross-language / German safety)", () => {
    expect(checkGrounding("Led the Platform team of 5 engineers", SRC)).toEqual([]);
  });

  it("grounds multiplier suffixes via their digit run (1.5x vs source 1.5)", () => {
    expect(checkGrounding("Reduced latency 1.5 times", ["reduced latency by a factor of 1.5"])).toEqual([]);
  });

  it("does not flag word-form numbers or sentence-initial entities alone", () => {
    expect(checkGrounding("Five years of experience", [])).toEqual([]);
  });

  it("accepts empty text; flags against empty sources", () => {
    expect(checkGrounding("", [])).toEqual([]);
    expect(checkGrounding("Built 5 things", [])).toContainEqual({ kind: "number", token: "5" });
  });
});

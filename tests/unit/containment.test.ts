import { describe, expect, it } from "vitest";
import { checkContainment, normalizeForContainment } from "@/lib/validation/sourceContainment";

const SOURCE = `Senior Backend Engineer — Northwind Systems
Led migration of monolith to event-driven services, cutting latency by 40%.
Managed a team of 5 engineers across two time zones.`;

describe("source containment (zero-invention at ingestion)", () => {
  it("normalizes case, accents, and punctuation away", () => {
    expect(normalizeForContainment("Expérience— Professionnelle!")).toEqual(
      normalizeForContainment("experience professionnelle"),
    );
  });

  it("accepts faithful bullets (≥95% token recovery)", () => {
    const r = checkContainment(
      "Led migration of monolith to event-driven services, cutting latency by 40%.",
      SOURCE,
    );
    expect(r.ratio).toBeGreaterThanOrEqual(0.95);
    expect(r.ok).toBe(true);
  });

  it("catches an invented bullet the LLM never saw in the source", () => {
    const r = checkContainment(
      "Scaled infrastructure to 10,000 servers and won the 2023 company award.",
      SOURCE,
    );
    expect(r.ok).toBe(false);
    expect(r.ratio).toBeLessThan(0.95);
  });

  it("tolerates harmless reordering and accent drift, not number changes", () => {
    expect(checkContainment("cutting latency by 40%, migration of monolith", SOURCE).ok).toBe(true);
    expect(checkContainment("cutting latency by 60%", SOURCE).ok).toBe(false);
  });

  it("empty claims pass vacuously", () => {
    expect(checkContainment("", SOURCE).ok).toBe(true);
  });
});

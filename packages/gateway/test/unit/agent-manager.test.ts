import { describe, expect, it } from "vitest";
import { semverSatisfies } from "../../src/agent-manager.js";

describe("semverSatisfies", () => {
  it("returns true when version equals minimum", () => {
    expect(semverSatisfies("0.1.0", "0.1.0")).toBe(true);
  });

  it("returns true when version exceeds minimum by patch", () => {
    expect(semverSatisfies("0.1.1", "0.1.0")).toBe(true);
  });

  it("returns true when version exceeds minimum by minor", () => {
    expect(semverSatisfies("0.2.0", "0.1.0")).toBe(true);
  });

  it("returns true when version exceeds minimum by major", () => {
    expect(semverSatisfies("1.0.0", "0.1.0")).toBe(true);
  });

  it("returns false when version is below minimum by patch", () => {
    expect(semverSatisfies("0.1.0", "0.1.1")).toBe(false);
  });

  it("returns false when version is below minimum by minor", () => {
    expect(semverSatisfies("0.1.0", "0.2.0")).toBe(false);
  });

  it("returns false when version is below minimum by major", () => {
    expect(semverSatisfies("0.1.0", "1.0.0")).toBe(false);
  });

  it("returns false for non-numeric version components (NaN guard)", () => {
    expect(semverSatisfies("invalid", "0.1.0")).toBe(false);
    expect(semverSatisfies("1.x.0", "0.1.0")).toBe(false);
  });

  it("handles pre-release suffix by ignoring it", () => {
    expect(semverSatisfies("1.0.0-beta", "0.1.0")).toBe(true);
    expect(semverSatisfies("0.1.0-rc.1", "0.1.0")).toBe(true);
  });

  it("returns false when pre-release version is below minimum", () => {
    expect(semverSatisfies("0.0.9-rc", "0.1.0")).toBe(false);
  });
});

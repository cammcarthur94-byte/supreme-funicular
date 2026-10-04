import { describe, it, expect } from "vitest";
import { validateDrawInput } from "../app/validation/drawValidation";

describe("Draw Validation (validateDrawInput)", () => {
  const futureBase = Date.now() + 24 * 60 * 60 * 1000;
  const validPayload = {
    title: "Exclusive Sneaker Drop",
    publicRulesText: "One entry per customer. Must be 18+.",
    entryOpensAt: new Date(futureBase).toISOString(),
    entryClosesAt: new Date(futureBase + 2 * 60 * 60 * 1000).toISOString(),
    drawAt: new Date(futureBase + 3 * 60 * 60 * 1000).toISOString(),
    claimWindowMinutes: 30,
    unitsAvailable: 2,
    purgeAfterDays: 14,
    variants: [
      {
        productGid: "gid://shopify/Product/100",
        variantGid: "gid://shopify/ProductVariant/200",
        productTitle: "Sneaker Model X",
        variantTitle: "Size 10",
        msrpPrice: 199.99,
        quantity: 2,
      },
    ],
    rules: {
      requireAccount: true,
      requireVerifiedEmail: true,
      allowedCountries: ["CA", "US"],
      minAccountAgeDays: 7,
      requirePhone: false,
    },
  };

  it("passes validation with valid payload", () => {
    const result = validateDrawInput(validPayload, { isNew: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe("Exclusive Sneaker Drop");
      expect(result.data.unitsAvailable).toBe(2);
      expect(result.data.rules.allowedCountries).toEqual(["CA", "US"]);
    }
  });

  it("fails if entryOpensAt is equal to or after entryClosesAt", () => {
    const invalid = {
      ...validPayload,
      entryOpensAt: validPayload.entryClosesAt,
    };
    const result = validateDrawInput(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.entryOpensAt).toBeDefined();
    }
  });

  it("fails if drawAt is before entryClosesAt", () => {
    const invalid = {
      ...validPayload,
      drawAt: new Date(futureBase + 1 * 60 * 60 * 1000).toISOString(), // 1hr after open, but close is 2hr after
    };
    const result = validateDrawInput(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.drawAt).toBeDefined();
    }
  });

  it("fails if claimWindowMinutes is less than 5", () => {
    const invalid = {
      ...validPayload,
      claimWindowMinutes: 4,
    };
    const result = validateDrawInput(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.claimWindowMinutes).toBeDefined();
    }
  });

  it("fails if total units available does not equal sum of variant quantities", () => {
    const invalid = {
      ...validPayload,
      unitsAvailable: 5, // variants sum is 2
    };
    const result = validateDrawInput(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.unitsAvailable).toBeDefined();
    }
  });

  it("fails if no variants are provided", () => {
    const invalid = {
      ...validPayload,
      unitsAvailable: 0,
      variants: [],
    };
    const result = validateDrawInput(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.variants).toBeDefined();
    }
  });

  it("fails if variant MSRP price is zero or negative", () => {
    const invalid = {
      ...validPayload,
      variants: [
        {
          ...validPayload.variants[0],
          msrpPrice: 0,
        },
      ],
    };
    const result = validateDrawInput(invalid);
    expect(result.success).toBe(false);
  });

  it("fails if isNew is true and entryClosesAt is in the past", () => {
    const past = Date.now() - 24 * 60 * 60 * 1000;
    const invalid = {
      ...validPayload,
      entryOpensAt: new Date(past - 2 * 60 * 60 * 1000).toISOString(),
      entryClosesAt: new Date(past).toISOString(),
      drawAt: new Date(past + 10 * 60 * 1000).toISOString(),
    };
    const result = validateDrawInput(invalid, { isNew: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.entryClosesAt).toBeDefined();
    }
  });
});

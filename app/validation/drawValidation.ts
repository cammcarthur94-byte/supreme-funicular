import { z } from "zod";

export const drawVariantInputSchema = z.object({
  productGid: z.string().min(1, "Product ID is required"),
  variantGid: z.string().min(1, "Variant ID is required"),
  productTitle: z.string().optional(),
  variantTitle: z.string().optional(),
  msrpPrice: z.coerce.number().positive("MSRP price must be greater than zero"),
  quantity: z.coerce.number().int().min(1, "Quantity must be at least 1"),
});

export const eligibilityRulesSchema = z.object({
  requireAccount: z.boolean().default(true),
  requireVerifiedEmail: z.boolean().default(true),
  allowedCountries: z.array(z.string().length(2)).default([]),
  minAccountAgeDays: z.coerce.number().int().min(0).default(0),
  requirePhone: z.boolean().default(false),
});

export const drawFormSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, "Draw title is required")
      .max(200, "Draw title must be at most 200 characters"),
    publicRulesText: z.string().trim().optional().nullable(),
    entryOpensAt: z.string().datetime({ message: "Invalid entry open datetime" }),
    entryClosesAt: z.string().datetime({ message: "Invalid entry close datetime" }),
    drawAt: z.string().datetime({ message: "Invalid draw datetime" }),
    claimWindowMinutes: z.coerce
      .number()
      .int()
      .min(5, "Claim window must be at least 5 minutes"),
    unitsAvailable: z.coerce
      .number()
      .int()
      .min(1, "Units available must be at least 1"),
    purgeAfterDays: z.coerce
      .number()
      .int()
      .min(1, "Purge grace period must be at least 1 day")
      .max(90, "Purge grace period cannot exceed 90 days")
      .default(14),
    variants: z
      .array(drawVariantInputSchema)
      .min(1, "At least one product variant must be selected"),
    rules: eligibilityRulesSchema.default({
      requireAccount: true,
      requireVerifiedEmail: true,
      allowedCountries: [],
      minAccountAgeDays: 0,
      requirePhone: false,
    }),
  })
  .refine(
    (data) => new Date(data.entryOpensAt) < new Date(data.entryClosesAt),
    {
      message: "Entry open time must be earlier than entry close time",
      path: ["entryOpensAt"],
    }
  )
  .refine(
    (data) => new Date(data.entryClosesAt) <= new Date(data.drawAt),
    {
      message: "Draw time must be at or after entry close time",
      path: ["drawAt"],
    }
  )
  .refine(
    (data) => {
      const sum = data.variants.reduce((acc, v) => acc + v.quantity, 0);
      return sum === data.unitsAvailable;
    },
    {
      message: "Total units available must match the sum of variant quantities",
      path: ["unitsAvailable"],
    }
  );

export type DrawFormData = z.infer<typeof drawFormSchema>;
export type DrawVariantInput = z.infer<typeof drawVariantInputSchema>;
export type EligibilityRules = z.infer<typeof eligibilityRulesSchema>;

/**
 * Validates draw form input, optionally enforcing that scheduled dates are in the future for new draws.
 */
export function validateDrawInput(
  rawInput: unknown,
  options: { isNew?: boolean } = {}
) {
  const parsed = drawFormSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { success: false as const, errors: parsed.error.flatten().fieldErrors };
  }

  const data = parsed.data;

  if (options.isNew) {
    const now = new Date();
    // Allow small 1-minute buffer for clock drift during form completion
    const buffer = 60 * 1000;
    if (new Date(data.entryClosesAt).getTime() <= now.getTime() - buffer) {
      return {
        success: false as const,
        errors: {
          entryClosesAt: ["Entry close time must be in the future"],
        },
      };
    }
  }

  return { success: true as const, data };
}

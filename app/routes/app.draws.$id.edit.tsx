import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import {
  Page,
  Layout,
  Card,
  FormLayout,
  TextField,
  Button,
  Banner,
  Text,
  BlockStack,
  InlineStack,
  Checkbox,
  Select,
  Divider,
  ButtonGroup,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma, { forShop } from "../db.server";
import { validateDrawInput } from "../validation/drawValidation";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const drawId = params.id as string;

  const shop = await prisma.shop.findUniqueOrThrow({
    where: { shopDomain: session.shop },
  });

  const draw = await forShop(shop.id).draw.findFirst({
    where: { id: drawId },
    include: { variants: true },
  });

  if (!draw) {
    throw new Response("Draw not found", { status: 404 });
  }

  // Safety Lock: only SCHEDULED draws can be edited
  if (draw.status !== "SCHEDULED") {
    return redirect(`/app/draws/${draw.id}`);
  }

  return {
    draw,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const drawId = params.id as string;

  const shop = await prisma.shop.findUniqueOrThrow({
    where: { shopDomain: session.shop },
  });

  const tenant = forShop(shop.id);
  const existingDraw = await tenant.draw.findFirst({
    where: { id: drawId },
  });

  if (!existingDraw) {
    return Response.json({ errors: { general: ["Draw not found"] } }, { status: 404 });
  }

  if (existingDraw.status !== "SCHEDULED") {
    return Response.json(
      { errors: { general: [`Cannot edit draw in '${existingDraw.status}' status. Editing is locked once a drop opens.`] } },
      { status: 400 }
    );
  }

  const formData = await request.formData();
  const rawPayload = formData.get("payload");

  if (!rawPayload || typeof rawPayload !== "string") {
    return Response.json({ errors: { general: ["Invalid form submission"] } }, { status: 400 });
  }

  let parsedJson;
  try {
    parsedJson = JSON.parse(rawPayload);
  } catch {
    return Response.json({ errors: { general: ["Malformed JSON payload"] } }, { status: 400 });
  }

  const validation = validateDrawInput(parsedJson, { isNew: false });
  if (!validation.success) {
    return Response.json({ errors: validation.errors }, { status: 400 });
  }

  const { title, publicRulesText, entryOpensAt, entryClosesAt, drawAt, claimWindowMinutes, unitsAvailable, purgeAfterDays, variants, rules } = validation.data;

  await prisma.$transaction(async (tx) => {
    await tx.drawVariant.deleteMany({
      where: { drawId: existingDraw.id },
    });

    await tx.draw.update({
      where: { id: existingDraw.id, shopId: shop.id },
      data: {
        title,
        publicRulesText: publicRulesText || null,
        entryOpensAt: new Date(entryOpensAt),
        entryClosesAt: new Date(entryClosesAt),
        drawAt: new Date(drawAt),
        claimWindowMinutes,
        unitsAvailable,
        purgeAfterDays,
        rules: rules as unknown as import("@prisma/client").Prisma.InputJsonValue,
        variants: {
          create: variants.map((v) => ({
            shopId: shop.id,
            productGid: v.productGid,
            variantGid: v.variantGid,
            msrpPrice: v.msrpPrice,
            quantity: v.quantity,
          })),
        },
      },
    });

    await tx.auditLog.create({
      data: {
        shopId: shop.id,
        drawId: existingDraw.id,
        eventType: "DRAW_UPDATED",
        actor: session.shop,
        metadata: {
          title,
          unitsAvailable,
        },
      },
    });
  });

  return redirect(`/app/draws/${existingDraw.id}`);
};

interface EditVariantItem {
  productGid: string;
  variantGid: string;
  productTitle: string;
  variantTitle: string;
  msrpPrice: number;
  quantity: number;
}

export default function EditDraw() {
  const { draw } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const actionData = useActionData<{ errors?: Record<string, string[]> }>();
  const isSubmitting = navigation.state === "submitting";

  const rawRules = (draw.rules as Record<string, unknown>) || {};

  const [title, setTitle] = useState(draw.title);
  const [publicRulesText, setPublicRulesText] = useState(draw.publicRulesText || "");
  const [entryOpensAt, setEntryOpensAt] = useState(new Date(draw.entryOpensAt).toISOString().slice(0, 16));
  const [entryClosesAt, setEntryClosesAt] = useState(new Date(draw.entryClosesAt).toISOString().slice(0, 16));
  const [drawAt, setDrawAt] = useState(new Date(draw.drawAt).toISOString().slice(0, 16));
  const [claimWindowValue, setClaimWindowValue] = useState(String(draw.claimWindowMinutes));
  const [claimWindowUnit, setClaimWindowUnit] = useState<"minutes" | "hours">("minutes");
  const [purgeAfterDays, setPurgeAfterDays] = useState(String(draw.purgeAfterDays));

  // Eligibility rules state
  const [requireAccount, setRequireAccount] = useState(Boolean(rawRules.requireAccount ?? true));
  const [requireVerifiedEmail, setRequireVerifiedEmail] = useState(Boolean(rawRules.requireVerifiedEmail ?? true));
  const [minAccountAgeDays, setMinAccountAgeDays] = useState(String(rawRules.minAccountAgeDays ?? 0));
  const [requirePhone, setRequirePhone] = useState(Boolean(rawRules.requirePhone ?? false));
  const [allowedCountries, setAllowedCountries] = useState<string[]>(
    Array.isArray(rawRules.allowedCountries) ? (rawRules.allowedCountries as string[]) : ["CA", "US"]
  );

  // Variants state
  const [variants, setVariants] = useState<EditVariantItem[]>(
    draw.variants.map((v: { productGid: string; variantGid: string; msrpPrice: unknown; quantity: number }) => ({
      productGid: v.productGid,
      variantGid: v.variantGid,
      productTitle: "Raffle Product",
      variantTitle: `Variant ${v.variantGid.slice(-6)}`,
      msrpPrice: Number(v.msrpPrice),
      quantity: v.quantity,
    }))
  );

  const handleQuantityChange = (variantGid: string, newQty: string) => {
    const qty = parseInt(newQty, 10) || 1;
    setVariants((prev: EditVariantItem[]) =>
      prev.map((v: EditVariantItem) => (v.variantGid === variantGid ? { ...v, quantity: Math.max(1, qty) } : v))
    );
  };

  const totalUnits = variants.reduce((sum: number, v: EditVariantItem) => sum + v.quantity, 0);

  const handleSubmit = () => {
    const claimMinutes =
      claimWindowUnit === "hours"
        ? parseInt(claimWindowValue, 10) * 60
        : parseInt(claimWindowValue, 10);

    const payload = {
      title,
      publicRulesText,
      entryOpensAt: new Date(entryOpensAt).toISOString(),
      entryClosesAt: new Date(entryClosesAt).toISOString(),
      drawAt: new Date(drawAt).toISOString(),
      claimWindowMinutes: claimMinutes,
      unitsAvailable: totalUnits,
      purgeAfterDays: parseInt(purgeAfterDays, 10) || 14,
      variants,
      rules: {
        requireAccount,
        requireVerifiedEmail,
        allowedCountries,
        minAccountAgeDays: parseInt(minAccountAgeDays, 10) || 0,
        requirePhone,
      },
    };

    submit({ payload: JSON.stringify(payload) }, { method: "POST" });
  };

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const errors = actionData?.errors;

  return (
    <Page
      title={`Edit Draw: ${draw.title}`}
      backAction={{ content: "Draw Details", url: `/app/draws/${draw.id}` }}
      primaryAction={{
        content: "Save Changes",
        onAction: handleSubmit,
        loading: isSubmitting,
      }}
    >
      <Layout>
        {errors && (
          <Layout.Section>
            <Banner title="Please correct the following errors" tone="critical">
              <BlockStack gap="100">
                {Object.entries(errors).map(([field, errList]) => (
                  <Text key={field} as="p" tone="critical">
                    • {Array.isArray(errList) ? errList.join(", ") : String(errList)}
                  </Text>
                ))}
              </BlockStack>
            </Banner>
          </Layout.Section>
        )}

        <Layout.AnnotatedSection
          title="Product Variants"
          description="Adjust allocated unit quantities for this draw."
        >
          <Card>
            <BlockStack gap="400">
              <Text variant="headingSm" as="h4">
                Configured Variants (Total Units: {totalUnits})
              </Text>
              {variants.map((v) => (
                <InlineStack key={v.variantGid} align="space-between" blockAlign="center">
                  <BlockStack gap="050">
                    <Text variant="bodyMd" fontWeight="semibold" as="span">
                      {v.variantTitle}
                    </Text>
                    <Text variant="bodySm" tone="subdued" as="span">
                      MSRP: ${v.msrpPrice.toFixed(2)}
                    </Text>
                  </BlockStack>
                  <div style={{ width: "120px" }}>
                    <TextField
                      label="Units"
                      type="number"
                      value={String(v.quantity)}
                      onChange={(val) => handleQuantityChange(v.variantGid, val)}
                      autoComplete="off"
                      min={1}
                    />
                  </div>
                </InlineStack>
              ))}
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        <Layout.AnnotatedSection
          title="Schedule & Settings"
          description={`Update draw timing and eligibility rules. Active timezone: ${timezone}.`}
        >
          <Card>
            <FormLayout>
              <TextField
                label="Draw Title"
                value={title}
                onChange={setTitle}
                autoComplete="off"
                error={errors?.title?.[0]}
              />

              <TextField
                label="Public Rules & Terms"
                value={publicRulesText}
                onChange={setPublicRulesText}
                multiline={3}
                autoComplete="off"
              />

              <Divider />

              <FormLayout.Group>
                <TextField
                  label="Entry Opens At"
                  type="datetime-local"
                  value={entryOpensAt}
                  onChange={setEntryOpensAt}
                  autoComplete="off"
                  error={errors?.entryOpensAt?.[0]}
                />
                <TextField
                  label="Entry Closes At"
                  type="datetime-local"
                  value={entryClosesAt}
                  onChange={setEntryClosesAt}
                  autoComplete="off"
                  error={errors?.entryClosesAt?.[0]}
                />
              </FormLayout.Group>

              <FormLayout.Group>
                <TextField
                  label="Draw Execution Time"
                  type="datetime-local"
                  value={drawAt}
                  onChange={setDrawAt}
                  autoComplete="off"
                  error={errors?.drawAt?.[0]}
                />
                <InlineStack gap="200" blockAlign="end">
                  <div style={{ flex: 1 }}>
                    <TextField
                      label="Claim Window"
                      type="number"
                      value={claimWindowValue}
                      onChange={setClaimWindowValue}
                      autoComplete="off"
                      min={5}
                      error={errors?.claimWindowMinutes?.[0]}
                    />
                  </div>
                  <div style={{ width: "120px" }}>
                    <Select
                      label="Unit"
                      options={[
                        { label: "Minutes", value: "minutes" },
                        { label: "Hours", value: "hours" },
                      ]}
                      value={claimWindowUnit}
                      onChange={(val) => setClaimWindowUnit(val as "minutes" | "hours")}
                    />
                  </div>
                </InlineStack>
              </FormLayout.Group>
            </FormLayout>
          </Card>
        </Layout.AnnotatedSection>

        <Layout.AnnotatedSection
          title="Eligibility Criteria"
          description="Adjust requirements needed to submit a valid entry."
        >
          <Card>
            <BlockStack gap="400">
              <Checkbox
                label="Require customer account"
                checked={requireAccount}
                onChange={setRequireAccount}
              />
              <Checkbox
                label="Require verified email address"
                checked={requireVerifiedEmail}
                onChange={setRequireVerifiedEmail}
              />
              <Checkbox
                label="Require phone number on account"
                checked={requirePhone}
                onChange={setRequirePhone}
              />
              <TextField
                label="Minimum account age (days)"
                type="number"
                value={minAccountAgeDays}
                onChange={setMinAccountAgeDays}
                autoComplete="off"
                min={0}
              />

              <Divider />

              <BlockStack gap="200">
                <Text variant="headingSm" as="h4">
                  Region Lock
                </Text>
                <ButtonGroup variant="segmented">
                  <Button
                    pressed={allowedCountries.length === 1 && allowedCountries[0] === "CA"}
                    onClick={() => setAllowedCountries(["CA"])}
                  >
                    Canada only
                  </Button>
                  <Button
                    pressed={allowedCountries.length === 1 && allowedCountries[0] === "US"}
                    onClick={() => setAllowedCountries(["US"])}
                  >
                    USA only
                  </Button>
                  <Button
                    pressed={
                      allowedCountries.length === 2 &&
                      allowedCountries.includes("CA") &&
                      allowedCountries.includes("US")
                    }
                    onClick={() => setAllowedCountries(["CA", "US"])}
                  >
                    US & Canada
                  </Button>
                  <Button
                    pressed={allowedCountries.length === 0}
                    onClick={() => setAllowedCountries([])}
                  >
                    Worldwide
                  </Button>
                </ButtonGroup>
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        <Layout.AnnotatedSection
          title="Privacy & Data Retention"
          description="In compliance with data minimization, all entrant PII is permanently purged after drop completion."
        >
          <Card>
            <TextField
              label="Grace period before permanent PII purge (days)"
              type="number"
              value={purgeAfterDays}
              onChange={setPurgeAfterDays}
              autoComplete="off"
              helpText="After all units are sold or waitlist is exhausted, all Entry PII is crypto-shredded after this number of days."
              min={1}
              max={90}
            />
          </Card>
        </Layout.AnnotatedSection>
      </Layout>
    </Page>
  );
}

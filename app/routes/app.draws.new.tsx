import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, useActionData, useNavigation, useSubmit } from "react-router";
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
  Thumbnail,
  ButtonGroup,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { validateDrawInput } from "../validation/drawValidation";
import { generateDrawKey } from "../services/encryption";
import { unpublishProductFromAllChannels } from "../services/productVisibility.server";
import { scheduleVisibilityGuardCheck } from "../services/qstash.server";
import { scheduleDrawLifecycle } from "../services/drawLifecycle.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUniqueOrThrow({
    where: { shopDomain: session.shop },
  });

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

  const validation = validateDrawInput(parsedJson, { isNew: true });
  if (!validation.success) {
    return Response.json({ errors: validation.errors }, { status: 400 });
  }

  const { title, publicRulesText, entryOpensAt, entryClosesAt, drawAt, claimWindowMinutes, unitsAvailable, purgeAfterDays, variants, rules } = validation.data;

  // Generate per-draw crypto-shredding key
  const { encryptedKey } = generateDrawKey();

  const draw = await prisma.$transaction(async (tx) => {
    const createdDraw = await tx.draw.create({
      data: {
        shopId: shop.id,
        title,
        publicRulesText: publicRulesText || null,
        status: "SCHEDULED",
        entryOpensAt: new Date(entryOpensAt),
        entryClosesAt: new Date(entryClosesAt),
        drawAt: new Date(drawAt),
        claimWindowMinutes,
        unitsAvailable,
        purgeAfterDays,
        encryptionKeyId: encryptedKey,
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
        drawId: createdDraw.id,
        eventType: "DRAW_CREATED",
        actor: session.shop,
        metadata: {
          title: createdDraw.title,
          unitsAvailable: createdDraw.unitsAvailable,
          variantCount: variants.length,
        },
      },
    });

    return createdDraw;
  });

  // Ensure raffle products are unpublished from all sales channels and save visibility snapshots
  const uniqueProductGids = Array.from(new Set(variants.map((v) => v.productGid)));
  for (const productGid of uniqueProductGids) {
    try {
      await unpublishProductFromAllChannels({
        admin,
        productGid,
        drawId: draw.id,
        shopId: shop.id,
      });
    } catch (err) {
      console.error(`Failed to unpublish product ${productGid}:`, err);
    }
  }

  // Schedule time-based draw state transitions; entry requests independently enforce both timestamps.
  await scheduleDrawLifecycle({
    drawId: draw.id,
    entryOpensAt: draw.entryOpensAt,
    entryClosesAt: draw.entryClosesAt,
    drawAt: draw.drawAt,
  });

  // Schedule self-scheduling QStash guard check
  await scheduleVisibilityGuardCheck({ delaySeconds: 1200 });

  return redirect(`/app/draws/${draw.id}`);
};

interface SelectedVariant {
  productGid: string;
  variantGid: string;
  productTitle: string;
  variantTitle: string;
  productImage?: string;
  msrpPrice: number;
  quantity: number;
}

interface AppBridgeWithPicker {
  resourcePicker: (options: {
    type: "product";
    multiple?: boolean;
  }) => Promise<
    | Array<{
        id: string;
        title: string;
        images?: Array<{ originalSrc: string }>;
        variants?: Array<{ id: string; title: string; price?: string }>;
      }>
    | undefined
  >;
}

export default function CreateDraw() {
  const submit = useSubmit();
  const navigation = useNavigation();
  const actionData = useActionData<{ errors?: Record<string, string[]> }>();
  const shopify = useAppBridge();
  const isSubmitting = navigation.state === "submitting";

  const defaultStart = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 16);
  const defaultClose = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 16);
  const defaultDraw = new Date(Date.now() + 3 * 60 * 60 * 1000 + 15 * 60 * 1000).toISOString().slice(0, 16);

  const [title, setTitle] = useState("");
  const [publicRulesText, setPublicRulesText] = useState("");
  const [entryOpensAt, setEntryOpensAt] = useState(defaultStart);
  const [entryClosesAt, setEntryClosesAt] = useState(defaultClose);
  const [drawAt, setDrawAt] = useState(defaultDraw);
  const [claimWindowValue, setClaimWindowValue] = useState("30");
  const [claimWindowUnit, setClaimWindowUnit] = useState<"minutes" | "hours">("minutes");
  const [purgeAfterDays, setPurgeAfterDays] = useState("14");

  // Eligibility rules state
  const [requireAccount, setRequireAccount] = useState(true);
  const [requireVerifiedEmail, setRequireVerifiedEmail] = useState(true);
  const [minAccountAgeDays, setMinAccountAgeDays] = useState("0");
  const [requirePhone, setRequirePhone] = useState(false);
  const [allowedCountries, setAllowedCountries] = useState<string[]>(["CA", "US"]);

  // Variants state
  const [selectedVariants, setSelectedVariants] = useState<SelectedVariant[]>([]);

  const handleSelectProduct = async () => {
    try {
      const picker = shopify as unknown as AppBridgeWithPicker;
      const selected = await picker.resourcePicker({
        type: "product",
        multiple: false,
      });

      if (selected && selected.length > 0) {
        const product = selected[0];
        const variantsList: SelectedVariant[] = (product.variants || []).map((v) => ({
          productGid: product.id,
          variantGid: v.id,
          productTitle: product.title,
          variantTitle: v.title === "Default Title" ? product.title : v.title,
          productImage: product.images?.[0]?.originalSrc,
          msrpPrice: parseFloat(v.price || "0"),
          quantity: 1,
        }));

        setSelectedVariants(variantsList);
        if (!title) {
          setTitle(`${product.title} Raffle Drop`);
        }
      }
    } catch (err) {
      console.error("Resource picker error:", err);
    }
  };

  const handleQuantityChange = (variantGid: string, newQty: string) => {
    const qty = parseInt(newQty, 10) || 1;
    setSelectedVariants((prev) =>
      prev.map((v) => (v.variantGid === variantGid ? { ...v, quantity: Math.max(1, qty) } : v))
    );
  };

  const totalUnits = selectedVariants.reduce((sum, v) => sum + v.quantity, 0);

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
      variants: selectedVariants.map((v) => ({
        productGid: v.productGid,
        variantGid: v.variantGid,
        productTitle: v.productTitle,
        variantTitle: v.variantTitle,
        msrpPrice: v.msrpPrice,
        quantity: v.quantity,
      })),
      rules: {
        requireAccount,
        requireVerifiedEmail,
        allowedCountries,
        minAccountAgeDays: parseInt(minAccountAgeDays, 10) || 0,
        requirePhone,
        variantOptions: selectedVariants.map((v) => ({
          variantGid: v.variantGid,
          title: v.variantTitle || "Default",
          price: v.msrpPrice,
          quantity: v.quantity,
        })),
      },
    };

    submit({ payload: JSON.stringify(payload) }, { method: "POST" });
  };

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const errors = actionData?.errors;

  return (
    <Page
      title="Create New Raffle Drop"
      backAction={{ content: "Draws", url: "/app" }}
      primaryAction={{
        content: "Save and Schedule Draw",
        onAction: handleSubmit,
        loading: isSubmitting,
        disabled: selectedVariants.length === 0,
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
          title="Product Selection"
          description="Choose the raffle product. Note: In Phase 4, selected products will be automatically unpublished from storefront sales channels to protect hidden inventory."
        >
          <Card>
            <BlockStack gap="400">
              {selectedVariants.length === 0 ? (
                <BlockStack gap="300" inlineAlign="start">
                  <Text as="p" tone="subdued">
                    No product selected yet. Select a product from your catalog to offer in this draw.
                  </Text>
                  <Button variant="primary" onClick={handleSelectProduct}>
                    Select Raffle Product
                  </Button>
                </BlockStack>
              ) : (
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <InlineStack gap="300" blockAlign="center">
                      <Thumbnail
                        source={
                          selectedVariants[0]?.productImage ||
                          "https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                        }
                        alt="Product preview"
                      />
                      <BlockStack gap="050">
                        <Text variant="headingSm" as="h4">
                          {selectedVariants[0]?.productTitle}
                        </Text>
                        <Text variant="bodySm" tone="subdued" as="p">
                          {selectedVariants.length} variant(s) configured • Total Units: {totalUnits}
                        </Text>
                      </BlockStack>
                    </InlineStack>
                    <Button onClick={handleSelectProduct}>Change Product</Button>
                  </InlineStack>

                  <Divider />

                  <Text variant="headingSm" as="h4">
                    Variant Quantities & MSRP Price
                  </Text>

                  {selectedVariants.map((v) => (
                    <InlineStack key={v.variantGid} align="space-between" blockAlign="center">
                      <BlockStack gap="050">
                        <Text variant="bodyMd" fontWeight="semibold" as="span">
                          {v.variantTitle}
                        </Text>
                        <Text variant="bodySm" tone="subdued" as="span">
                          MSRP: ${v.msrpPrice.toFixed(2)} (Read-only from catalog)
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
              )}
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        <Layout.AnnotatedSection
          title="Drop Details & Schedule"
          description={`Set the title, entry window, and draw time. Times are evaluated in store/local time (${timezone}).`}
        >
          <Card>
            <FormLayout>
              <TextField
                label="Draw Title"
                value={title}
                onChange={setTitle}
                autoComplete="off"
                placeholder="e.g. Travis Scott Jordan 1 Low Drop"
                error={errors?.title?.[0]}
              />

              <TextField
                label="Public Rules & Terms"
                value={publicRulesText}
                onChange={setPublicRulesText}
                multiline={3}
                autoComplete="off"
                placeholder="Enter official drop rules, minimum age, purchase conditions..."
              />

              <Divider />

              <FormLayout.Group>
                <TextField
                  label="Entry Opens At"
                  type="datetime-local"
                  value={entryOpensAt}
                  onChange={setEntryOpensAt}
                  autoComplete="off"
                  helpText={`Timezone: ${timezone}`}
                  error={errors?.entryOpensAt?.[0]}
                />
                <TextField
                  label="Entry Closes At"
                  type="datetime-local"
                  value={entryClosesAt}
                  onChange={setEntryClosesAt}
                  autoComplete="off"
                  helpText={`Timezone: ${timezone}`}
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
                  helpText="When winners and waitlist order are computed"
                  error={errors?.drawAt?.[0]}
                />
                <InlineStack gap="200" blockAlign="end">
                  <div style={{ flex: 1 }}>
                    <TextField
                      label="Winner Claim Window"
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
          title="Eligibility Rules"
          description="Enforce security and customer qualification criteria before allowing draw entry."
        >
          <Card>
            <BlockStack gap="400">
              <Checkbox
                label="Require customer account (Customer must be logged in to enter)"
                checked={requireAccount}
                onChange={setRequireAccount}
              />

              <Checkbox
                label="Require verified email address"
                checked={requireVerifiedEmail}
                onChange={setRequireVerifiedEmail}
              />

              <Checkbox
                label="Require phone number on customer account"
                checked={requirePhone}
                onChange={setRequirePhone}
              />

              <TextField
                label="Minimum account age (days)"
                type="number"
                value={minAccountAgeDays}
                onChange={setMinAccountAgeDays}
                autoComplete="off"
                helpText="Set to > 0 to block accounts created after drop announcement"
                min={0}
              />

              <Divider />

              <BlockStack gap="200">
                <Text variant="headingSm" as="h4">
                  Region Lock (Allowed Shipping Countries)
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
                    No restriction (Worldwide)
                  </Button>
                </ButtonGroup>
                <Text variant="bodySm" tone="subdued" as="p">
                  Active filter:{" "}
                  {allowedCountries.length === 0
                    ? "Worldwide (All countries permitted)"
                    : allowedCountries.join(", ")}
                </Text>
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

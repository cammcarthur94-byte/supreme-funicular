import { useState } from "react";
import {
  Card,
  BlockStack,
  Text,
  Banner,
  Box,
  Divider,
  Button,
  InlineStack,
  Badge,
  List,
} from "@shopify/polaris";

export function SetupChecklistCard() {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="300" blockAlign="center">
            <Text variant="headingMd" as="h3">
              Raffle Product Isolation & Setup Checklist
            </Text>
            <Badge tone="info">Recommended</Badge>
          </InlineStack>
          <Button
            variant="plain"
            onClick={() => setExpanded((prev) => !prev)}
          >
            {expanded ? "Collapse Guide" : "View Checklist & Test Plan"}
          </Button>
        </InlineStack>

        <Text variant="bodyMd" as="p" tone="subdued">
          Raffle products must never be purchasable or discoverable through standard storefront channels. Fairdrops automates channel unpublishing and continuous monitoring, but follow these manual security recommendations to ensure zero drop leakage.
        </Text>

        {expanded && (
          <BlockStack gap="400">
            <Divider />

            {/* Checklist Item 1 */}
            <Box>
              <BlockStack gap="200">
                <Text variant="headingSm" as="h4">
                  1. Verify Sales Channel Unpublication
                </Text>
                <Text variant="bodyMd" as="p">
                  Fairdrops automatically calls the Shopify GraphQL API to unpublish assigned drop products from all sales channels (Online Store, POS, Shop App, Google &amp; YouTube, etc.) upon drop creation.
                </Text>
                <Text variant="bodySm" tone="subdued" as="p">
                  👉 <strong>Action:</strong> Open <em>Shopify Admin &gt; Products &gt; [Product Title]</em>. In the right sidebar under <strong>Publishing</strong>, verify that 0 sales channels are selected.
                </Text>
              </BlockStack>
            </Box>

            <Divider />

            {/* Checklist Item 2 */}
            <Box>
              <BlockStack gap="200">
                <Text variant="headingSm" as="h4">
                  2. Isolate Stock in a Dedicated Location
                </Text>
                <Text variant="bodyMd" as="p">
                  Optionally create a dedicated inventory location (e.g., &quot;Raffle Vault&quot;) and transfer drop inventory there.
                </Text>
                <Banner tone="warning">
                  <Text variant="bodySm" as="p">
                    <strong>⚠️ Dev Store Testing Required:</strong> In <em>Settings &gt; Locations &gt; [Raffle Location]</em>, disabling &quot;Fulfill online orders from this location&quot; stops storefront checkout from drawing stock. However, draft order allocation behavior varies based on multi-location shipping profiles. <strong>You MUST test draft order creation from this location on your development store</strong> to confirm winners can complete checkout.
                  </Text>
                </Banner>
              </BlockStack>
            </Box>

            <Divider />

            {/* Checklist Item 3: Dev Store Blackout Test Plan */}
            <Box>
              <BlockStack gap="200">
                <Text variant="headingSm" as="h4">
                  3. Dev Store Storefront Blackout Test Plan
                </Text>
                <Text variant="bodyMd" as="p">
                  Before launching an announced drop, execute these 4 storefront checks on your development store:
                </Text>
                <List type="bullet">
                  <List.Item>
                    <strong>Direct Product URL:</strong> Navigate to <code>https://[your-store].myshopify.com/products/[handle]</code>. Expected result: <strong>404 Page Not Found</strong>.
                  </List.Item>
                  <List.Item>
                    <strong>Catalog Endpoint:</strong> Visit <code>https://[your-store].myshopify.com/products.json</code> and search for the raffle product handle/ID. Expected result: <strong>Omitted from JSON output</strong>.
                  </List.Item>
                  <List.Item>
                    <strong>Storefront Search:</strong> Search for the exact product title in your storefront search bar. Expected result: <strong>0 results returned</strong>.
                  </List.Item>
                  <List.Item>
                    <strong>Storefront API:</strong> Query the Storefront GraphQL API with <code>products(query: &quot;title:[Title]&quot;)</code>. Expected result: <strong>Empty nodes array</strong>.
                  </List.Item>
                </List>
              </BlockStack>
            </Box>
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate, useSubmit, useNavigation } from "react-router";
import {
  Page,
  Layout,
  Card,
  Badge,
  Text,
  Button,
  InlineStack,
  BlockStack,
  IndexTable,
  Banner,
  Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma, { forShop } from "../db.server";
import { assertTransition } from "../services/drawStateMachine";
import type { EligibilityRules } from "../validation/drawValidation";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const drawId = params.id as string;

  const shop = await prisma.shop.findUniqueOrThrow({
    where: { shopDomain: session.shop },
  });

  const tenant = forShop(shop.id);
  const draw = await tenant.draw.findFirst({
    where: { id: drawId },
    include: {
      variants: true,
      allocations: {
        orderBy: { rank: "asc" },
      },
      auditLogs: {
        orderBy: { createdAt: "desc" },
        take: 20,
      },
      _count: {
        select: {
          entries: true,
          allocations: true,
        },
      },
    },
  });

  if (!draw) {
    throw new Response("Draw not found", { status: 404 });
  }

  // Summary counts for allocations
  const purchasedCount = draw.allocations.filter((a) => a.status === "PURCHASED").length;
  const expiredCount = draw.allocations.filter((a) => a.status === "EXPIRED").length;
  const activeCount = draw.allocations.filter((a) => ["ISSUED", "OPENED"].includes(a.status)).length;

  return {
    draw,
    stats: {
      totalEntries: draw._count.entries,
      purchasedCount,
      expiredCount,
      activeCount,
    },
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const drawId = params.id as string;
  const formData = await request.formData();
  const intent = formData.get("intent");

  const shop = await prisma.shop.findUniqueOrThrow({
    where: { shopDomain: session.shop },
  });

  const tenant = forShop(shop.id);
  const draw = await tenant.draw.findFirst({ where: { id: drawId } });

  if (!draw) {
    return Response.json({ error: "Draw not found" }, { status: 404 });
  }

  if (intent === "cancel_draw") {
    try {
      assertTransition(draw.status, "CANCELLED");
    } catch {
      return Response.json(
        { error: `Cannot cancel draw in status '${draw.status}'` },
        { status: 400 }
      );
    }

    await tenant.draw.update({
      where: { id: draw.id },
      data: { status: "CANCELLED" },
    });

    await tenant.auditLog.create({
      drawId: draw.id,
      eventType: "DRAW_CANCELLED",
      actor: session.shop,
      metadata: { previousStatus: draw.status },
    });

    return Response.json({ success: true });
  }

  if (intent === "close_entries_early") {
    if (draw.status !== "OPEN") {
      return Response.json(
        { error: "Entries can only be closed early when the draw is OPEN" },
        { status: 400 }
      );
    }

    try {
      assertTransition("OPEN", "CLOSED");
    } catch {
      return Response.json({ error: "State transition failed" }, { status: 400 });
    }

    await tenant.draw.update({
      where: { id: draw.id },
      data: {
        status: "CLOSED",
        entryClosesAt: new Date(),
      },
    });

    await tenant.auditLog.create({
      drawId: draw.id,
      eventType: "ENTRIES_CLOSED_EARLY",
      actor: session.shop,
      metadata: { closedAt: new Date().toISOString() },
    });

    return Response.json({ success: true });
  }

  if (intent === "resend_winner_email") {
    const allocationId = String(formData.get("allocationId") || "");
    const allocation = await tenant.allocation.findFirst({
      where: { id: allocationId, drawId: draw.id },
    });

    if (!allocation) {
      return Response.json({ error: "Allocation not found" }, { status: 404 });
    }

    if (!["ISSUED", "OPENED"].includes(allocation.status)) {
      return Response.json(
        { error: `Cannot resend email for allocation in status '${allocation.status}'` },
        { status: 400 }
      );
    }

    await tenant.auditLog.create({
      drawId: draw.id,
      eventType: "WINNER_EMAIL_RESENT",
      actor: session.shop,
      metadata: { allocationId: allocation.id, rank: allocation.rank },
    });

    return Response.json({ success: true });
  }

  return Response.json({ error: "Unknown intent" }, { status: 400 });
};

function getStatusBadge(status: string) {
  switch (status) {
    case "SCHEDULED":
      return <Badge tone="info">Scheduled</Badge>;
    case "OPEN":
      return <Badge tone="success">Open</Badge>;
    case "CLOSED":
      return <Badge>Closed</Badge>;
    case "DRAWN":
      return <Badge tone="attention">Drawn</Badge>;
    case "FULFILLING":
      return <Badge tone="attention">Fulfilling</Badge>;
    case "COMPLETED":
      return <Badge tone="success">Completed</Badge>;
    case "PURGED":
      return <Badge tone="warning">Purged</Badge>;
    case "CANCELLED":
      return <Badge tone="critical">Cancelled</Badge>;
    default:
      return <Badge>{status}</Badge>;
  }
}

function getAllocationBadge(status: string) {
  switch (status) {
    case "ISSUED":
      return <Badge tone="info">Issued</Badge>;
    case "OPENED":
      return <Badge tone="attention">Opened</Badge>;
    case "PURCHASED":
      return <Badge tone="success">Purchased</Badge>;
    case "EXPIRED":
      return <Badge tone="critical">Expired</Badge>;
    case "CANCELLED":
      return <Badge>Cancelled</Badge>;
    default:
      return <Badge>{status}</Badge>;
  }
}

const LIFECYCLE_STAGES = [
  "SCHEDULED",
  "OPEN",
  "CLOSED",
  "DRAWN",
  "FULFILLING",
  "COMPLETED",
  "PURGED",
];

export default function DrawDetails() {
  const { draw, stats } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isActionRunning = navigation.state === "submitting";

  const isScheduled = draw.status === "SCHEDULED";
  const isOpen = draw.status === "OPEN";
  const canCancel = !["COMPLETED", "PURGED", "CANCELLED"].includes(draw.status);
  const rules = (draw.rules as unknown as EligibilityRules) || {};

  const handleCancel = () => {
    if (confirm("Are you sure you want to cancel this draw? This action cannot be undone.")) {
      submit({ intent: "cancel_draw" }, { method: "POST" });
    }
  };

  const handleCloseEarly = () => {
    if (confirm("Close entries immediately? Entrants will no longer be accepted.")) {
      submit({ intent: "close_entries_early" }, { method: "POST" });
    }
  };

  const handleResendEmail = (allocationId: string) => {
    submit({ intent: "resend_winner_email", allocationId }, { method: "POST" });
  };

  return (
    <Page
      title={draw.title}
      subtitle={`Created ${new Date(draw.createdAt).toLocaleDateString()}`}
      backAction={{ content: "Draws", url: "/app" }}
      titleMetadata={getStatusBadge(draw.status)}
      secondaryActions={[
        ...(isScheduled
          ? [
              {
                content: "Edit Draw",
                onAction: () => navigate(`/app/draws/${draw.id}/edit`),
              },
            ]
          : []),
        ...(isOpen
          ? [
              {
                content: "Close Entries Early",
                destructive: true,
                onAction: handleCloseEarly,
                loading: isActionRunning,
              },
            ]
          : []),
        ...(canCancel
          ? [
              {
                content: "Cancel Draw",
                destructive: true,
                onAction: handleCancel,
                loading: isActionRunning,
              },
            ]
          : []),
      ]}
    >
      <Layout>
        {draw.status === "CANCELLED" && (
          <Layout.Section>
            <Banner title="This draw was cancelled" tone="critical">
              <p>No further entries, selections, or purchases can be processed for this draw.</p>
            </Banner>
          </Layout.Section>
        )}

        {/* Status Progression Timeline */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text variant="headingSm" as="h4">
                Lifecycle Progression
              </Text>
              <InlineStack gap="200" align="space-between" blockAlign="center">
                {LIFECYCLE_STAGES.map((stage, idx) => {
                  const currentIdx = LIFECYCLE_STAGES.indexOf(draw.status);
                  const isCurrent = draw.status === stage;
                  const isPast = currentIdx > idx;

                  return (
                    <Box key={stage} padding="200">
                      <BlockStack gap="100" inlineAlign="center">
                        <Badge
                          tone={
                            isCurrent
                              ? "success"
                              : isPast
                              ? "info"
                              : undefined
                          }
                        >
                          {stage}
                        </Badge>
                      </BlockStack>
                    </Box>
                  );
                })}
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* High Level Stats */}
        <Layout.Section>
          <InlineStack gap="400" wrap={false}>
            <div style={{ flex: 1 }}>
              <Card>
                <BlockStack gap="100">
                  <Text variant="bodySm" tone="subdued" as="p">
                    Total Entrants
                  </Text>
                  <Text variant="headingLg" as="p">
                    {stats.totalEntries}
                  </Text>
                </BlockStack>
              </Card>
            </div>
            <div style={{ flex: 1 }}>
              <Card>
                <BlockStack gap="100">
                  <Text variant="bodySm" tone="subdued" as="p">
                    Units Available
                  </Text>
                  <Text variant="headingLg" as="p">
                    {draw.unitsAvailable}
                  </Text>
                </BlockStack>
              </Card>
            </div>
            <div style={{ flex: 1 }}>
              <Card>
                <BlockStack gap="100">
                  <Text variant="bodySm" tone="subdued" as="p">
                    Purchased Units
                  </Text>
                  <Text variant="headingLg" as="p">
                    {stats.purchasedCount}
                  </Text>
                </BlockStack>
              </Card>
            </div>
            <div style={{ flex: 1 }}>
              <Card>
                <BlockStack gap="100">
                  <Text variant="bodySm" tone="subdued" as="p">
                    Pending / Active
                  </Text>
                  <Text variant="headingLg" as="p">
                    {stats.activeCount}
                  </Text>
                </BlockStack>
              </Card>
            </div>
          </InlineStack>
        </Layout.Section>

        {/* Drop Details & Eligibility */}
        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text variant="headingSm" as="h4">
                  Schedule Details
                </Text>
                <BlockStack gap="100">
                  <Text variant="bodySm" as="p">
                    <strong>Opens:</strong> {new Date(draw.entryOpensAt).toLocaleString()}
                  </Text>
                  <Text variant="bodySm" as="p">
                    <strong>Closes:</strong> {new Date(draw.entryClosesAt).toLocaleString()}
                  </Text>
                  <Text variant="bodySm" as="p">
                    <strong>Draw Date:</strong> {new Date(draw.drawAt).toLocaleString()}
                  </Text>
                  <Text variant="bodySm" as="p">
                    <strong>Claim Window:</strong> {draw.claimWindowMinutes} minutes
                  </Text>
                </BlockStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text variant="headingSm" as="h4">
                  Eligibility Criteria
                </Text>
                <BlockStack gap="100">
                  <Text variant="bodySm" as="p">
                    • Account Required: {rules.requireAccount ? "Yes" : "No"}
                  </Text>
                  <Text variant="bodySm" as="p">
                    • Verified Email: {rules.requireVerifiedEmail ? "Yes" : "No"}
                  </Text>
                  <Text variant="bodySm" as="p">
                    • Min Account Age: {rules.minAccountAgeDays || 0} days
                  </Text>
                  <Text variant="bodySm" as="p">
                    • Allowed Regions:{" "}
                    {rules.allowedCountries && rules.allowedCountries.length > 0
                      ? rules.allowedCountries.join(", ")
                      : "Worldwide"}
                  </Text>
                </BlockStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text variant="headingSm" as="h4">
                  Configured Variants
                </Text>
                {draw.variants.map((v) => (
                  <InlineStack key={v.id} align="space-between">
                    <Text variant="bodySm" as="span">
                      Variant {v.variantGid.slice(-6)}: {v.quantity} units
                    </Text>
                    <Text variant="bodySm" tone="subdued" as="span">
                      ${Number(v.msrpPrice).toFixed(2)}
                    </Text>
                  </InlineStack>
                ))}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        {/* Allocations Table */}
        <Layout.Section>
          <Card padding="0">
            <Box padding="400">
              <Text variant="headingSm" as="h4">
                Winner Allocations & Waitlist
              </Text>
              <Text variant="bodySm" tone="subdued" as="p">
                Claim links are unguessable, single-use, and bound to verified winner accounts.
              </Text>
            </Box>
            {draw.allocations.length === 0 ? (
              <Box padding="400">
                <Text as="p" tone="subdued">
                  No allocations issued yet. Winners are computed when the draw runs at the
                  scheduled draw time.
                </Text>
              </Box>
            ) : (
              <IndexTable
                resourceName={{ singular: "allocation", plural: "allocations" }}
                itemCount={draw.allocations.length}
                headings={[
                  { title: "Rank" },
                  { title: "Status" },
                  { title: "Variant" },
                  { title: "Claim Deadline" },
                  { title: "Opened At" },
                  { title: "Actions" },
                ]}
                selectable={false}
              >
                {draw.allocations.map((alloc, idx) => (
                  <IndexTable.Row id={alloc.id} key={alloc.id} position={idx}>
                    <IndexTable.Cell>
                      <Text variant="bodyMd" fontWeight="bold" as="span">
                        #{alloc.rank}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{getAllocationBadge(alloc.status)}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text variant="bodySm" as="span">
                        {alloc.variantGid.slice(-6)}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text variant="bodySm" as="span">
                        {new Date(alloc.deadlineAt).toLocaleTimeString()}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text variant="bodySm" tone="subdued" as="span">
                        {alloc.openedAt ? new Date(alloc.openedAt).toLocaleTimeString() : "—"}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {["ISSUED", "OPENED"].includes(alloc.status) && (
                        <Button
                          size="slim"
                          onClick={() => handleResendEmail(alloc.id)}
                          loading={isActionRunning}
                        >
                          Re-send Email
                        </Button>
                      )}
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            )}
          </Card>
        </Layout.Section>

        {/* Audit Log Card */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text variant="headingSm" as="h4">
                Audit Trail (System & Merchant Actions)
              </Text>
              {draw.auditLogs.length === 0 ? (
                <Text as="p" tone="subdued">
                  No events logged yet.
                </Text>
              ) : (
                <BlockStack gap="200">
                  {draw.auditLogs.map((log) => (
                    <Box key={log.id} padding="200" background="bg-surface-secondary" borderRadius="200">
                      <InlineStack align="space-between">
                        <InlineStack gap="200" blockAlign="center">
                          <Badge tone="info">{log.eventType}</Badge>
                          <Text variant="bodySm" as="span">
                            by {log.actor}
                          </Text>
                        </InlineStack>
                        <Text variant="bodySm" tone="subdued" as="span">
                          {new Date(log.createdAt).toLocaleString()}
                        </Text>
                      </InlineStack>
                    </Box>
                  ))}
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

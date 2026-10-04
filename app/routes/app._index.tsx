import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate, useSubmit } from "react-router";
import {
  Page,
  Layout,
  Card,
  IndexTable,
  Badge,
  Text,
  Button,
  EmptyState,
  InlineStack,
  BlockStack,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma, { forShop } from "../db.server";
import { assertTransition } from "../services/drawStateMachine";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  let shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!shop) {
    shop = await prisma.shop.create({
      data: {
        shopDomain: session.shop,
        accessToken: session.accessToken || "",
      },
    });
  }

  const draws = await forShop(shop.id).draw.findMany({
    include: {
      variants: true,
      _count: {
        select: {
          entries: true,
          allocations: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return { draws };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const drawId = String(formData.get("drawId") || "");

  const shop = await prisma.shop.findUniqueOrThrow({
    where: { shopDomain: session.shop },
  });

  const tenant = forShop(shop.id);

  if (intent === "cancel_draw") {
    const draw = await tenant.draw.findUnique({ where: { id: drawId } });
    if (!draw) {
      return Response.json({ error: "Draw not found" }, { status: 404 });
    }

    try {
      assertTransition(draw.status, "CANCELLED");
    } catch {
      return Response.json(
        { error: `Cannot cancel draw currently in status '${draw.status}'` },
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
      metadata: { previousStatus: draw.status, reason: "Merchant cancelled from admin list" },
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

export default function DrawsIndex() {
  const { draws } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const submit = useSubmit();

  const handleCancel = (drawId: string, title: string) => {
    if (confirm(`Are you sure you want to cancel the draw "${title}"?`)) {
      submit({ intent: "cancel_draw", drawId }, { method: "POST" });
    }
  };

  const resourceName = {
    singular: "draw",
    plural: "draws",
  };

  return (
    <Page
      title="Raffle & Draw Drops"
      subtitle="Manage high-demand product drops, hidden inventory allocations, and fair selection draws."
      primaryAction={{
        content: "Create Draw",
        onAction: () => navigate("/app/draws/new"),
      }}
    >
      <Layout>
        <Layout.Section>
          {draws.length === 0 ? (
            <Card>
              <EmptyState
                heading="Launch your first high-demand drop"
                action={{
                  content: "Create Draw",
                  onAction: () => navigate("/app/draws/new"),
                }}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>
                  Create time-limited, bot-protected product draws. Products remain completely
                  hidden from your public storefront until winners claim their private orders.
                </p>
              </EmptyState>
            </Card>
          ) : (
            <Card padding="0">
              <IndexTable
                resourceName={resourceName}
                itemCount={draws.length}
                headings={[
                  { title: "Title" },
                  { title: "Status" },
                  { title: "Entry Window" },
                  { title: "Draw Time" },
                  { title: "Units" },
                  { title: "Entries" },
                  { title: "Actions" },
                ]}
                selectable={false}
              >
                {draws.map((draw, index) => {
                  const opensAt = new Date(draw.entryOpensAt).toLocaleString();
                  const closesAt = new Date(draw.entryClosesAt).toLocaleString();
                  const drawAt = new Date(draw.drawAt).toLocaleString();
                  const isScheduled = draw.status === "SCHEDULED";
                  const canCancel = !["COMPLETED", "PURGED", "CANCELLED"].includes(draw.status);

                  return (
                    <IndexTable.Row id={draw.id} key={draw.id} position={index}>
                      <IndexTable.Cell>
                        <Text variant="bodyMd" fontWeight="bold" as="span">
                          {draw.title}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>{getStatusBadge(draw.status)}</IndexTable.Cell>
                      <IndexTable.Cell>
                        <BlockStack gap="050">
                          <Text variant="bodySm" tone="subdued" as="p">
                            Open: {opensAt}
                          </Text>
                          <Text variant="bodySm" tone="subdued" as="p">
                            Close: {closesAt}
                          </Text>
                        </BlockStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text variant="bodySm" as="span">
                          {drawAt}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text variant="bodyMd" as="span">
                          {draw.unitsAvailable}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text variant="bodyMd" as="span">
                          {draw._count.entries}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <InlineStack gap="200">
                          <Button
                            size="slim"
                            onClick={() => navigate(`/app/draws/${draw.id}`)}
                          >
                            Details
                          </Button>
                          {isScheduled && (
                            <Button
                              size="slim"
                              onClick={() => navigate(`/app/draws/${draw.id}/edit`)}
                            >
                              Edit
                            </Button>
                          )}
                          {canCancel && (
                            <Button
                              size="slim"
                              tone="critical"
                              onClick={() => handleCancel(draw.id, draw.title)}
                            >
                              Cancel
                            </Button>
                          )}
                        </InlineStack>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  );
                })}
              </IndexTable>
            </Card>
          )}
        </Layout.Section>
      </Layout>
    </Page>
  );
}

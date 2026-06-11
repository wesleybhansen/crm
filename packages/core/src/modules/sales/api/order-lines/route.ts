import { SalesOrderLine } from "../../data/entities";
import { orderLineCreateSchema } from "../../data/validators";
import { E } from "#generated/entities.ids.generated";
import * as F from "#generated/entities/sales_order_line";
import { makeSalesLineRoute } from "../../lib/makeSalesLineRoute";

const route = makeSalesLineRoute({
  entity: SalesOrderLine,
  entityId: E.sales.sales_order_line,
  fieldConstants: F,
  parentFkColumn: "order_id",
  parentFkParam: "orderId",
  createSchema: orderLineCreateSchema,
  features: { view: "sales.orders.view", manage: "sales.orders.manage" },
  commandPrefix: "sales.orders.lines",
  openApi: {
    resourceName: "Order line",
    description: "an order line and recalculates totals",
  },
});

export const { GET, POST, PUT, DELETE } = route;
// Without this export the dispatcher never sees the factory's per-method
// requireAuth/requireFeatures (sales.orders.view/manage) — handlers only
// self-enforce 401 + org scope, not features.
export const metadata = route.metadata;
export const openApi = route.openApi;

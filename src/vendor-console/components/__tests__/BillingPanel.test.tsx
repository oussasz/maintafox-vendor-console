import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const permissions = vi.hoisted(() => ({ granted: new Set<string>(["customer.manage", "billing.price_manage"]) }));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ can: (p: string) => permissions.granted.has(p) }),
}));

vi.mock("@/services/license-control-service", () => ({
  PRIVILEGED_REASON_MIN_LENGTH: 4,
  listTenants: vi.fn(async () => [{ id: "tenant_1", slug: "acme", display_name: "Acme" }]),
}));

vi.mock("@/services/billing-service", () => ({
  getSubscription: vi.fn(),
  getBillingStatus: vi.fn(),
  listPrices: vi.fn(),
  listPayments: vi.fn(),
  setPrice: vi.fn(),
  reconcilePayment: vi.fn(),
  createPaymentLink: vi.fn(),
}));

import {
  createPaymentLink,
  getBillingStatus,
  getSubscription,
  listPayments,
  listPrices,
  reconcilePayment,
  setPrice,
  type BillingStatus,
  type PaymentOrder,
  type Price,
  type Subscription,
} from "@/services/billing-service";
import { BillingPanel } from "../BillingPanel";

const awaiting: PaymentOrder = {
  id: "order_1",
  tenant_id: "tenant_1",
  license_id: "lic_1",
  plan: "core",
  amount: 120000,
  extra_slots: 2,
  total_amount: 160000,
  currency: "DZD",
  status: "awaiting_payment",
  slickpay_invoice_id: "1001",
  paid_at: null,
  error_message: null,
  created_at: "2026-10-12T10:00:00Z",
  updated_at: "2026-10-12T10:00:00Z",
  last_reconciled_at: null,
  last_reconciled_status: null,
  slickpay_paid_amount: null,
  slickpay_transaction_ref: null,
  last_check_error: null,
  licence_delivery: null,
  buyer_company: "Acme",
};

const corePrice: Price = {
  plan: "core",
  base_amount: 120000,
  included_seats: 1,
  extra_seat_amount: 20000,
  max_extra_seats: 500,
  term_months: 12,
  currency: "DZD",
  is_active: true,
  updated_at: "2026-10-12T09:00:00Z",
  updated_by: "user_1",
};

const enabledStatus: BillingStatus = {
  slickpay: {
    mode: "enabled",
    webhook_url: "https://api.example.test/api/v1/webhooks/slickpay",
    return_url: "https://www.example.test/checkout/result",
    reconcile_interval_minutes: 5,
    order_expiry_hours: 72,
    ignored_settings: [],
  },
  email_delivery: "smtp",
  reconciler: { at_rfc3339: "2026-10-12T10:05:00Z", ok: true, detail: {} },
  orders_by_status: { awaiting_payment: 1 },
};

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    tenant_id: "tenant_1",
    edition: "core",
    licences: [
      {
        id: "lic_1",
        max_machines: 1,
        active_machines: 1,
        expires_at: "2026-10-30T00:00:00Z",
        days_left: 17,
        revoked_at: null,
        update_channel: "stable",
      },
    ],
    payments: [awaiting],
    slickpay_configured: true,
    prices: [corePrice],
    ...overrides,
  };
}

function renderPanel(props: { fixedTenantId?: string } = {}) {
  return render(
    <MemoryRouter>
      <BillingPanel {...props} />
    </MemoryRouter>,
  );
}

describe("BillingPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissions.granted = new Set(["customer.manage", "billing.price_manage"]);
    vi.mocked(getBillingStatus).mockResolvedValue(enabledStatus);
    vi.mocked(listPrices).mockResolvedValue([corePrice]);
    vi.mocked(listPayments).mockResolvedValue([]);
  });

  it("shows the licence term, slots and the payment status exactly as recorded", async () => {
    vi.mocked(getSubscription).mockResolvedValue(subscription());
    renderPanel();
    expect(await screen.findByText("billing.licence.daysLeft")).toHaveClass("text-attention-text");
    expect(screen.getByText("billing.licence.slots")).toBeInTheDocument();
    const row = screen.getByTestId("payment-order_1");
    expect(within(row).getByText("billing.status.awaiting_payment")).toBeInTheDocument();
    expect(within(row).getByText("160000 DZD")).toBeInTheDocument();
    expect(screen.getByText("billing.openOrders")).toBeInTheDocument();
  });

  it("lists the payments that need a person, with the reason, across customers", async () => {
    vi.mocked(getSubscription).mockResolvedValue(subscription());
    vi.mocked(listPayments).mockResolvedValue([
      { ...awaiting, id: "order_9", tenant_id: null, status: "needs_review", error_message: "amount_mismatch", buyer_company: "New Co" },
    ]);
    renderPanel();
    const row = await screen.findByTestId("review-order_9");
    expect(within(row).getByText("New Co")).toBeInTheDocument();
    expect(within(row).getByText("billing.reason.amount_mismatch")).toBeInTheDocument();
    expect(listPayments).toHaveBeenCalledWith({ status: "needs_review" });
  });

  it("warns when licence keys are not e-mailed and when old settings are still in the .env", async () => {
    vi.mocked(getSubscription).mockResolvedValue(
      subscription({ payments: [{ ...awaiting, status: "paid", paid_at: "2026-10-12T11:00:00Z", licence_delivery: "disabled" }] }),
    );
    vi.mocked(getBillingStatus).mockResolvedValue({
      ...enabledStatus,
      email_delivery: "disabled",
      slickpay: { ...enabledStatus.slickpay, ignored_settings: ["SLICKPAY_SECRET_KEY"] },
    });
    renderPanel();
    expect(await screen.findByText("billing.emailOff")).toBeInTheDocument();
    expect(screen.getByText("billing.ignoredSettings")).toBeInTheDocument();
    expect(within(screen.getByTestId("payment-order_1")).getByText("billing.delivery.disabled")).toBeInTheDocument();
  });

  it("checks with SlickPay (reason required) and reloads the server's answer", async () => {
    vi.mocked(getSubscription)
      .mockResolvedValueOnce(subscription())
      .mockResolvedValueOnce(subscription({ payments: [{ ...awaiting, status: "paid", paid_at: "2026-10-12T11:00:00Z" }] }));
    vi.mocked(reconcilePayment).mockResolvedValue({
      payment_order_id: "order_1",
      stored_status: "awaiting_payment",
      slickpay_status: "paid",
      applied: true,
      outcome: "applied",
      order: { ...awaiting, status: "paid" },
    });
    renderPanel();
    const row = await screen.findByTestId("payment-order_1");
    await userEvent.click(within(row).getByRole("button", { name: "billing.reconcile.button" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("operatorAction.reasonLabel"), "customer called");
    await userEvent.click(within(dialog).getByRole("button", { name: "billing.reconcile.confirm" }));
    await waitFor(() => expect(reconcilePayment).toHaveBeenCalledWith("order_1", "customer called"));
    expect(await screen.findByText("billing.reconcile.outcome.applied")).toBeInTheDocument();
    expect(await screen.findByText("billing.status.paid")).toBeInTheDocument();
  });

  it("without SlickPay configured, says so and offers no SlickPay action", async () => {
    vi.mocked(getSubscription).mockResolvedValue(subscription({ slickpay_configured: false }));
    vi.mocked(getBillingStatus).mockResolvedValue({ ...enabledStatus, slickpay: { mode: "disabled", ignored_settings: [] } });
    renderPanel();
    expect(await screen.findByText("billing.slickpayOff")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "billing.link.button" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "billing.reconcile.button" })).not.toBeInTheDocument();
  });

  it("creates a payment link priced by the server (plan, seats, contact; no amount) and shows it", async () => {
    vi.mocked(getSubscription).mockResolvedValue(subscription());
    vi.mocked(createPaymentLink).mockResolvedValue({
      checkout_url: "https://pay.example.test/invoice/1002",
      payment_order_id: "order_2",
      total_amount: 140000,
      currency: "DZD",
    });
    renderPanel();
    await userEvent.click(await screen.findByRole("button", { name: "billing.link.button" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByLabelText("operatorAction.reasonLabel")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("billing.link.amount")).not.toBeInTheDocument();
    await userEvent.clear(within(dialog).getByLabelText("billing.link.extraSlots"));
    await userEvent.type(within(dialog).getByLabelText("billing.link.extraSlots"), "1");
    await userEvent.type(within(dialog).getByLabelText("billing.link.firstname"), "Amina");
    await userEvent.type(within(dialog).getByLabelText("billing.link.lastname"), "Test");
    await userEvent.type(within(dialog).getByLabelText("billing.link.email"), "amina@example.test");
    await userEvent.type(within(dialog).getByLabelText("billing.link.phone"), "+213555000000");
    expect(within(dialog).getByTestId("link-total")).toHaveTextContent("billing.link.total");
    await userEvent.click(within(dialog).getByRole("button", { name: "billing.link.confirm" }));
    await waitFor(() =>
      expect(createPaymentLink).toHaveBeenCalledWith({
        tenant_id: "tenant_1",
        plan: "core",
        extra_slots: 1,
        buyer: { firstname: "Amina", lastname: "Test", email: "amina@example.test", phone: "+213555000000" },
      }),
    );
    expect(await screen.findByTestId("checkout-url")).toHaveTextContent("https://pay.example.test/invoice/1002");
  });

  it("lets the owner set a plan's price with a reason", async () => {
    vi.mocked(getSubscription).mockResolvedValue(subscription());
    vi.mocked(setPrice).mockResolvedValue({ ...corePrice, base_amount: 130000 });
    renderPanel();
    const row = await screen.findByTestId("price-core");
    await userEvent.click(within(row).getByRole("button", { name: "billing.prices.edit" }));
    const dialog = await screen.findByRole("dialog");
    const base = within(dialog).getByLabelText("billing.prices.base");
    await userEvent.clear(base);
    await userEvent.type(base, "130000");
    await userEvent.type(within(dialog).getByLabelText("operatorAction.reasonLabel"), "2027 prices");
    await userEvent.click(within(dialog).getByRole("button", { name: "billing.prices.save" }));
    await waitFor(() =>
      expect(setPrice).toHaveBeenCalledWith(
        "core",
        { base_amount: 130000, included_seats: 1, extra_seat_amount: 20000, max_extra_seats: 500, term_months: 12, is_active: true },
        "2027 prices",
      ),
    );
  });

  it("does not offer price changes without the permission, nor the price list inside a customer page", async () => {
    permissions.granted = new Set(["customer.manage"]);
    vi.mocked(getSubscription).mockResolvedValue(subscription());
    const { unmount } = renderPanel();
    const row = await screen.findByTestId("price-core");
    expect(within(row).queryByRole("button", { name: "billing.prices.edit" })).not.toBeInTheDocument();
    unmount();
    renderPanel({ fixedTenantId: "tenant_1" });
    await screen.findByTestId("payment-order_1");
    expect(screen.queryByTestId("price-list")).not.toBeInTheDocument();
    expect(getBillingStatus).toHaveBeenCalledTimes(1);
  });
});
